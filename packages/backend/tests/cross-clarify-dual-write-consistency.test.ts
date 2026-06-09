// P0 fortification (hotspot audit, clarify cluster) — cross-clarify dual-write
// consistency + the DELIBERATE-asymmetry ordering guard.
//
// WHY THIS FILE EXISTS (regression intent):
//   Like self-clarify, crossClarify.ts dual-writes the legacy
//   `cross_clarify_sessions` row AND a `clarify_rounds` (kind='cross') mirror
//   keyed on the SAME id — at create (crossClarify.ts:243), at submit
//   (crossClarify.ts:436), and again when the designer rerun is triggered, which
//   stamps `designer_run_triggered_at` on BOTH tables (crossClarify.ts:584). The
//   deferred T17 migration that drops the legacy table never shipped, so the two
//   stores must stay in lockstep across all three mutation sites.
//
//   Every existing cross-clarify test reads only ONE table, so a write that
//   updates one store but not its mirror passes the whole suite today. These two
//   tests are the missing net for the planned RFC-058/064 store-collapse:
//
//   1. Consistency oracle — after create AND after submit (continue →
//      designer-rerun-triggered, which exercises ALL three mirror sites), the
//      cross_clarify_sessions row and its clarify_rounds mirror must agree on
//      every shared column. Goes red the instant a refactor desyncs them.
//
//   2. Ordering guard — UNLIKE submitClarifyAnswers (which mints the rerun
//      BEFORE flipping the session → answered to avoid a torn "answered ∧ rerun
//      absent" frontier read), submitCrossClarifyAnswers DELIBERATELY flips
//      → answered FIRST, because the multi-source peer-aggregation readiness
//      check requires this session to read as resolved before the reruns fire
//      (crossClarify.ts:408-421). That asymmetry is load-bearing and is exactly
//      what a naive "unify both submit paths into one sealClarifyRound" refactor
//      could break by imposing self-clarify's rerun-first order. This guard locks
//      the cross-clarify order (answered-flip BEFORE rerun triggers) + the
//      rationale comment, so such a regression goes red here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}
function makeAns(qid: string): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

function fixtureDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = fixtureDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'cross-dualwrite',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-cross-dualwrite',
    // worktreePath '' keeps triggerDesignerRerun's git ops a no-op (hermetic).
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 10)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...fields,
  })
  return id
}

// cross_clarify_sessions column ↔ clarify_rounds (kind='cross') mirror column.
// (cross_clarify_sessions has no answered_by / truncation_warnings_json columns,
// so those clarify_rounds-only fields are intentionally not pairs.)
const CROSS_MIRROR: ReadonlyArray<
  readonly [keyof typeof crossClarifySessions.$inferSelect, keyof typeof clarifyRounds.$inferSelect]
> = [
  ['id', 'id'],
  ['taskId', 'taskId'],
  ['status', 'status'],
  ['questionsJson', 'questionsJson'],
  ['answersJson', 'answersJson'],
  ['directive', 'directive'],
  ['answeredAt', 'answeredAt'],
  ['abandonedAt', 'abandonedAt'],
  ['designerRunTriggeredAt', 'designerRunTriggeredAt'],
  ['createdAt', 'createdAt'],
  ['iteration', 'iteration'],
  ['loopIter', 'loopIter'],
  ['crossClarifyNodeId', 'intermediaryNodeId'],
  ['crossClarifyNodeRunId', 'intermediaryNodeRunId'],
  ['sourceQuestionerNodeId', 'askingNodeId'],
  ['sourceQuestionerNodeRunId', 'askingNodeRunId'],
  ['targetDesignerNodeId', 'targetConsumerNodeId'],
  ['questionScopesJson', 'questionScopesJson'],
  ['consumedByConsumerRunId', 'consumedByConsumerRunId'],
  ['consumedByQuestionerRunId', 'consumedByQuestionerRunId'],
]

function mismatches(
  sessionRow: typeof crossClarifySessions.$inferSelect,
  roundRow: typeof clarifyRounds.$inferSelect,
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {}
  for (const [s, r] of CROSS_MIRROR) {
    const sv = sessionRow[s]
    const rv = roundRow[r]
    if (sv !== rv) out[`${String(s)}↔${String(r)}`] = [sv, rv]
  }
  return out
}

async function fetchPair(db: DbClient, id: string) {
  const session = (
    await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, id))
  )[0]
  const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, id)))[0]
  return { session, round }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('cross-clarify dual-write consistency (cross_clarify_sessions ↔ clarify_rounds)', () => {
  test('createCrossClarifySession: legacy row and clarify_rounds mirror agree on every shared column', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', { retryIndex: 0, preSnapshot: 'snap-d' })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 0 })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1'), makeQ('q2')],
    })

    const { session, round } = await fetchPair(db, sess.session.id)
    expect(session).toBeDefined()
    expect(round).toBeDefined()
    expect(round!.kind).toBe('cross')
    expect(session!.status).toBe('awaiting_human')
    expect(session!.answersJson).toBeNull()
    expect(mismatches(session!, round!)).toEqual({})
  })

  test('submit (continue → designer-rerun-triggered): answered state + designer_run_triggered_at mirror to clarify_rounds', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'in', {})
    await seedRun(db, taskId, 'designer', { retryIndex: 0, preSnapshot: 'snap-d' })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 0 })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })

    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    // Confirm we exercised the path that stamps designer_run_triggered_at on
    // both stores (the third mirror site), not just the submit update.
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')

    const { session, round } = await fetchPair(db, sess.session.id)
    expect(session!.status).toBe('answered')
    expect(session!.directive).toBe('continue')
    expect(session!.answersJson).not.toBeNull()
    expect(session!.answeredAt).not.toBeNull()
    expect(session!.designerRunTriggeredAt).not.toBeNull()
    // The crux: zero drift across the full shared-column set, after all three
    // mirror sites (create + submit-answered + designer-rerun stamp) have fired.
    expect(mismatches(session!, round!)).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Source-text ordering guard — locks the DELIBERATE cross-vs-self asymmetry.
// ---------------------------------------------------------------------------
describe('cross-clarify submit write-ordering (deliberate non-deferral)', () => {
  // Slice out just the submitCrossClarifyAnswers body so index comparisons
  // aren't confused by `status: 'answered'` in other functions (e.g.
  // cleanupCrossClarifySessionsForTask).
  function submitBody(): string {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts'),
      'utf8',
    )
    const start = src.indexOf('export async function submitCrossClarifyAnswers')
    expect(start).toBeGreaterThan(0)
    const after = src.indexOf('\nexport async function ', start + 1)
    return src.slice(start, after === -1 ? undefined : after)
  }

  test('the session → answered flip precedes the rerun triggers (inverse of self-clarify)', () => {
    const body = submitBody()
    // The cross_clarify_sessions update flips status → answered.
    const answeredFlipIdx = body.indexOf("status: 'answered'")
    // The rerun is minted only AFTER the flip (deliberate, for peer aggregation).
    const triggerIdxs = [
      body.indexOf('triggerQuestionerStopRerun('),
      body.indexOf('triggerQuestionerContinueRerun('),
      body.indexOf('triggerDesignerRerun('),
    ].filter((i) => i > 0)
    expect(answeredFlipIdx).toBeGreaterThan(0)
    expect(triggerIdxs.length).toBeGreaterThan(0)
    for (const t of triggerIdxs) {
      expect(answeredFlipIdx).toBeLessThan(t)
    }
  })

  test('the clarify_rounds mirror update is co-located with the legacy update (both before any rerun)', () => {
    const body = submitBody()
    const legacyUpdateIdx = body.indexOf('.update(crossClarifySessions)')
    const mirrorUpdateIdx = body.indexOf('.update(clarifyRounds)')
    const firstTrigger = Math.min(
      ...[
        body.indexOf('triggerQuestionerStopRerun('),
        body.indexOf('triggerQuestionerContinueRerun('),
        body.indexOf('triggerDesignerRerun('),
      ].filter((i) => i > 0),
    )
    expect(legacyUpdateIdx).toBeGreaterThan(0)
    expect(mirrorUpdateIdx).toBeGreaterThan(legacyUpdateIdx)
    // The mirror must not drift below a rerun trigger — keep the dual-write atomic.
    expect(mirrorUpdateIdx).toBeLessThan(firstTrigger)
  })

  test('the deliberate non-deferral rationale comment is retained (forces re-justification on reorder)', () => {
    const body = submitBody()
    // Anchor on a stable phrase from the crossClarify.ts:408-421 rationale.
    expect(body).toContain('CANNOT be deferred')
  })
})
