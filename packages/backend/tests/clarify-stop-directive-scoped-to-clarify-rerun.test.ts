// Regression: RFC-023 originally claimed `directive='stop'` "naturally scopes
// to one rerun" — the assumption was that only the clarify-driven rerun
// (clarifyIteration just bumped, retryIndex=0) ever sees that directive.
//
// But review-iterate (and process-retry) reruns inherit `clarifyIteration`
// from the latest upstream row via the fix in commit ec14a85
// (review-iterate-inherits-clarify-iteration.test.ts). Without an additional
// gate, those reruns hit the SAME answered session with directive='stop',
// and the agent receives:
//   - effectiveHasClarifyChannel=false (no <workflow-clarify> protocol block)
//   - answersBlock trailer "### User directive: STOP CLARIFYING"
// even though the user is actively asking it to address NEW reviewer comments.
//
// The contract this file locks: buildClarifyPromptContext now takes
// `applyLatestDirective` (default true preserves clarify-rerun behavior).
// Scheduler passes `isClarifyRerun` for it; when false:
//   - ctx.directive === 'continue' (so the scheduler's
//     `directive !== 'stop'` gate evaluates to true → protocol block stays)
//   - answersBlock contains NEITHER 'STOP CLARIFYING' NOR
//     'KEEP CLARIFYING' trailer for any round
// Earlier rounds' Q&A still render — only the directive trailer is stripped.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildClarifyPromptContext,
  createClarifySession,
  submitClarifyAnswers,
} from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<{ taskId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-clarify-stop-scope/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

function makeQuestion(): ClarifyQuestion {
  return {
    id: 'q1',
    title: 'Which database?',
    kind: 'single',
    recommended: true,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
      { label: 'SQLite', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAnswer(): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
}

function emptyDefinition(): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  }
}

async function seedStopAnsweredSession(db: DbClient, taskId: string): Promise<void> {
  await db.insert(nodeRuns).values({
    id: 'nr_src',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
  })
  const { clarifyNodeRunId } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: 'nr_src',
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex: 0,
    questions: [makeQuestion()],
  })
  await submitClarifyAnswers({
    db,
    clarifyNodeRunId,
    answers: [makeAnswer()],
    directive: 'stop',
  })
}

describe("buildClarifyPromptContext: 'stop' directive is scoped to clarify-rerun only", () => {
  beforeEach(() => {
    resetBroadcastersForTests()
  })
  afterAll(() => {
    resetBroadcastersForTests()
  })

  test('default (applyLatestDirective omitted) still surfaces stop — preserves RFC-023 clarify-rerun semantics', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedStopAnsweredSession(db, taskId)

    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
    })

    expect(ctx).toBeDefined()
    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('User directive: STOP CLARIFYING')
  })

  test('applyLatestDirective=true (explicit) matches the default', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedStopAnsweredSession(db, taskId)

    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: true,
    })

    expect(ctx!.directive).toBe('stop')
    expect(ctx!.answersBlock).toContain('STOP CLARIFYING')
  })

  test('applyLatestDirective=false strips stop directive and trailer; Q&A body stays', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedStopAnsweredSession(db, taskId)

    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: false,
    })

    expect(ctx).toBeDefined()
    // ctx.directive must coerce back to 'continue' so the scheduler's
    // `effectiveHasClarifyChannel = … && directive !== 'stop'` evaluates to
    // true and the <workflow-clarify> protocol block is re-appended.
    expect(ctx!.directive).toBe('continue')
    // Neither directive trailer should appear — the rerun isn't a clarify
    // rerun and shouldn't be told what to do about clarifying.
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
    expect(ctx!.answersBlock).not.toContain('KEEP CLARIFYING')
    // But the underlying Q&A body MUST stay (the agent still needs the
    // historical context — review-iterate reruns answer NEW comments WITH
    // the old clarify Q&A in mind).
    expect(ctx!.questionsBlock).toContain('Which database?')
    expect(ctx!.answersBlock).toContain('Postgres')
  })

  test('multi-round: applyLatestDirective=false strips trailer from the LAST round, earlier rounds still rendered with their Round N headers', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedStopAnsweredSession(db, taskId)
    // Second round, also directive=stop, simulating the user's repeated
    // "just produce the output" preference. Round 2 = iterationIndex=1.
    await db.insert(nodeRuns).values({
      id: 'nr_src2',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 1,
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_src2',
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 1,
      questions: [makeQuestion()],
    })
    await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'stop',
    })

    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      applyLatestDirective: false,
    })

    expect(ctx!.directive).toBe('continue')
    expect(ctx!.answersBlock).not.toContain('STOP CLARIFYING')
    expect(ctx!.answersBlock).not.toContain('KEEP CLARIFYING')
    expect(ctx!.questionsBlock).toContain('### Round 1')
    expect(ctx!.questionsBlock).toContain('### Round 2')
  })
})
