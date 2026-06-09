// P0 fortification (hotspot audit, clarify cluster) — dual-write consistency.
//
// WHY THIS FILE EXISTS (regression intent):
//   RFC-058/064's "unification" stopped at a stage-1 dual-write: clarify.ts
//   writes BOTH the legacy `clarify_sessions` row (still authoritative for
//   reads) AND a mirror `clarify_rounds` row keyed on the SAME id
//   (clarify.ts:213 create + clarify.ts:481 submit). The deferred T17 migration
//   that drops the legacy table never shipped, so the two stores must stay in
//   lockstep on every write.
//
//   The audit found this is the single highest-risk SILENT-breakage surface for
//   the planned store-collapse refactor: EVERY existing clarify test reads only
//   ONE of the two tables, so a write that updates `clarify_sessions` but not
//   its `clarify_rounds` mirror (or vice-versa) passes the entire suite today.
//   This oracle is the missing net — it asserts the overlapping columns agree
//   after createClarifySession AND after submitClarifyAnswers, so any future
//   change that desyncs the mirror (or collapses to one table incorrectly) goes
//   red here instead of surfacing as a runtime frontier/freshness bug.
//
//   Scope: self-clarify (kind='self'). The cross-clarify equivalent lives in
//   cross-clarify-dual-write-consistency.test.ts.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, clarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifySession, submitClarifyAnswers } from '../src/services/clarify'
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
  ['answeredBy', 'answeredBy'],
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

  test('submitClarifyAnswers: answered state (status/answers/directive/answeredAt/By) mirrors to clarify_rounds', async () => {
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

    await submitClarifyAnswers({
      db,
      clarifyNodeRunId: sess.clarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })

    const { session, round } = await fetchPair(db, sess.session.id)
    // Legacy row reflects the answered state...
    expect(session!.status).toBe('answered')
    expect(session!.directive).toBe('stop')
    expect(session!.answersJson).not.toBeNull()
    expect(session!.answeredAt).not.toBeNull()
    // ...and the mirror agrees on it AND every other shared column (no drift).
    expect(mismatches(session!, round!)).toEqual({})
  })
})
