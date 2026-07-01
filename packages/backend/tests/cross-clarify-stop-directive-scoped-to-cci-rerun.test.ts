// Regression: cross-questioner 'stop' directive must scope to the
// cross-clarify-driven rerun only — NOT to a later review-iterate /
// process-retry rerun that inherits crossClarifyIteration.
//
// Symmetric to clarify-stop-directive-scoped-to-clarify-rerun.test.ts but
// for the cross-questioner side. Original RFC-023 patch added
// `applyLatestDirective` + scheduler `isClarifyRerun` gate to
// `buildClarifyPromptContext` (self path). When RFC-058 T13 unified the
// three paths into `buildPromptContext` the gate was wired into the self
// branch (scheduler.ts:1599 `applyLatestDirective: isClarifyRerun`) but
// the cross-questioner branch (scheduler.ts:~1569) was left with the
// default `applyLatestDirective=true`. `isQuestionerCrossClarifyRerun`
// only checks `cci > 0` (no retry_index sub-gate), so any rerun that
// inherits the cci — review-iterate, process-retry — still falls into
// the cross-questioner branch and dragged the prior 'stop' directive
// into its prompt. Effect: scheduler.ts:1648
// `effectiveHasClarifyChannel = … && directive !== 'stop'` evaluated to
// false → the `<workflow-clarify>` protocol block was dropped + the
// answersBlock still carried `STOP CLARIFYING`, even though the user is
// actively asking the questioner to address NEW reviewer comments.
//
// Contract this file locks:
//   1. SERVICE: `buildPromptContext({consumerKind:'cross-questioner',
//      applyLatestDirective:false})` returns ctx.directive='continue',
//      answersBlock has neither STOP CLARIFYING nor KEEP CLARIFYING
//      trailer, but Q&A body stays (so the questioner still sees its
//      own past questions + the downstream answers).
//   2. SCHEDULER WIRING: scheduler.ts passes the shared `applyLatestDirective`
//      local (now `isClarifyRerun || reviewContext === undefined` — RFC-100
//      Codex review #2 broadened it so a non-review-driven process-retry /
//      revival keeps the directive) to the cross-questioner branch of
//      `buildPromptContext`. Source-text guard catches a future refactor that
//      drops the gate back to the default.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'cc1', kind: 'clarify-cross-agent', title: 'CC1' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'cc-stop-scope',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'cc-stop-scope',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-cc-stop-scope/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function sampleQuestionsJson(title: string): string {
  return JSON.stringify([
    {
      id: 'q1',
      title,
      kind: 'single',
      recommended: false,
      options: [
        { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
        { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
      ],
    },
  ])
}

function sampleAnswersJson(): string {
  return JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['Postgres'],
      customText: '',
    },
  ])
}

async function seedStopAnsweredCrossRound(db: DbClient, taskId: string): Promise<void> {
  await db.insert(nodeRuns).values({
    id: 'nr_q',
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await db.insert(nodeRuns).values({
    id: 'nr_cc',
    taskId,
    nodeId: 'cc1',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await db.insert(clarifyRounds).values({
    id: 'r_iter0_stop',
    taskId,
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: 'nr_q',
    intermediaryNodeId: 'cc1',
    intermediaryNodeRunId: 'nr_cc',
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questionsJson: sampleQuestionsJson('Which database?'),
    answersJson: sampleAnswersJson(),
    directive: 'stop',
    status: 'answered',
  })
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe("cross-questioner 'stop' directive scoped to the cci-driven rerun only", () => {
  test('applyLatestDirective omitted (default true) → stop surfaces — preserves cross-clarify-rerun semantics', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedStopAnsweredCrossRound(db, taskId)

    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
      loopIter: 0,
    })

    expect(ctx).toBeDefined()
    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('STOP CLARIFYING')
  })

  test('applyLatestDirective=false → ctx.directive coerced to continue; trailer stripped; Q&A body stays', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedStopAnsweredCrossRound(db, taskId)

    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
      loopIter: 0,
      applyLatestDirective: false,
    })

    expect(ctx).toBeDefined()
    // Critical: scheduler.ts:1648 reads this — with 'continue' the
    // `<workflow-clarify>` protocol block is re-appended on the rerun.
    expect(ctx!.directive).toBe('continue')
    // Neither directive trailer should appear — this rerun is NOT a
    // cross-clarify-driven rerun and shouldn't be told what to do about
    // clarifying.
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
    expect(ctx!.answersBlock).not.toContain('KEEP CLARIFYING')
    // But the underlying Q&A body MUST stay — the questioner still needs
    // to see its own past questions + the downstream answers when
    // addressing fresh reviewer comments.
    expect(ctx!.questionsBlock).toContain('Which database?')
    expect(ctx!.answersBlock).toContain('Postgres')
  })

  test('multi-round: applyLatestDirective=false strips trailer from LAST round only; earlier rounds keep their Round N headers', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedStopAnsweredCrossRound(db, taskId)
    // Second cross-clarify round, also 'stop'.
    await db.insert(clarifyRounds).values({
      id: 'r_iter1_stop',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 1,
      questionsJson: sampleQuestionsJson('Which cache?'),
      answersJson: sampleAnswersJson(),
      directive: 'stop',
      status: 'answered',
    })

    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 2,
      loopIter: 0,
      applyLatestDirective: false,
    })

    expect(ctx).toBeDefined()
    expect(ctx!.directive).toBe('continue')
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
    expect(ctx!.answersBlock).not.toContain('KEEP CLARIFYING')
    // Both rounds' bodies still rendered with their Round N headers.
    expect(ctx!.answersBlock).toContain('### Round 1')
    expect(ctx!.answersBlock).toContain('### Round 2')
    expect(ctx!.questionsBlock).toContain('Which database?')
    expect(ctx!.questionsBlock).toContain('Which cache?')
  })
})

describe('scheduler wiring: cross-questioner buildPromptContext must pass applyLatestDirective gated on retryIndex', () => {
  test('scheduler.ts cross-questioner clarify injection reads the per-node clarify state, not a per-round applyLatestDirective (RFC-132 PR-C)', () => {
    // Source-text guard: catches a future refactor that re-introduces the per-round directive gate.
    // RFC-132 (PR-C §7): the cross-questioner path no longer has its own SELECT branch nor an
    // applyLatestDirective gate — the unified flat injector (buildClarifyQueueContext) queries every
    // role in one shot, and the standing continue/stop directive is the per-node clarify state
    // (nodeStopOverride, from getNodeClarifyDirectiveRow). The cci-rerun stop-scoping is preserved
    // via nodeStopOverride flowing into resolveEffectiveClarifyChannel + shouldInjectStopNotice.
    const source = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(source).not.toContain('applyLatestDirective')
    expect(source).not.toContain("consumerKind: 'cross-questioner'")
    expect(source).toContain('await buildClarifyQueueContext(')
    expect(source).toContain('const nodeStopOverride = nodeDirective === ')
  })
})
