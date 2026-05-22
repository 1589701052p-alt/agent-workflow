// RFC-056 patch 2026-05-22 — Layer A.5 questioner Q&A injection lock.
//
// The original RFC-056 PR-B implementation never built a prompt context for
// the questioner's cross-clarify rerun. The scheduler routed all "this is
// a clarify rerun" prompt assembly through `buildClarifyPromptContext` which
// only reads `clarify_sessions` (self-clarify). For a questioner that had
// asked back via cross-clarify, this returned undefined — the rerun
// dispatched with NO record of the prior Q&A in the prompt, so the agent
// re-emitted the same `<workflow-clarify>` envelope and the workflow
// looped forever / failed at the next downstream review.
//
// This test locks the FIX:
//   buildQuestionerCrossClarifyContext reads from `cross_clarify_sessions`
//   WHERE source_questioner_node_id = the about-to-rerun questioner. It
//   returns a ClarifyPromptContext (same shape as RFC-023 self-clarify) so
//   the renderer's `## Clarify Q&A` machinery works verbatim — the agent
//   sees its own questions + the designer-side answers + the standing
//   directive (continue → ask-bias preamble; stop → STOP CLARIFYING).
//
// If this test goes red the cross-clarify questioner prompt assembly path
// drifted — investigate before relaxing. Production failure shape if this
// is broken: questioner reruns forever asking the same questions.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { ClarifyAnswer, ClarifyQuestion } from '@agent-workflow/shared'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { buildQuestionerCrossClarifyContext } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: true, recommendationReason: 'default' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string, idx: number): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [idx],
    selectedOptionLabels: idx === 0 ? ['Postgres'] : ['MySQL'],
    customText: '',
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 't',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'qc',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/qc',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedNodeRun(db: DbClient, taskId: string, nodeId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  return id
}

async function seedAnsweredSession(
  db: DbClient,
  taskId: string,
  iteration: number,
  directive: 'continue' | 'stop',
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  questionerNodeId = 'questioner',
): Promise<void> {
  const crossNodeRunId = await seedNodeRun(db, taskId, 'cross1')
  const questionerNodeRunId = await seedNodeRun(db, taskId, questionerNodeId)
  await db.insert(crossClarifySessions).values({
    id: ulid(),
    taskId,
    crossClarifyNodeId: 'cross1',
    crossClarifyNodeRunId: crossNodeRunId,
    sourceQuestionerNodeId: questionerNodeId,
    sourceQuestionerNodeRunId: questionerNodeRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    iteration,
    questionsJson: JSON.stringify(questions),
    answersJson: JSON.stringify(answers),
    directive,
    status: 'answered',
    answeredAt: Date.now(),
  })
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 Layer A.5 — buildQuestionerCrossClarifyContext', () => {
  test('targetCrossClarifyIteration <= 0 → undefined (first ever questioner run has no history)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 0,
    })
    expect(ctx).toBeUndefined()
  })

  test('no answered sessions for this questioner → undefined (questioner has not been through cross-clarify)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Seed a session for a DIFFERENT questioner — must not match.
    const q1 = [makeQ('q1', 'pick DB')]
    const a1 = [makeAns('q1', 0)]
    await seedAnsweredSession(db, taskId, 0, 'continue', q1, a1, 'someoneElse')

    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 1,
    })
    expect(ctx).toBeUndefined()
  })

  test('single answered session → ClarifyPromptContext with Round 1 Q + A + directive=continue', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const q1 = [makeQ('q1', 'pick DB')]
    const a1 = [makeAns('q1', 0)]
    await seedAnsweredSession(db, taskId, 0, 'continue', q1, a1)

    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 1,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) return
    expect(ctx.questionsBlock).toContain('### Round 1')
    expect(ctx.questionsBlock).toContain('pick DB')
    expect(ctx.answersBlock).toContain('### Round 1')
    expect(ctx.answersBlock).toContain('Postgres')
    expect(ctx.iteration).toBe('1')
    expect(ctx.directive).toBe('continue')
  })

  test('multi-round history → rounds in ascending order, latest directive surfaced', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Round 1: continue
    await seedAnsweredSession(
      db,
      taskId,
      0,
      'continue',
      [makeQ('q1', 'pick DB')],
      [makeAns('q1', 0)],
    )
    // Round 2: stop (user wants to end clarification)
    await seedAnsweredSession(db, taskId, 1, 'stop', [makeQ('q2', 'pick ORM')], [makeAns('q2', 1)])

    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 2,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) return
    // Rounds appear in ascending order: 1 before 2 in the rendered blocks.
    const round1Idx = ctx.questionsBlock?.indexOf('### Round 1') ?? -1
    const round2Idx = ctx.questionsBlock?.indexOf('### Round 2') ?? -1
    expect(round1Idx).toBeGreaterThan(-1)
    expect(round2Idx).toBeGreaterThan(round1Idx)
    // Latest directive overrides — `stop` from round 2 propagates so the
    // renderer can attach the STOP CLARIFYING trailer.
    expect(ctx.directive).toBe('stop')
  })

  test('only `status=answered` sessions surface — `awaiting_human` / `abandoned` are skipped', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // 1 answered (will surface)
    await seedAnsweredSession(
      db,
      taskId,
      0,
      'continue',
      [makeQ('q1', 'answered question')],
      [makeAns('q1', 0)],
    )

    // 1 awaiting_human (in-flight — must NOT surface)
    const xCrossRun = await seedNodeRun(db, taskId, 'cross1')
    const xQuestionerRun = await seedNodeRun(db, taskId, 'questioner')
    await db.insert(crossClarifySessions).values({
      id: ulid(),
      taskId,
      crossClarifyNodeId: 'cross1',
      crossClarifyNodeRunId: xCrossRun,
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: xQuestionerRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 1,
      questionsJson: JSON.stringify([makeQ('qX', 'in-flight question')]),
      answersJson: null,
      directive: null,
      status: 'awaiting_human',
    })

    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 1,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) return
    expect(ctx.questionsBlock).toContain('answered question')
    expect(ctx.questionsBlock).not.toContain('in-flight question')
  })

  test('returns the SAME ClarifyPromptContext shape as buildClarifyPromptContext (self-clarify path drop-in)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedAnsweredSession(
      db,
      taskId,
      0,
      'continue',
      [makeQ('q1', 'shape compat check')],
      [makeAns('q1', 0)],
    )
    const ctx = await buildQuestionerCrossClarifyContext({
      db,
      taskId,
      questionerNodeId: 'questioner',
      targetCrossClarifyIteration: 1,
    })
    expect(ctx).toBeDefined()
    if (ctx === undefined) return
    // The renderer in shared/prompt.ts treats these field names as the
    // contract. Locking them here prevents accidental rename divergence
    // between the two builders.
    expect(typeof ctx.questionsBlock).toBe('string')
    expect(typeof ctx.answersBlock).toBe('string')
    expect(typeof ctx.iteration).toBe('string')
    expect(typeof ctx.directive).toBe('string')
    expect(ctx.directive === 'continue' || ctx.directive === 'stop').toBe(true)
  })
})
