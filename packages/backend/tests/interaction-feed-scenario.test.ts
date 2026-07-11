// RFC-W002 - end-to-end integration test for the interaction-feed route. Locks
// the full chronological scenario from the RFC proposal: human requirement ->
// agent A design -> agent B clarify -> human answer -> agent A 2nd design ->
// review decision. Asserts the feed surfaces all six as distinct items in
// (ts, sortId) order. The pure mapping is locked in interaction-feed.test.ts;
// this locks the route wiring + DB reads end-to-end.

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
  process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-if-scen-home-'))
  return createApp({
    token: TOKEN,
    configPath: join(mkdtempSync(join(tmpdir(), 'aw-if-scen-cfg-')), 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
}

async function seedScenario(db: DbClient) {
  await db.insert(workflows).values({
    id: 'wf-1',
    name: 'wf',
    definition: '{}',
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: 'task-1',
    name: 'scenario',
    ownerUserId: '__system__',
    workflowId: 'wf-1',
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: JSON.stringify({ requirement: 'build the feature' }),
    startedAt: 1000,
  })

  // t=2000: agent A first design (runA, done, output design v1)
  await db.insert(nodeRuns).values({
    id: 'runA',
    taskId: 'task-1',
    nodeId: 'designer',
    status: 'done',
    iteration: 0,
    startedAt: 1900,
    finishedAt: 2000,
  })
  await db.insert(nodeRunOutputs).values({ nodeRunId: 'runA', portName: 'design', content: '# v1' })

  // t=3000: agent B clarify round (created) + t=4000: human answer
  await db.insert(nodeRuns).values({
    id: 'coder-ask',
    taskId: 'task-1',
    nodeId: 'coder',
    status: 'done',
    iteration: 0,
  })
  await db.insert(nodeRuns).values({
    id: 'clar-run',
    taskId: 'task-1',
    nodeId: 'clar',
    status: 'done',
    iteration: 0,
  })
  await db.insert(clarifyRounds).values({
    id: 'round1',
    taskId: 'task-1',
    kind: 'self',
    askingNodeId: 'coder',
    askingNodeRunId: 'coder-ask',
    intermediaryNodeId: 'clar',
    intermediaryNodeRunId: 'clar-run',
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

  // t=5000: agent A second design (runA2, done, output design v2) - the rerun
  // after the clarify answer. Same nodeId 'designer', different run id.
  await db.insert(nodeRuns).values({
    id: 'runA2',
    taskId: 'task-1',
    nodeId: 'designer',
    status: 'done',
    iteration: 0,
    startedAt: 4900,
    finishedAt: 5000,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: 'runA2', portName: 'design', content: '# v2' })

  // t=9000: review decision (rejected) on the designer's output
  await db.insert(nodeRuns).values({
    id: 'rev-run',
    taskId: 'task-1',
    nodeId: 'review',
    status: 'done',
    iteration: 0,
  })
  await db.insert(docVersions).values({
    id: 'dv1',
    taskId: 'task-1',
    reviewNodeId: 'review',
    reviewNodeRunId: 'rev-run',
    sourceNodeId: 'designer',
    sourcePortName: 'design',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'review/body.md',
    decision: 'rejected',
    decisionReason: 'needs tests',
    decidedAt: 9000,
  })
}

describe('RFC-W002 interaction-feed scenario: input -> A -> B clarify -> answer -> A2 -> review', () => {
  test('surfaces all six interactions in chronological order', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = makeApp(db)
    await seedScenario(db)

    const res = await app.request('/api/tasks/task-1/interaction-feed', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ id: string; kind: string; ts: number; nodeName?: string }>
      total: number
      truncated: boolean
    }
    expect(body.truncated).toBe(false)
    expect(body.total).toBe(6)
    expect(body.items.map((i) => i.kind)).toEqual([
      'human_input', // 1000
      'node_output', // 2000 (runA)
      'clarify_question', // 3000
      'clarify_answer', // 4000
      'node_output', // 5000 (runA2)
      'review_decision', // 9000
    ])
    // the two node_output items are distinct runs (A then A2)
    const outputs = body.items.filter((i) => i.kind === 'node_output')
    expect(outputs.map((i) => i.id)).toEqual(['output:runA', 'output:runA2'])
    // node names resolved from the snapshot (title wins)
    expect(body.items[1]!.nodeName).toBe('Designer')
    expect(body.items[2]!.nodeName).toBe('agentB') // coder has no title -> agentName
  })
})
