// End-to-end scheduler tests for one task (P-1-14).
// Bypasses startTask's worktree creation by inserting the task row directly —
// real worktree creation is exercised in tasks.test.ts.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-sched-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(
  db: DbClient,
  name: string,
  outputs: string[] = ['summary'],
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<{ workflowId: string; taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify(inputs),
    startedAt: Date.now(),
  })
  return { workflowId, taskId }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('runTask: linear DAG (M1)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('input -> agent-single happy path', async () => {
    await seedAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'Req' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        { id: 'a1', kind: 'agent-single', agentName: 'auditor' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'out' },
          target: { nodeId: 'a1', portName: 'requirement' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { requirement: 'do the thing' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: 'nothing wrong' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const finalTask = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(finalTask?.status).toBe('done')
    expect(finalTask?.errorMessage).toBeNull()

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.length).toBe(2)
    expect(runs.find((r) => r.nodeId === 'in')?.status).toBe('done')
    expect(runs.find((r) => r.nodeId === 'a1')?.status).toBe('done')

    const a1 = runs.find((r) => r.nodeId === 'a1')
    const outputRows = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, a1?.id ?? ''))
    expect(outputRows.find((r) => r.portName === 'findings')?.content).toBe('nothing wrong')

    // Input node also persisted as a virtual run with its outputs.
    const inRun = runs.find((r) => r.nodeId === 'in')
    const inOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, inRun?.id ?? ''))
    expect(inOutputs[0]?.portName).toBe('out')
    expect(inOutputs[0]?.content).toBe('do the thing')
  })

  test('agent name unknown -> task fails with agent-not-found', async () => {
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'no-such-agent' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('no-such-agent')
    expect(t?.failedNodeId).toBe('a1')
  })

  test('multi-process / wrapper kinds rejected as M1 unsupported', async () => {
    await seedAgent(h.db, 'a')
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'm1', kind: 'agent-multi', agentName: 'a' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('M1 does not yet support agent-multi')
  })

  test('cycle in workflow -> task fails with cycle error', async () => {
    await seedAgent(h.db, 'a', ['out'])
    await seedAgent(h.db, 'b', ['out'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'a' },
        { id: 'b', kind: 'agent-single', agentName: 'b' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'x' },
        },
        {
          id: 'e2',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'a', portName: 'x' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toContain('cycle')
  })

  test('node runner failure halts task at that node', async () => {
    await seedAgent(h.db, 'broken', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a1', kind: 'agent-single', agentName: 'broken' }],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_EXIT_CODE: '5', MOCK_OPENCODE_SKIP_ENVELOPE: '1' }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.failedNodeId).toBe('a1')
    expect(t?.errorMessage).toContain('exited with code 5')
  })

  test('output nodes are skipped at run time (used by detail page)', async () => {
    await seedAgent(h.db, 'a', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'a' },
        {
          id: 'o',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'a', portName: 'summary' } }],
        },
      ],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)
    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // The output node did NOT create a node_run.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.find((r) => r.nodeId === 'o')).toBeUndefined()
    expect(runs.find((r) => r.nodeId === 'a')?.status).toBe('done')
  })

  test('multiple edges to same target port are concatenated', async () => {
    // Two input nodes both feed agent.requirement port. Scheduler should
    // concatenate them with the standard separator.
    await seedAgent(h.db, 'a', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [
        { kind: 'text', key: 'k1', label: 'k1' },
        { kind: 'text', key: 'k2', label: 'k2' },
      ],
      nodes: [
        { id: 'in1', kind: 'input', inputKey: 'k1' },
        { id: 'in2', kind: 'input', inputKey: 'k2' },
        { id: 'a', kind: 'agent-single', agentName: 'a' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in1', portName: 'out' },
          target: { nodeId: 'a', portName: 'requirement' },
        },
        {
          id: 'e2',
          source: { nodeId: 'in2', portName: 'out' },
          target: { nodeId: 'a', portName: 'requirement' },
        },
      ],
    }
    const { taskId } = await seedWorkflowAndTask(h, def, { k1: 'AAA', k2: 'BBB' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // The agent node's prompt should contain both inputs separated by ---.
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const aRun = runs.find((r) => r.nodeId === 'a')
    expect(aRun?.promptText).toContain('AAA')
    expect(aRun?.promptText).toContain('BBB')
    expect(aRun?.promptText).toContain('---')
  })
})
