// RFC-120 T9 (model A) — deferred question dispatch backend foundation.
//
// Locks the four foundation behaviors (design §14 / §16 C1-H4 / §17):
//   A. submit split — tasks.deferred_question_dispatch FALSE = byte-for-byte
//      today's immediate dispatch (golden-lock: outcome 'designer-rerun-triggered');
//      TRUE + ≥1 designer-scoped question → outcome 'designer-deferred', NO designer
//      rerun minted, designer task_questions rows created undispatched (trigger_run_id
//      NULL). questioner-only rounds unchanged regardless of the flag.
//   B. PARK gate (pure deriveFrontier) — a deferred designer handler node is kept OUT
//      of `completed` (downstream blocked) and bubbled awaiting_human; empty deferred
//      set = byte-for-byte today's frontier.
//   C. T2 invariant + S2 stuck detector treat the park (task awaiting_human with no
//      awaiting_human node_run / no open clarify_session) as VALID for a deferred task,
//      and still fire for a non-deferred task (golden-lock control).
//   D. dispatchTaskQuestions — mint one rerun per effective target, stamp trigger_run_id
//      (releases the gate); CAS idempotency: a repeated dispatch never double-mints.
//
// The flag is the golden-lock boundary: every gate consumer is inert for a
// non-deferred task (loadUndispatchedDesignerTargets self-gates on the flag).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import {
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { markClarifyRoundsConsumedBy } from '../src/services/clarifyRounds'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import {
  confirmTaskQuestion,
  listTaskQuestions,
  loadUndispatchedDesignerTargets,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { deriveFrontier } from '../src/services/scheduler'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyQuestion,
  NodeKind,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node with NO __external_feedback__ edge — a valid reassign target
// (canReassign accepts any agent node) but an UNSAFE dispatch target in v1 (H3).
const OTHER = 'other'

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

function mkQ(id: string, title: string): ClarifyQuestion {
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

/** Seed a task (with the deferred flag set) + workflow snapshot + the designer's
 *  prior `done` draft + the questioner's `done` asking run, then open one
 *  cross-clarify session and return its node_run id. */
async function seedTask(
  db: DbClient,
  opts: { deferred: boolean; questions?: ClarifyQuestion[]; ownerUserId?: string },
): Promise<{ taskId: string; crossClarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc120-t9',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc120-t9',
    workflowId,
    ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-t9/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: opts.deferred,
  })
  // ULID ids (production-accurate): node_run freshness — and resolveHandlerRun's
  // lineage window — is pure ULID id-order, so these seeded runs must sort BEFORE
  // the later-minted dispatch reruns (a non-ULID string id sorts AFTER ULIDs and
  // would pollute the lineage window).
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: CC,
    sourceQuestionerNodeId: QUESTIONER,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: DESIGNER,
    loopIter: 0,
    questions: opts.questions ?? [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, crossClarifyNodeRunId }
}

/** Seed a DEFERRED task whose designer has TWO sibling cross-clarify nodes
 *  (cc_a/q_a, cc_b/q_b both → DESIGNER) — for the H3 multi-source readiness gate. */
async function seedTwoSource(db: DbClient): Promise<{ taskId: string; ccA: string; ccB: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
    { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  const edges: WorkflowDefinition['edges'] = []
  for (const { q, cc } of [
    { q: 'q_a', cc: 'cc_a' },
    { q: 'q_b', cc: 'cc_b' },
  ]) {
    edges.push({
      id: `e_q_${cc}`,
      source: { nodeId: q, portName: '__clarify__' },
      target: { nodeId: cc, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${cc}`,
      source: { nodeId: cc, portName: 'to_designer' },
      target: { nodeId: DESIGNER, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${cc}`,
      source: { nodeId: cc, portName: 'to_questioner' },
      target: { nodeId: q, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc120-t9-2src',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc120-t9-2src',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc120-t9-2src/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: true,
  })
  await db
    .insert(nodeRuns)
    .values({ id: ulid(), taskId, nodeId: DESIGNER, status: 'done', retryIndex: 0, iteration: 0 })
  const open = async (q: string, cc: string): Promise<string> => {
    const runId = ulid()
    await db
      .insert(nodeRuns)
      .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: cc,
      sourceQuestionerNodeId: q,
      sourceQuestionerNodeRunId: runId,
      targetDesignerNodeId: DESIGNER,
      loopIter: 0,
      questions: [mkQ(cc === 'cc_a' ? 'a1' : 'b1', 'designer-scoped?')],
    })
    return crossClarifyNodeRunId
  }
  const ccA = await open('q_a', 'cc_a')
  const ccB = await open('q_b', 'cc_b')
  return { taskId, ccA, ccB }
}

function ans(qid: string) {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// A — submit split.
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — submit split (defer vs immediate)', () => {
  test('golden-lock: flag FALSE designer-scoped answer → designer-rerun-triggered (immediate)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: false })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      // no questionScopes → all-designer (CLARIFY_QUESTION_SCOPE_DEFAULT)
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    // a fresh designer rerun was minted immediately
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(2) // draft + rerun
    // no park: non-deferred task always resolves the gate empty
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })

  test('flag TRUE designer-scoped answer → designer-deferred + NO rerun + undispatched entry', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-deferred')
    if (ret.outcome.kind === 'designer-deferred') {
      expect(ret.outcome.deferredQuestionCount).toBe(1)
    }
    // the answer IS recorded (round answered) but NO designer rerun minted
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(1) // draft only — deferred
    // the designer task_questions entry was created eagerly + undispatched
    const designerEntries = await db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    expect(designerEntries.length).toBe(1)
    expect(designerEntries[0]?.triggerRunId).toBeNull()
    expect(designerEntries[0]?.defaultTargetNodeId).toBe(DESIGNER)
    // the park gate now sees the designer as an undispatched target
    expect([...(await loadUndispatchedDesignerTargets(db, taskId))]).toEqual([DESIGNER])
  })

  test('flag TRUE questioner-only answer → questioner-continue (unchanged) + gate empty', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
      questionScopes: { q1: 'questioner' },
    })
    expect(ret.outcome.kind).toBe('questioner-continue-triggered')
    // no designer entry → no park even though the task is flagged
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// B — PARK gate (pure deriveFrontier).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — frontier park gate', () => {
  type Row = typeof nodeRuns.$inferSelect
  let seq = 0
  function row(nodeId: string, status: string): Row {
    seq += 1
    return {
      id: `01R${String(seq).padStart(4, '0')}`,
      nodeId,
      iteration: 0,
      status,
      parentNodeRunId: null,
    } as unknown as Row
  }
  const defOf = (nodes: Array<{ id: string; kind: NodeKind }>) => ({
    definition: { nodes, edges: [] } as unknown as WorkflowDefinition,
    scopeNodes: nodes as unknown as WorkflowNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  })
  const NONE: ReadonlySet<string> = new Set()
  const ups = (m: Record<string, string[]>) => new Map(Object.entries(m))

  test('deferred designer parked → not completed, awaiting_human, downstream blocked', () => {
    const { definition, scopeNodes, scopeIds } = defOf([
      { id: DESIGNER, kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    const rows = [row(DESIGNER, 'done'), row('down', 'pending')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ down: [DESIGNER] }),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      new Set([DESIGNER]), // deferredHandlerNodeIds
    )
    expect(f.completed.has(DESIGNER)).toBe(false)
    expect(f.awaitingHuman).toContain(DESIGNER)
    expect(f.ready).not.toContain('down') // downstream blocked (designer not completed)
    expect(f.ready).not.toContain(DESIGNER)
  })

  test('golden-lock: empty deferred set → designer completed, downstream ready', () => {
    const { definition, scopeNodes, scopeIds } = defOf([
      { id: DESIGNER, kind: 'agent-single' },
      { id: 'down', kind: 'agent-single' },
    ])
    const rows = [row(DESIGNER, 'done')]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ down: [DESIGNER] }),
      NONE,
      NONE,
      NONE,
      NONE,
      NONE,
      NONE, // no deferred nodes
    )
    expect(f.completed.has(DESIGNER)).toBe(true)
    expect(f.ready).toContain('down')
    expect(f.awaitingHuman).not.toContain(DESIGNER)
  })
})

// ---------------------------------------------------------------------------
// C — T2 invariant + S2 stuck detector exemption.
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — T2 / S2 treat the park as valid (deferred) and corrupt (control)', () => {
  test('T2: deferred task awaiting_human + undispatched designer → no T2 alert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // park the task (the scheduler would do this at quiescence)
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(0)
  })

  test('T2 control: non-deferred task awaiting_human + no awaiting_human run → T2 fires', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: false })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    const result = await runLifecycleInvariants({ db, scope: { taskId } })
    // non-deferred → loadUndispatchedDesignerTargets is empty → T2 fires as before
    expect(result.openAlerts.filter((a) => a.rule === 'T2')).toHaveLength(1)
  })

  test('S2: deferred task awaiting_human + undispatched designer → no S2 finding', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    // park + age past the freshness gate (startedAt long ago, no events)
    await db
      .update(tasks)
      .set({ status: 'awaiting_human', startedAt: Date.now() - 60 * 60 * 1000 })
      .where(eq(tasks.id, taskId))
    const result = await runStuckTaskDetector({ db, stuckThresholdMs: 1000 })
    expect(result.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// D — dispatchTaskQuestions (mint / stamp / release + CAS idempotency).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — dispatchTaskQuestions', () => {
  async function seedDeferredAnswered(db: DbClient) {
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    )[0]!
    return { taskId, entryId: entry.id }
  }
  const actor = { userId: 'u1', role: 'owner' as const }

  test('mint per effective target + trigger_run_id stamped + gate released', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, entryId } = await seedDeferredAnswered(db)

    const result = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)

    // a fresh pending designer rerun was minted
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.length).toBe(2) // draft + dispatched rerun
    const pending = designerRuns.find((r) => r.status === 'pending')
    expect(pending).toBeDefined()
    expect(pending?.rerunCause).toBe('cross-clarify-answer')

    // the entry now carries the rerun id, and the gate is released
    const entry = (await db.select().from(taskQuestions).where(eq(taskQuestions.id, entryId)))[0]
    expect(entry?.triggerRunId).toBe(result.reruns[0]?.nodeRunId)
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
  })

  test('CAS idempotency: double dispatch does not double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, entryId } = await seedDeferredAnswered(db)

    const first = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(first.reruns.length).toBe(1)
    const second = await dispatchTaskQuestions(db, taskId, [entryId], actor)
    expect(second.reruns.length).toBe(0) // already claimed → no-op

    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.filter((r) => r.status === 'pending').length).toBe(1) // exactly one rerun
  })
})

// ---------------------------------------------------------------------------
// E — Codex impl-gate folds: H1 (graph-node granularity vs round-scoped
// consumption), H2 (atomic claim+mint, no orphan/phantom), H3 (unsafe targets).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — dispatch correctness (Codex impl-gate H1/H2/H3)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  test('H1: dispatching ONE entry of a multi-question round stamps the WHOLE node group (no stranded sibling)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    expect(entries.length).toBe(2) // q1 + q2 both → designer

    // dispatch only q1 → expansion stamps BOTH (round/graph-scoped consumption)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.entryIds.length).toBe(2) // whole node group

    const after = await designerEntries(db, taskId)
    expect(after.every((e) => e.triggerRunId === result.reruns[0]?.nodeRunId)).toBe(true)
    // no sibling stranded → gate fully released
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0)
    // exactly ONE rerun for the node (not one-per-question)
    const designerRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(designerRuns.filter((r) => r.status === 'pending').length).toBe(1)
  })

  test('H2: a stamped entry always resolves to an EXISTING node_run (no phantom / orphan)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    const stampedId = (await designerEntries(db, taskId))[0]!.triggerRunId
    expect(stampedId).toBe(result.reruns[0]!.nodeRunId)
    // the stamped run is a REAL row (claim+mint committed together, no orphan)
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, stampedId!)))[0]
    expect(run).toBeDefined()
    expect(run?.nodeId).toBe(DESIGNER)
  })

  // Run-scoped injection layer — override to a node WITH a prior run but NO
  // __external_feedback__ edge now SUCCEEDS and the rerun carries the answer
  // (flips the old H3 reject). Never-run override is still rejected.
  test('override to a run-but-no-edge node → dispatch succeeds; run-scoped feedback carries the answer; stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has a prior node_run (so it is not never-run) but no feedback edge.
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER) // dispatched to the override node
    const runId = result.reruns[0]!.nodeRunId

    // entry stamped + a pending rerun minted on OTHER (no edge), not on DESIGNER
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.some((r) => r.id === runId && r.status === 'pending')).toBe(true)

    // run-scoped External Feedback for THIS run carries the human answer, even
    // though OTHER has no __external_feedback__ graph edge.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: OTHER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('A') // the selected answer label
    expect(ctx?.block).toContain(QUESTIONER) // the source questioner heading
  })

  test('never-run override target → rejected (clean ConflictError, nothing minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    // OTHER has NO prior node_run.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-unsafe-dispatch-target')
    // nothing minted; entry stays claimable
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBeNull()
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.length).toBe(0)
  })

  test('golden-lock: buildExternalFeedbackContext with no dispatchedRunId (or no claiming entries) uses the graph path', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    // No dispatchedRunId → graph path. The designer (DESIGNER) HAS the edge, so
    // the graph path surfaces the answered unconsumed session.
    const graph = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(graph?.block).toContain('A')
    // A bogus dispatchedRunId with NO claiming entries → falls through to the
    // SAME graph path (byte-for-byte).
    const fallthrough = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: 'nr_does_not_claim_anything',
    })
    expect(fallthrough?.block).toBe(graph?.block ?? '')
  })

  test('override-aware consumption: the overridden round is consumed by the OVERRIDE run, so the graph designer no longer re-injects it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    await reassignTaskQuestion(db, entries[0]!.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [entries[0]!.id], actor)
    const overrideRunId = result.reruns[0]!.nodeRunId

    // Before consumption: the graph designer (DESIGNER) would still see the round.
    const before = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(before?.block).toContain('A')

    // The OVERRIDE run completes → override-aware markClarifyRoundsConsumedBy
    // consumes the round even though its targetConsumerNodeId is DESIGNER, not OTHER.
    await markClarifyRoundsConsumedBy(db, {
      id: overrideRunId,
      taskId,
      nodeId: OTHER,
      shardKey: null,
    })
    const session = (
      await db
        .select()
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.crossClarifyNodeRunId, crossClarifyNodeRunId))
    )[0]
    expect(session?.consumedByConsumerRunId).toBe(overrideRunId)

    // After consumption: the graph designer no longer re-injects the overridden
    // round (no double-handling).
    const after = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(after).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// F — Codex impl-gate folds on the run-scoped layer: H1 (split-round per-origin),
// M1 (override target gets no Update Directive), H2 (the HTTP release path).
// ---------------------------------------------------------------------------
describe('RFC-120 T9 — run-scoped layer Codex folds (H1/M1/H2)', () => {
  const actor = { userId: 'u1', role: 'owner' as const }
  const TOKEN = 'a'.repeat(64)
  const AUTH = { Authorization: `Bearer ${TOKEN}` }

  function makeApp(db: DbClient) {
    process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-t9-home-'))
    return createApp({
      token: TOKEN,
      configPath: join(mkdtempSync(join(tmpdir(), 'aw-t9-cfg-')), 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
  }

  async function designerEntries(db: DbClient, taskId: string) {
    return db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
  }

  test('H1: a round split q1→override / q2→graph-designer is REJECTED per-origin (nothing stamped/minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, {
      deferred: true,
      questions: [mkQ('q1', 'first?'), mkQ('q2', 'second?')],
    })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1'), ans('q2')],
      directive: 'continue',
    })
    const entries = await designerEntries(db, taskId)
    const q1Entry = entries.find((e) => e.questionId === 'q1')!
    // override ONLY q1 → the round now spans {OTHER, DESIGNER}
    await reassignTaskQuestion(db, q1Entry.id, OTHER, actor)

    // dispatching q1 must be rejected: the per-origin guard sees q2 (still →
    // DESIGNER) in the SAME round, even though q2 is outside the requested group.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [q1Entry.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-round-multi-target')
    // nothing stamped, nothing minted (no partial dispatch)
    const after = await designerEntries(db, taskId)
    expect(after.every((e) => e.triggerRunId === null)).toBe(true)
    const minted = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(minted.length).toBe(0)
  })

  test('M1: the run-scoped override context is flagged runScoped (drives Update-Directive suppression)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: OTHER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx?.runScoped).toBe(true)
    // The graph path (no claiming entries) is NOT flagged run-scoped → the generic
    // priorOutputUpdate stays available there (golden-lock).
    const graph = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
    })
    expect(graph?.runScoped).toBeUndefined()
  })

  test('M1: scheduler suppresses the generic priorOutputUpdate for a run-scoped context (source lock)', () => {
    // The giant runOneNode prompt assembly can't be unit-run (it spawns opencode);
    // lock the suppression at the source so a refactor that drops it goes red.
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'), 'utf8')
    expect(src).toContain('crossClarifyContext?.runScoped !== true')
  })

  test('H2: full HTTP path — deferred submit parks, POST .../questions/dispatch stamps + mints + releases the gate', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    // owner = the daemon TOKEN actor (__system__) so the member gate passes.
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, {
      deferred: true,
      ownerUserId: '__system__',
    })
    // designer-scoped submit → deferred (entry created, no rerun); simulate the park.
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(submit.outcome.kind).toBe('designer-deferred')
    await db.update(tasks).set({ status: 'awaiting_human' }).where(eq(tasks.id, taskId))
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(1) // parked

    const entry = (await designerEntries(db, taskId))[0]!
    const res = await app.request(`/api/tasks/${taskId}/questions/dispatch`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ entryIds: [entry.id] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; reruns: Array<{ nodeRunId: string }> }
    expect(body.ok).toBe(true)
    expect(body.reruns.length).toBe(1)

    // entry stamped + a pending designer rerun minted + gate released.
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(body.reruns[0]?.nodeRunId)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, DESIGNER),
          eq(nodeRuns.status, 'pending'),
        ),
      )
    expect(pending.length).toBe(1)
    expect((await loadUndispatchedDesignerTargets(db, taskId)).size).toBe(0) // released
  })

  test('H2: dispatch route rejects empty entryIds (422)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    const { taskId } = await seedTask(db, { deferred: true, ownerUserId: '__system__' })
    const res = await app.request(`/api/tasks/${taskId}/questions/dispatch`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ entryIds: [] }),
    })
    expect(res.status).toBe(422)
  })

  test('H1(re-gate): dispatch on a NON-deferred task is rejected — no extra rerun, nothing stamped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: false })
    // non-deferred designer-scoped submit → immediate designer rerun.
    const submit = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    expect(submit.outcome.kind).toBe('designer-rerun-triggered')
    // lazy reconcile creates the designer entry (trigger_run_id NULL).
    await listTaskQuestions(db, taskId)
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.triggerRunId).toBeNull()
    const before = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))

    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-not-deferred-dispatch')
    // no DUPLICATE rerun minted; entry still un-stamped.
    const after = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    expect(after.length).toBe(before.length)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBeNull()
  })

  test('H2(re-gate): deferred designer entry reads pending→staged pre-dispatch, processing→awaiting_confirm after', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const phaseOf = async () =>
      (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!.phase

    // Pre-dispatch: NOT processing — the task is parked, the row is pending.
    expect(await phaseOf()).toBe('pending')
    const entry = (await designerEntries(db, taskId))[0]!
    await stageTaskQuestion(db, entry.id, true, actor)
    expect(await phaseOf()).toBe('staged')

    // Dispatch → the entry's own trigger_run_id (pending rerun) → processing.
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const runId = result.reruns[0]!.nodeRunId
    expect(await phaseOf()).toBe('processing')

    // Run finishes done + output → awaiting_confirm.
    await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, runId))
    await db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'result', content: 'x' })
    expect(await phaseOf()).toBe('awaiting_confirm')
  })

  test('M1(re-gate): reassign allowed pre-dispatch (NULL trigger) but rejected post-dispatch (stamped)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!

    // pre-dispatch (trigger_run_id NULL) → reassign allowed.
    await reassignTaskQuestion(db, entry.id, OTHER, actor)
    expect((await designerEntries(db, taskId))[0]?.overrideTargetNodeId).toBe(OTHER)

    // dispatch stamps trigger_run_id.
    await dispatchTaskQuestions(db, taskId, [entry.id], actor)

    // post-dispatch → reassign rejected (reopen is the post-dispatch path).
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, entry.id, DESIGNER, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-already-dispatched')
  })

  test('H1(final): a process-retry of the dispatched run resolves awaiting_confirm (not stuck on the failed anchor); confirm works', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [{ ...ans('q1'), selectedOptionLabels: ['A'] }],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    const anchorRunId = result.reruns[0]!.nodeRunId
    const anchorRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, anchorRunId)))[0]!

    const phaseOf = async () =>
      (await listTaskQuestions(db, taskId)).find((e) => e.roleKind === 'designer')!.phase

    // The dispatched run FAILS → still processing (D3), confirm would reject.
    await db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, anchorRunId))
    expect(await phaseOf()).toBe('processing')

    // The scheduler mints a technical process-retry (same node + iteration, cause
    // 'process-retry', fresh ULID > anchor) which succeeds with output.
    const retryId = ulid()
    await db.insert(nodeRuns).values({
      id: retryId,
      taskId,
      nodeId: DESIGNER,
      status: 'done',
      retryIndex: 1,
      iteration: anchorRow.iteration,
      rerunCause: 'process-retry',
      startedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({ nodeRunId: retryId, portName: 'result', content: 'x' })

    // The entry resolves through the LINEAGE → awaiting_confirm (not stuck).
    expect(await phaseOf()).toBe('awaiting_confirm')
    // confirm now works.
    await confirmTaskQuestion(db, entry.id, actor)
    expect(await phaseOf()).toBe('done')
  })

  test('H2(final): reassign is a CAS on trigger_run_id — a concurrent stamp makes it affect 0 rows → rejected', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { deferred: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    // Simulate a dispatch winning the race (stamping trigger_run_id) AFTER reassign
    // would have read a NULL — the reassign CAS (WHERE trigger_run_id IS NULL) then
    // affects 0 rows → reject (no silent re-target of in-flight work).
    await db
      .update(taskQuestions)
      .set({ triggerRunId: ulid() })
      .where(eq(taskQuestions.id, entry.id))
    let threw: unknown = null
    try {
      await reassignTaskQuestion(db, entry.id, OTHER, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-already-dispatched')
    // override unchanged (the CAS did not write).
    expect((await designerEntries(db, taskId))[0]?.overrideTargetNodeId).toBeNull()
  })

  test('H3(final): graph-designer dispatch is rejected while a sibling cross-clarify is still awaiting; succeeds once answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, ccA, ccB } = await seedTwoSource(db)

    // Answer source A (designer-scoped) → deferred. B is still awaiting_human.
    const subA = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    expect(subA.outcome.kind).toBe('designer-deferred')
    const entryA = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccA)!

    // Dispatch A's designer entry → rejected: sibling B unresolved → partial rerun risk.
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-designer-not-ready')
    expect((await designerEntries(db, taskId)).every((e) => e.triggerRunId === null)).toBe(true)

    // Answer source B → now all siblings resolved.
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccB,
      answers: [ans('b1')],
      directive: 'continue',
    })
    // Dispatch now succeeds (one designer rerun for the full batch).
    const result = await dispatchTaskQuestions(db, taskId, [entryA.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
  })
})
