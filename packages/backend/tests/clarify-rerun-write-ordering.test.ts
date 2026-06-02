// RFC-076 PR-0 (T0) — clarify rerun write-ordering (torn-read safety).
//
// WHY THIS FILE EXISTS (regression intent):
//   submitClarifyAnswers writes TWO node_runs rows for one logical event:
//   (1) the source-agent rerun `pending` insert, and (2) the clarify node_run
//   flip awaiting_human→done. With the flip FIRST (the pre-PR-0 order) a reader
//   landing between them — and the rollbackToSnapshot git-subprocess yields the
//   event loop for ~100s of ms right there — observes "clarify done, rerun
//   absent". A dispatch frontier derived from node_runs at that instant judges
//   the agent's prior done row still freshest ⇒ scope allSettled ⇒ FALSE
//   COMPLETION, silently dropping the rerun. (Wrapping the two writes in
//   db.transaction does NOT help: bun:sqlite's transaction is synchronous, so an
//   async body COMMITs at its first real `await`, leaving post-await writes
//   outside the tx — verified empirically.)
//
//   Fix: mint the rerun BEFORE flipping clarify→done. The rerun row's fields all
//   come from sourceRunRow (incl. its ORIGINAL preSnapshot, independent of the
//   rollback), so the reorder is data-safe. The only intermediate state a reader
//   can then observe is "clarify still awaiting + rerun present" — a safe,
//   non-completing frontier.
//
//   Test 1 (functional): the reorder did not break the happy path — answering a
//   self-clarify still produces exactly one pending rerun + a done clarify row.
//   Test 2 (source-ordering guard): the rerun `insert(nodeRuns)` lexically
//   precedes the `resume-clarify` transition in clarify.ts. If a refactor flips
//   the order back, this goes red — the runtime torn window is invisible to a
//   post-hoc state assertion, so the source guard is the load-bearing lock.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
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
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
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
    repoPath: '/tmp/aw-t0-ordering',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-076 PR-0 — clarify rerun write-ordering', () => {
  test('functional: answering a self-clarify yields exactly one pending rerun + a done clarify row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, selfClarifyDef())

    // Source agent run (done, with a pre-snapshot to also exercise the rollback path —
    // worktreePath '' makes rollback a no-op, keeping the test hermetic).
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
      directive: 'continue',
    })

    // Clarify node row is done.
    const clarifyRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, sess.clarifyNodeRunId)).limit(1)
    )[0]
    expect(clarifyRow?.status).toBe('done')

    // Exactly one fresh pending rerun on the source agent.
    const agentRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'agent_x')))
    const pending = agentRows.filter((r) => r.status === 'pending')
    expect(pending.length).toBe(1)
    expect(pending[0]!.iteration).toBe(0)
    // The prior done row is left untouched as history.
    expect(agentRows.find((r) => r.id === agentRunId)?.status).toBe('done')
  })

  test('source-ordering guard: rerun insert precedes the resume-clarify (done) transition', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'clarify.ts'),
      'utf8',
    )
    // The rerun mint: db.insert(nodeRuns) ... status: 'pending' with rerunNodeRunId.
    const rerunInsertIdx = src.indexOf('id: rerunNodeRunId,')
    // The clarify→done flip: transitionNodeRunStatus with the resume-clarify event.
    const flipIdx = src.indexOf("kind: 'resume-clarify'")
    expect(rerunInsertIdx).toBeGreaterThan(0)
    expect(flipIdx).toBeGreaterThan(0)
    // T0 invariant: the rerun must be minted BEFORE clarify is flipped to done.
    expect(rerunInsertIdx).toBeLessThan(flipIdx)
  })
})
