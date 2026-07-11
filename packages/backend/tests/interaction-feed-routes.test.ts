// RFC-W002 - route test for GET /api/tasks/:id/interaction-feed. Locks the
// route wiring (200 shape + the four interaction kinds surface) and the
// visibility gate (missing task -> 404, mirroring "not found"). The pure
// aggregation contract itself is locked in packages/shared/tests/interaction-feed.test.ts;
// the full chronological scenario is locked in interaction-feed-scenario.test.ts.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const AUTH = { Authorization: `Bearer ${TOKEN}` }

const SNAPSHOT = JSON.stringify({
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'designer', kind: 'agent-single', title: 'Designer', agentName: 'agentA' },
    { id: 'coder', kind: 'agent-single', agentName: 'agentB' },
    { id: 'review', kind: 'review', title: 'Review' },
  ],
  edges: [],
  outputs: [],
})

function makeApp(db: DbClient): Hono {
  process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-if-home-'))
  return createApp({
    token: TOKEN,
    configPath: join(mkdtempSync(join(tmpdir(), 'aw-if-cfg-')), 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
}

async function seedTask(db: DbClient, taskId: string) {
  await db.insert(workflows).values({
    id: `wf-${taskId}`,
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    ownerUserId: '__system__',
    workflowId: `wf-${taskId}`,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: JSON.stringify({ requirement: 'build the feature' }),
    startedAt: 1000,
  })
}

async function seedDoneRun(
  db: DbClient,
  taskId: string,
  id: string,
  nodeId: string,
  finishedAt: number,
  port: string,
  content: string,
) {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    iteration: 0,
    startedAt: finishedAt - 50,
    finishedAt,
  })
  await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: port, content })
}

async function seedAnsweredClarify(db: DbClient, taskId: string) {
  await db.insert(nodeRuns).values({
    id: `${taskId}-ask`,
    taskId,
    nodeId: 'coder',
    status: 'done',
    iteration: 0,
  })
  await db.insert(nodeRuns).values({
    id: `${taskId}-int`,
    taskId,
    nodeId: 'clar',
    status: 'done',
    iteration: 0,
  })
  await db.insert(clarifyRounds).values({
    id: `${taskId}-r`,
    taskId,
    kind: 'self',
    askingNodeId: 'coder',
    askingNodeRunId: `${taskId}-ask`,
    intermediaryNodeId: 'clar',
    intermediaryNodeRunId: `${taskId}-int`,
    questionsJson: JSON.stringify([
      {
        id: 'q1',
        title: 'Which framework?',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'React', description: '', recommended: false, recommendationReason: '' },
          { label: 'Vue', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ]),
    answersJson: JSON.stringify([
      {
        questionId: 'q1',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['React'],
        customText: '',
      },
    ]),
    status: 'answered',
    createdAt: 3000,
    answeredAt: 4000,
  })
}

async function seedReviewDecision(db: DbClient, taskId: string) {
  await db.insert(nodeRuns).values({
    id: `${taskId}-rev`,
    taskId,
    nodeId: 'review',
    status: 'done',
    iteration: 0,
  })
  await db.insert(docVersions).values({
    id: `${taskId}-dv`,
    taskId,
    reviewNodeId: 'review',
    reviewNodeRunId: `${taskId}-rev`,
    sourceNodeId: 'designer',
    sourcePortName: 'design',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'review/body.md',
    decision: 'rejected',
    decisionReason: 'needs tests',
    decidedAt: 9000,
  })
  await db.insert(reviewComments).values({
    id: `${taskId}-rc`,
    docVersionId: `${taskId}-dv`,
    anchorSectionPath: '/',
    anchorParagraphIdx: 0,
    anchorOffsetStart: 0,
    anchorOffsetEnd: 3,
    selectedText: 'foo',
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex: 0,
    commentText: 'fix this',
    author: 'alice',
  })
}

describe('RFC-W002 /api/tasks/:id/interaction-feed routes', () => {
  test('GET 200 returns items with all four interaction kinds + shape', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    await seedTask(db, 'task-a')
    await seedDoneRun(db, 'task-a', 'task-a-runA', 'designer', 2000, 'design', '# plan v1')
    await seedAnsweredClarify(db, 'task-a')
    await seedReviewDecision(db, 'task-a')

    const res = await app.request('/api/tasks/task-a/interaction-feed', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; kind: string }>
      total: number
      truncated: boolean
    }
    expect(body.truncated).toBe(false)
    expect(body.total).toBe(body.items.length)
    const kinds = body.items.map((i) => i.kind)
    expect(kinds).toEqual(
      expect.arrayContaining([
        'human_input',
        'node_output',
        'clarify_question',
        'clarify_answer',
        'review_decision',
      ]),
    )
    // chronological: human_input (1000) < node_output (2000) < question (3000) < answer (4000) < review (9000)
    expect(kinds).toEqual([
      'human_input',
      'node_output',
      'clarify_question',
      'clarify_answer',
      'review_decision',
    ])
  })

  test('missing task -> 404', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    const res = await app.request('/api/tasks/nope/interaction-feed', { headers: AUTH })
    expect(res.status).toBe(404)
  })

  test('empty task (no interactions yet) -> 200 with at most the human_input item', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    await seedTask(db, 'task-empty')
    const res = await app.request('/api/tasks/task-empty/interaction-feed', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ kind: string }>; total: number }
    // task has inputs -> exactly the human_input item
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.kind).toBe('human_input')
  })
})
