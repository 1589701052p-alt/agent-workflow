// RFC-056 patch-2026-05-27 (questioner-cutoff-uses-cci) — regression test
// pack locking in the integration-side fix.
//
// Bug: after a cross-clarify questioner had already produced a captured
// <workflow-output> envelope, any subsequent rerun (review-iterate,
// downstream cascade, etc.) re-injected the same Q&A round into the
// prompt. The unified helper `applyAgingCutoff` was correct (see
// clarify-rounds-service.test.ts:644 "cross-questioner aging fix") but
// scheduler.ts always called `computeHistoryCutoff` with
// `iterationField: 'clarifyIteration'`. clarify_rounds rows of kind='cross'
// store the cross-clarify session iteration (= the questioner run's
// clarifyIteration), not clarifyIteration, so the cutoff lived in
// the wrong unit and `applyAgingCutoff(cutoff=0)` kept the iter=0 round
// every time.
//
// What this file locks:
//   1. Integration-style: seed a questioner with a prior cci=1 done
//      run that has node_run_outputs (markdown produced), plus an
//      iter=0 answered cross round. `computeHistoryCutoff` called
//      with iterationField='clarifyIteration' (what scheduler.ts
//      now passes for the cross-questioner branch) returns 1, and
//      `buildPromptContext` correctly drops the iter=0 round →
//      `ctx === undefined` (nothing to re-inject).
//   2. Source-text guard on scheduler.ts: it must hand the
//      clarifyIteration field into computeHistoryCutoff on the
//      questioner branch (regression would silently revert the fix).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { buildPromptContext, computeHistoryCutoff } from '../src/services/clarifyRounds'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKEND_SRC = join(__dirname, '..', 'src', 'services')

async function seedTask(db: DbClient): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
      { id: 'cc1', kind: 'clarify-cross-agent', title: 'CC1' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'cutoff-cci-test',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'cutoff-cci-test',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-cutoff-cci/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function questionsJson(): string {
  return JSON.stringify([
    {
      id: 'q1',
      title: 'should-be-archived-after-output',
      kind: 'single',
      recommended: false,
      options: [
        { label: 'A', description: '', recommended: false, recommendationReason: '' },
        { label: 'B', description: '', recommended: false, recommendationReason: '' },
      ],
    },
  ])
}

function answersJson(): string {
  return JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['A'],
      customText: '',
    },
  ])
}

describe('RFC-056 patch-2026-05-27 questioner cutoff uses cci', () => {
  test('once questioner produced markdown output at cci=1, a later rerun (cci=1, e.g. review-iterate) does not re-inject the iter=0 Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)

    // RFC-064: under the unified counter, the prior questioner's
    // post-submit row sits at clarifyIteration=1 (was crossClarifyIteration=1
    // pre-RFC-064). The clarify_rounds row's `iteration=0` is the round's
    // own counter — independent of node_runs.clarifyIteration. The aging
    // cutoff should still drop the iter=0 round once the questioner's
    // clarifyIteration=1 done row has outputs.
    const priorQuestionerRunId = 'nr_q_prior_cci1'
    await db.insert(nodeRuns).values({
      id: priorQuestionerRunId,
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 1,
      startedAt: Date.now() - 2000,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: priorQuestionerRunId,
      portName: 'doc',
      content: 'questioner produced final markdown here',
    })

    // 2) The cross-clarify session that gave rise to that output —
    //    answered iter=0 cross round.
    const crossClarifyNodeRunId = 'nr_cc1_iter0'
    await db.insert(nodeRuns).values({
      id: crossClarifyNodeRunId,
      taskId,
      nodeId: 'cc1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    await db.insert(clarifyRounds).values({
      id: 'round_cross_iter0',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: priorQuestionerRunId,
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: crossClarifyNodeRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson(),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })

    // 3) The about-to-run questioner row (e.g. minted by review-iterate)
    //    inherits clarifyIteration=1, retry_index bumped.
    const currentRunId = 'nr_q_current_cci1_ri1'
    await db.insert(nodeRuns).values({
      id: currentRunId,
      taskId,
      nodeId: 'questioner',
      status: 'pending',
      retryIndex: 1,
      iteration: 0,
      clarifyIteration: 1,
    })
    const currentRun = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, currentRunId)))[0]!

    // RFC-064: post-unification, computeHistoryCutoff returns the prior
    // done's unified clarifyIteration directly. With the prior questioner
    // at clarifyIteration=1, the cutoff is 1 and the iter=0 cross round
    // gets filtered by applyAgingCutoff (0 < 1).
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'questioner',
      currentRunRow: currentRun,
      shardKey: null,
    })
    expect(cutoff).toBe(1)
    const fixedCutoff = cutoff
    const ctxAfterFix = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
      historyCutoff: fixedCutoff,
      loopIter: 0,
    })
    expect(ctxAfterFix).toBeUndefined()
  })

  // RFC-064: patch-2026-05-27's intent (cutoff uses the right counter for
  // the cross-questioner branch) is preserved structurally — the unified
  // clarifyIteration is the only counter, so the `iterationField` parameter
  // was removed entirely. We lock the surviving contract: scheduler still
  // computes `isQuestionerCrossClarifyRerun` and calls computeHistoryCutoff
  // without an explicit field-picker (the helper hard-codes clarifyIteration).
  test('scheduler.ts cross-questioner branch invokes computeHistoryCutoff under unified clarifyIteration', () => {
    const src = readFileSync(join(BACKEND_SRC, 'scheduler.ts'), 'utf8')
    expect(src).toContain('isQuestionerCrossClarifyRerun')
    // `iterationField` parameter must NOT exist anywhere; the unified
    // counter removed it.
    expect(src).not.toMatch(/iterationField\s*:/)
  })
})
