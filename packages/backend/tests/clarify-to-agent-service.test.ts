// RFC-W004 T9 - to-agent clarify service contract (PR-2).
//
// Mirrors cross-clarify-service.test.ts. LOCKS:
//   1. createToAgentSessionAndTriggerAnswerer: parks to-agent node_run at
//      awaiting_human, inserts clarify_rounds kind='to-agent' with
//      answererNodeId=A, broadcasts 'clarify-to-agent.created', AND mints A's
//      answerer rerun (cause='clarify-to-agent-answer', status='pending').
//   2. answerer-missing: null answererNodeId -> ConflictError
//      'clarify-to-agent-answerer-missing-at-runtime'.
//   3. iteration counter increments per (node, loop_iter).
//   4. loop_iter isolation: loopIter=1 sessions are independent from loopIter=0.
//   5. commitToAgentAnswerAndTriggerQuestioner: seals the round (answered,
//      answersJson=markdown, answererNodeRunId set), transitions to-agent
//      node_run awaiting_human->done, broadcasts 'clarify-to-agent.answered',
//      mints B's questioner rerun (cause='clarify-to-agent-questioner-rerun').
//   6. multi-source: A's single answer covers BOTH pending to-agent sessions
//      pointing at A (both sealed, both B's get a rerun).
//   7. escalateToHuman: A cannot answer -> to-agent session STAYS awaiting_human,
//      broadcasts 'clarify-to-agent.escalated'.
//   8. abandoned: answerer A's run failed -> awaiting_human sessions upgraded
//      to abandoned (abandonToAgentSessionsForFailedAnswerer).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  abandonToAgentSessionsForFailedAnswerer,
  commitToAgentAnswerAndTriggerQuestioner,
  createToAgentSessionAndTriggerAnswerer,
  escalateToHuman,
  evaluateAnswererRerunReadiness,
} from '../src/services/toAgentClarify'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type { ClarifyQuestion, TaskWsMessage, WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

// B -> to-agent -> A (answerer). The to_answerer edge targets A.
function defaultDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'answerer', kind: 'agent-single', agentName: 'answerer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'to1', kind: 'clarify-to-agent' },
    ],
    edges: [
      {
        id: 'e_b_clarify',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'to1', portName: 'questions' },
      },
      {
        id: 'e_to_b',
        source: { nodeId: 'to1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_to_a',
        source: { nodeId: 'to1', portName: 'to_answerer' },
        target: { nodeId: 'answerer', portName: '__clarify_request__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, def?: WorkflowDefinition): Promise<{ taskId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition = def ?? defaultDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-to-agent-test',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

async function seedRun(
  db: DbClient,
  taskId: string,
  opts: { id?: string; nodeId: string; status?: string; preSnapshot?: string | null },
): Promise<string> {
  const id = opts.id ?? `nr_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    status: (opts.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: opts.preSnapshot ?? null,
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-W004 createToAgentSessionAndTriggerAnswerer', () => {
  test('parks to-agent node_run awaiting_human + mints A answerer rerun + broadcasts created', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedRun(db, taskId, { nodeId: 'questioner' })
    // A's prior run (A will inherit its preSnapshot).
    await seedRun(db, taskId, { id: 'nr_a_prior', nodeId: 'answerer', preSnapshot: 'snap-a' })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { session, toAgentNodeRunId, answererNodeRunId } =
      await createToAgentSessionAndTriggerAnswerer({
        db,
        taskId,
        toAgentNodeId: 'to1',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: qRunId,
        answererNodeId: 'answerer',
        loopIter: 0,
        questions: [makeQ('q1', 'Why Redis?')],
      })

    expect(session.status).toBe('awaiting_human')
    expect(session.iteration).toBe(0)
    expect(session.answererNodeId).toBe('answerer')
    expect(session.answererNodeRunId).toBeNull()
    expect(toAgentNodeRunId).not.toBe('')
    // A's answerer rerun was minted (not deferred - no in-flight A run).
    expect(answererNodeRunId).not.toBeNull()

    // clarify_rounds row: kind='to-agent', answererNodeId set, status awaiting_human.
    const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, session.id)))[0]
    expect(round?.kind).toBe('to-agent')
    expect(round?.answererNodeId).toBe('answerer')
    expect(round?.answererNodeRunId).toBeNull()
    expect(round?.status).toBe('awaiting_human')

    // to-agent node_run parked at awaiting_human.
    const toAgentNr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, toAgentNodeRunId)))[0]
    expect(toAgentNr?.status).toBe('awaiting_human')
    expect(toAgentNr?.rerunCause).toBe('clarify-to-agent-park')

    // A's answerer rerun: pending, cause='clarify-to-agent-answer', inherited preSnapshot.
    const aNr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, answererNodeRunId!)))[0]
    expect(aNr?.status).toBe('pending')
    expect(aNr?.rerunCause).toBe('clarify-to-agent-answer')
    expect(aNr?.preSnapshot).toBe('snap-a')

    // broadcast created.
    expect(received.length).toBe(1)
    expect(received[0]?.type).toBe('clarify-to-agent.created')
  })

  test('null answererNodeId -> ConflictError clarify-to-agent-answerer-missing-at-runtime', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedRun(db, taskId, { nodeId: 'questioner' })

    let threw = false
    try {
      await createToAgentSessionAndTriggerAnswerer({
        db,
        taskId,
        toAgentNodeId: 'to1',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: qRunId,
        answererNodeId: null,
        loopIter: 0,
        questions: [makeQ('q1', 't')],
      })
    } catch (e) {
      threw = true
      expect((e as { code?: string }).code).toBe('clarify-to-agent-answerer-missing-at-runtime')
    }
    expect(threw).toBe(true)
  })

  test('iteration counter increments per (node, loop_iter)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedRun(db, taskId, { id: 'nr_q1', nodeId: 'questioner' })
    await seedRun(db, taskId, { id: 'nr_q2', nodeId: 'questioner' })

    const r1 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q1',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r1.session.iteration).toBe(0)

    // Mark A's first answerer run done so the second ask triggers a fresh A run.
    const a1 = r1.answererNodeRunId!
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, a1))

    const r2 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q2',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    expect(r2.session.iteration).toBe(1)
  })

  test('loop_iter isolation: loopIter=1 session is independent from loopIter=0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedRun(db, taskId, { id: 'nr_q_l0', nodeId: 'questioner' })
    await seedRun(db, taskId, { id: 'nr_q_l1', nodeId: 'questioner' })

    const r0 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_l0',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 'loop0')],
    })
    expect(r0.session.iteration).toBe(0)
    expect(r0.session.loopIter).toBe(0)

    const a0 = r0.answererNodeRunId!
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, a0))

    // loopIter=1 -> iteration resets to 0 (different loop scope).
    const r1 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_l1',
      answererNodeId: 'answerer',
      loopIter: 1,
      questions: [makeQ('q1', 'loop1')],
    })
    expect(r1.session.iteration).toBe(0)
    expect(r1.session.loopIter).toBe(1)
  })
})

describe('RFC-W004 commitToAgentAnswerAndTriggerQuestioner', () => {
  test('seals round + transitions to-agent node_run done + mints B rerun + broadcasts answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedRun(db, taskId, { nodeId: 'questioner' })
    await seedRun(db, taskId, { nodeId: 'answerer', preSnapshot: 'snap-a' })

    const { toAgentNodeRunId, answererNodeRunId } = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why Redis?')],
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { sealedSessions, questionerNodeRunIds } = await commitToAgentAnswerAndTriggerQuestioner({
      db,
      taskId,
      answererNodeRunId: answererNodeRunId!,
      answer: { markdown: 'Use Redis for cache because...' },
      definition: defaultDef(),
    })

    expect(sealedSessions).toHaveLength(1)
    expect(sealedSessions[0]?.status).toBe('answered')
    expect(sealedSessions[0]?.answer).toBe('Use Redis for cache because...')
    expect(sealedSessions[0]?.answererNodeRunId).toBe(answererNodeRunId)
    expect(questionerNodeRunIds).toHaveLength(1)

    // to-agent node_run -> done.
    const toNr = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, toAgentNodeRunId)))[0]
    expect(toNr?.status).toBe('done')

    // B's questioner rerun: pending, cause='clarify-to-agent-questioner-rerun'.
    const bNr = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, questionerNodeRunIds[0]!))
    )[0]
    expect(bNr?.status).toBe('pending')
    expect(bNr?.rerunCause).toBe('clarify-to-agent-questioner-rerun')

    // broadcast answered.
    expect(received.some((m) => m.type === 'clarify-to-agent.answered')).toBe(true)
  })

  test('multi-source: A single answer covers BOTH pending to-agent sessions pointing at A', async () => {
    // Two to-agent nodes (to1, to2) both pointing at answerer A.
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'answerer', kind: 'agent-single', agentName: 'answerer' },
        { id: 'b1', kind: 'agent-single', agentName: 'b1' },
        { id: 'b2', kind: 'agent-single', agentName: 'b2' },
        { id: 'to1', kind: 'clarify-to-agent' },
        { id: 'to2', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_b1_clarify',
          source: { nodeId: 'b1', portName: '__clarify__' },
          target: { nodeId: 'to1', portName: 'questions' },
        },
        {
          id: 'e_to1_b1',
          source: { nodeId: 'to1', portName: 'to_questioner' },
          target: { nodeId: 'b1', portName: '__clarify_response__' },
        },
        {
          id: 'e_to1_a',
          source: { nodeId: 'to1', portName: 'to_answerer' },
          target: { nodeId: 'answerer', portName: '__clarify_request__' },
        },
        {
          id: 'e_b2_clarify',
          source: { nodeId: 'b2', portName: '__clarify__' },
          target: { nodeId: 'to2', portName: 'questions' },
        },
        {
          id: 'e_to2_b2',
          source: { nodeId: 'to2', portName: 'to_questioner' },
          target: { nodeId: 'b2', portName: '__clarify_response__' },
        },
        {
          id: 'e_to2_a',
          source: { nodeId: 'to2', portName: 'to_answerer' },
          target: { nodeId: 'answerer', portName: '__clarify_request__' },
        },
      ],
      outputs: [],
    }
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, def)
    await seedRun(db, taskId, { id: 'nr_b1', nodeId: 'b1' })
    await seedRun(db, taskId, { id: 'nr_b2', nodeId: 'b2' })
    await seedRun(db, taskId, { nodeId: 'answerer', preSnapshot: 'snap-a' })

    // B1 asks -> parks to1 + mints A answerer run.
    const r1 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'b1',
      sourceQuestionerNodeRunId: 'nr_b1',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 'from b1')],
    })
    expect(r1.answererNodeRunId).not.toBeNull()

    // B2 asks -> A already has an in-flight answerer run -> DEFERRED (no new A run).
    const r2 = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to2',
      sourceQuestionerNodeId: 'b2',
      sourceQuestionerNodeRunId: 'nr_b2',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 'from b2')],
    })
    expect(r2.answererNodeRunId).toBeNull()

    // A answers -> BOTH to1 and to2 sessions sealed, BOTH B's get a rerun.
    const { sealedSessions, questionerNodeRunIds } = await commitToAgentAnswerAndTriggerQuestioner({
      db,
      taskId,
      answererNodeRunId: r1.answererNodeRunId!,
      answer: { markdown: 'single answer covers both' },
      definition: def,
    })
    expect(sealedSessions).toHaveLength(2)
    expect(questionerNodeRunIds).toHaveLength(2)
    // Both sealed sessions carry the same answer markdown.
    expect(sealedSessions.every((s) => s.answer === 'single answer covers both')).toBe(true)
  })
})

describe('RFC-W004 escalateToHuman', () => {
  test('A cannot answer -> to-agent session STAYS awaiting_human + broadcasts escalated', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedRun(db, taskId, { nodeId: 'questioner' })
    await seedRun(db, taskId, { nodeId: 'answerer', preSnapshot: 'snap-a' })

    const { answererNodeRunId } = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why?')],
    })

    const received: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.push(m))

    const { escalatedSessions } = await escalateToHuman({
      db,
      taskId,
      answererNodeRunId: answererNodeRunId!,
    })

    expect(escalatedSessions).toHaveLength(1)
    // The to-agent session STAYS awaiting_human (A hasn't answered B yet).
    expect(escalatedSessions[0]?.status).toBe('awaiting_human')

    // clarify_rounds row still awaiting_human (NOT sealed).
    const round = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, escalatedSessions[0]!.id))
    )[0]
    expect(round?.status).toBe('awaiting_human')
    expect(round?.answersJson).toBeNull()

    expect(received.some((m) => m.type === 'clarify-to-agent.escalated')).toBe(true)
  })
})

describe('RFC-W004 evaluateAnswererRerunReadiness (multi-source barrier)', () => {
  test('ready when pending session exists and no in-flight A answerer run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedRun(db, taskId, { id: 'nr_q', nodeId: 'questioner' })

    // No session yet -> not ready (nothing to answer).
    const empty = await evaluateAnswererRerunReadiness({
      db,
      taskId,
      answererNodeId: 'answerer',
      loopIter: 0,
    })
    expect(empty.ready).toBe(false)
    expect(empty.pendingSessions).toHaveLength(0)

    // Park a session -> ready (no in-flight A run).
    await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })
    const after = await evaluateAnswererRerunReadiness({
      db,
      taskId,
      answererNodeId: 'answerer',
      loopIter: 0,
    })
    // A's answerer run was just minted (in-flight) -> ready=false (would double-trigger).
    expect(after.hasInFlightAnswererRun).toBe(true)
    expect(after.ready).toBe(false)
    expect(after.pendingSessions).toHaveLength(1)
  })
})

describe('RFC-W004 abandonToAgentSessionsForFailedAnswerer', () => {
  test('answerer A failed -> awaiting_human sessions upgraded to abandoned', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const qRunId = await seedRun(db, taskId, { nodeId: 'questioner' })
    await seedRun(db, taskId, { nodeId: 'answerer', preSnapshot: 'snap-a' })

    const { session } = await createToAgentSessionAndTriggerAnswerer({
      db,
      taskId,
      toAgentNodeId: 'to1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRunId,
      answererNodeId: 'answerer',
      loopIter: 0,
      questions: [makeQ('q1', 't')],
    })

    const count = await abandonToAgentSessionsForFailedAnswerer(db, {
      taskId,
      answererNodeId: 'answerer',
    })
    expect(count).toBe(1)

    const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, session.id)))[0]
    expect(round?.status).toBe('abandoned')
    expect(round?.abandonedAt).not.toBeNull()

    // Idempotent: second call finds nothing to abandon.
    const count2 = await abandonToAgentSessionsForFailedAnswerer(db, {
      taskId,
      answererNodeId: 'answerer',
    })
    expect(count2).toBe(0)
  })
})
