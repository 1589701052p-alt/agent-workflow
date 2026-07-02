// P0 fortification (hotspot audit, clarify cluster) — cross-clarify dual-write
// consistency oracle.
//
// WHY THIS FILE EXISTS (regression intent):
//   Like self-clarify, the cross-clarify write path dual-writes the legacy
//   `cross_clarify_sessions` row AND a `clarify_rounds` (kind='cross') mirror
//   keyed on the SAME id — at create (createCrossClarifySession) and at answer
//   time (RFC-132: sealRoundQuestions mirrors answers/scopes/directive/status/
//   answeredAt onto the legacy table on full seal). The deferred T17 migration
//   that drops the legacy table never shipped, so the two stores must stay in
//   lockstep across both mutation sites.
//
//   Every existing cross-clarify test reads only ONE table, so a write that
//   updates one store but not its mirror passes the whole suite today. These
//   tests are the missing net for the planned RFC-058/064 store-collapse:
//
//   Consistency oracle — after create AND after the unified answer (continue →
//   designer dispatched), the cross_clarify_sessions row and its clarify_rounds
//   mirror must agree on every shared column. Goes red the instant a refactor
//   desyncs them.
//
//   (The former "write-ordering guard" describe grepped the retired legacy
//   submit body's internals and was deleted with RFC-132 — the unified path has
//   a single seal tx; the rerun mint happens strictly after it in
//   autoDispatchClarifyRound → dispatchTaskQuestions.)

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

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
    // Hermetic fixture — empty worktree path; no git runs.
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

  test('answer (continue → designer dispatched): answered state mirrors to clarify_rounds with zero drift', async () => {
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

    const res = await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      actor,
    })
    // Confirm we exercised the designer continuation. RFC-132: the unified path does
    // NOT stamp designer_run_triggered_at (legacy bookkeeping) — the consumed marker
    // is dispatched_at on the round's designer entries.
    expect(res.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    const designerEntries = (
      await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.originNodeRunId, sess.crossClarifyNodeRunId))
    ).filter((e) => e.roleKind === 'designer')
    expect(designerEntries.length).toBeGreaterThan(0)
    for (const e of designerEntries) expect(e.dispatchedAt).not.toBeNull()

    const { session, round } = await fetchPair(db, sess.session.id)
    expect(session!.status).toBe('answered')
    expect(session!.directive).toBe('continue')
    expect(session!.answersJson).not.toBeNull()
    expect(session!.answeredAt).not.toBeNull()
    // designerRunTriggeredAt stays NULL on BOTH stores under the unified path — the
    // mirror parity below still covers the column pair.
    expect(session!.designerRunTriggeredAt).toBeNull()
    // The crux: zero drift across the full shared-column set, after both mirror
    // sites (create + answer full seal) have fired.
    expect(mismatches(session!, round!)).toEqual({})
  })
})

// (The former source-text "write-ordering guard" describe was deleted with RFC-132: it
// grepped the retired legacy submit body's internals. The unified path's ordering is a
// single seal tx (sealRoundQuestions) followed by the dispatch mint — locked behaviorally
// by rfc128-p5-d-autodispatch.test.ts.)
