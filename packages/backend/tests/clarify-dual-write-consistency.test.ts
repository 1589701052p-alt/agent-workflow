// P0 fortification (hotspot audit, clarify cluster) — dual-write consistency.
//
// WHY THIS FILE EXISTS (regression intent):
//   RFC-058/064's "unification" stopped at a stage-1 dual-write: the live
//   clarify write paths update BOTH the legacy `clarify_sessions` row AND the
//   `clarify_rounds` row keyed on the SAME id (createClarifySession at create;
//   the unified answer path autoDispatchClarifyRound → sealRoundQuestions at
//   answer time, RFC-132). The deferred T17 migration that drops the legacy
//   table never shipped, so the two stores must stay in lockstep on every
//   write.
//
//   The audit found this is the single highest-risk SILENT-breakage surface for
//   the planned store-collapse refactor: EVERY existing clarify test reads only
//   ONE of the two tables, so a write that updates `clarify_sessions` but not
//   its `clarify_rounds` mirror (or vice-versa) passes the entire suite today.
//   This oracle is the missing net — it asserts the overlapping columns agree
//   after createClarifySession AND after the unified answer path, so any future
//   change that desyncs the mirror (or collapses to one table incorrectly) goes
//   red here instead of surfacing as a runtime frontier/freshness bug.
//
//   DELIBERATE ASYMMETRY (RFC-132): `answeredBy` is written to clarify_rounds
//   ONLY (clarifySeal.ts stamps it on the round; the legacy mirror set omits
//   it). That is safe because every read DTO (getClarifyRoundDetail /
//   listClarifyRoundSummaries) reads clarify_rounds — the legacy column has no
//   live reader. The column pair is therefore asserted explicitly (round
//   stamped, legacy NULL) instead of via the parity oracle; if the legacy
//   column ever grows a reader again, restore it to SELF_MIRROR and write it
//   in the seal.
//
//   Scope: self-clarify (kind='self'). The cross-clarify equivalent lives in
//   cross-clarify-dual-write-consistency.test.ts.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession } from '../src/services/clarify'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
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

function selfClarifyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'agent_x', kind: 'agent-single', agentName: 'agent_x' },
      { id: 'clarify_x', kind: 'clarify' },
    ],
    edges: [
      {
        id: 'e_in_x',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'agent_x', portName: 'requirement' },
      },
      {
        id: 'e_x_clarify',
        source: { nodeId: 'agent_x', portName: '__clarify__' },
        target: { nodeId: 'clarify_x', portName: 'questions' },
      },
      {
        id: 'e_clarify_x',
        source: { nodeId: 'clarify_x', portName: 'answers' },
        target: { nodeId: 'agent_x', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'fixture',
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
    repoPath: '/tmp/aw-clarify-dualwrite',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

// The legacy clarify_sessions columns and their clarify_rounds (kind='self')
// mirror columns. Asserting this full set agrees catches a desync on ANY field,
// not just the few the submit handler currently touches. If a NEW shared column
// is added to clarify_sessions, add its mirror here so the oracle keeps pace.
//   [sessionColumn, roundColumn]
const SELF_MIRROR: ReadonlyArray<
  readonly [keyof typeof clarifySessions.$inferSelect, keyof typeof clarifyRounds.$inferSelect]
> = [
  ['id', 'id'],
  ['taskId', 'taskId'],
  ['status', 'status'],
  ['questionsJson', 'questionsJson'],
  ['answersJson', 'answersJson'],
  ['directive', 'directive'],
  ['answeredAt', 'answeredAt'],
  // ['answeredBy', 'answeredBy'] — deliberately OUT of the parity oracle: the
  // unified seal stamps it on clarify_rounds only (see the header note); the
  // pair is asserted explicitly in the answer test below.
  ['truncationWarningsJson', 'truncationWarningsJson'],
  ['createdAt', 'createdAt'],
  ['iterationIndex', 'iteration'],
  ['sourceAgentNodeId', 'askingNodeId'],
  ['sourceAgentNodeRunId', 'askingNodeRunId'],
  ['sourceShardKey', 'askingShardKey'],
  ['clarifyNodeId', 'intermediaryNodeId'],
  ['clarifyNodeRunId', 'intermediaryNodeRunId'],
  ['consumedByConsumerRunId', 'consumedByConsumerRunId'],
]

function mismatches(
  sessionRow: typeof clarifySessions.$inferSelect,
  roundRow: typeof clarifyRounds.$inferSelect,
): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {}
  for (const [s, r] of SELF_MIRROR) {
    const sv = sessionRow[s]
    const rv = roundRow[r]
    if (sv !== rv) out[`${String(s)}↔${String(r)}`] = [sv, rv]
  }
  return out
}

async function fetchPair(db: DbClient, id: string) {
  const session = (await db.select().from(clarifySessions).where(eq(clarifySessions.id, id)))[0]
  const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, id)))[0]
  return { session, round }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('clarify self dual-write consistency (clarify_sessions ↔ clarify_rounds)', () => {
  test('createClarifySession: legacy row and clarify_rounds mirror agree on every shared column', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, selfClarifyDef())

    const agentRunId = `nr_agent_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(nodeRuns).values({
      id: agentRunId,
      taskId,
      nodeId: 'agent_x',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      preSnapshot: 'snap-x',
    })

    const sess = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'agent_x',
      sourceAgentNodeRunId: agentRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify_x',
      iterationIndex: 0,
      questions: [makeQ('q1'), makeQ('q2')],
      truncationWarnings: [{ code: 'options-capped', detail: 'demo' }],
    })

    const { session, round } = await fetchPair(db, sess.session.id)
    expect(session).toBeDefined()
    expect(round).toBeDefined()
    // kind discriminator is correct for a self-clarify round.
    expect(round!.kind).toBe('self')
    // At create time both are awaiting_human with null answers.
    expect(session!.status).toBe('awaiting_human')
    expect(session!.answersJson).toBeNull()
    // The crux: zero mismatches across the full shared-column set.
    expect(mismatches(session!, round!)).toEqual({})
  })

  test('unified answer path: answered state (status/answers/directive/answeredAt) mirrors to the legacy row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, selfClarifyDef())

    const agentRunId = `nr_agent_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(nodeRuns).values({
      id: agentRunId,
      taskId,
      nodeId: 'agent_x',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      preSnapshot: 'snap-x',
    })

    const sess = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'agent_x',
      sourceAgentNodeRunId: agentRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify_x',
      iterationIndex: 0,
      questions: [makeQ('q1')],
      truncationWarnings: [],
    })

    await autoDispatchClarifyRound({
      db,
      originNodeRunId: sess.clarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
      actor: { userId: 'u1', role: 'owner' },
    })

    const { session, round } = await fetchPair(db, sess.session.id)
    // Legacy row reflects the answered state...
    expect(session!.status).toBe('answered')
    expect(session!.directive).toBe('stop')
    expect(session!.answersJson).not.toBeNull()
    expect(session!.answeredAt).not.toBeNull()
    // ...and the mirror agrees on it AND every other shared column (no drift).
    expect(mismatches(session!, round!)).toEqual({})
    // Deliberate answeredBy asymmetry (header note): the unified seal stamps
    // the read-path store (clarify_rounds) with the actor; the legacy mirror
    // column stays NULL (no live reader). If either side flips, the T17
    // store-collapse plan must be revisited before "fixing" this.
    expect(round!.answeredBy).toBe('u1')
    expect(session!.answeredBy).toBeNull()
  })
})
