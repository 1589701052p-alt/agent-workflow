// Regression lock for the "node-level model override silently dropped" bug.
//
// Pre-fix the canvas inspector saved `node.overrides.{model,variant,temperature}`
// onto every agent-single / agent-multi node, but services/scheduler.ts never
// read that field — both runNode() call sites omitted `overrides`. The runner
// accepted the field as dead code, so opencode always saw the agent's default
// model (and per-node tweaks were effectively a no-op).
//
// These tests assert the value the user typed in the inspector survives the
// scheduler → runner → env-var → subprocess hop. The mock-opencode writes one
// JSONL line per spawn into MOCK_OPENCODE_CAPTURE_CONFIG_TO; we read it back
// and compare against expectations.
//
// If a future refactor drops the override on the floor again, these tests go
// red — the captured `model` will fall back to agent's default (or undefined).

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  capturePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-override-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const capturePath = join(appHome, 'inline-config.jsonl')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    capturePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgentWithDefaults(
  db: DbClient,
  name: string,
  outputs: string[],
  defaults: { model?: string; variant?: string; temperature?: number },
): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    model: defaults.model ?? null,
    variant: defaults.variant ?? null,
    temperature: defaults.temperature ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
  inputs: Record<string, string> = {},
): Promise<string> {
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
    name: 'fixture-task',

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
  return taskId
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

function readCapture(path: string): Array<{
  agent: string
  model: string | null
  variant: string | null
  temperature: number | null
}> {
  const text = readFileSync(path, 'utf-8')
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe('scheduler forwards node-level overrides to runner', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('agent-single: node.overrides.model wins over agent default model', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        {
          id: 'w1',
          kind: 'agent-single',
          agentName: 'writer',
          // The exact shape the canvas inspector persists.
          overrides: {
            model: 'anthropic/claude-opus-4-7',
            variant: 'high',
            temperature: 0.4,
          },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
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

    const rows = readCapture(h.capturePath)
    expect(rows.length).toBe(1)
    expect(rows[0]).toEqual({
      agent: 'writer',
      model: 'anthropic/claude-opus-4-7',
      variant: 'high',
      temperature: 0.4,
    })
  })

  test('agent-single: missing overrides falls back to agent defaults (no regression)', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
      variant: 'low',
      temperature: 0.1,
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        // No `overrides` field at all — agent defaults must come through.
        { id: 'w1', kind: 'agent-single', agentName: 'writer' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const rows = readCapture(h.capturePath)
    expect(rows.length).toBe(1)
    expect(rows[0]).toEqual({
      agent: 'writer',
      model: 'anthropic/claude-haiku-4-5',
      variant: 'low',
      temperature: 0.1,
    })
  })

  test('agent-single: empty-string overrides are ignored (treated as cleared)', async () => {
    await seedAgentWithDefaults(h.db, 'writer', ['summary'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        {
          id: 'w1',
          kind: 'agent-single',
          agentName: 'writer',
          // Inspector writes '' when the user clears the field; the runner
          // would otherwise reject empty model strings — the scheduler must
          // drop them so agent defaults apply.
          overrides: { model: '', variant: '' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'w1', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'do it' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        }),
    )

    const rows = readCapture(h.capturePath)
    expect(rows[0]?.model).toBe('anthropic/claude-haiku-4-5')
  })

  test('agent-multi (fan-out): every shard child receives the override', async () => {
    await seedAgentWithDefaults(h.db, 'src', ['git_diff'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    await seedAgentWithDefaults(h.db, 'auditor', ['findings'], {
      model: 'anthropic/claude-haiku-4-5',
    })
    const TWO_FILE_DIFF = [
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -1 +1 @@',
      '-1',
      '+1',
      'diff --git a/src/b.ts b/src/b.ts',
      '@@ -1 +1 @@',
      '-2',
      '+2',
    ].join('\n')

    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
      nodes: [
        { id: 'in', kind: 'input', inputKey: 'requirement' },
        { id: 'src', kind: 'agent-single', agentName: 'src' },
        {
          id: 'audit',
          kind: 'agent-multi',
          agentName: 'auditor',
          sourcePort: { nodeId: 'src', portName: 'git_diff' },
          overrides: { model: 'anthropic/claude-opus-4-7' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'in', portName: 'requirement' },
          target: { nodeId: 'src', portName: 'requirement' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def, { requirement: 'audit' })

    await withEnv(
      {
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({
          git_diff: TWO_FILE_DIFF,
          findings: 'noted',
        }),
        MOCK_OPENCODE_CAPTURE_CONFIG_TO: h.capturePath,
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

    const rows = readCapture(h.capturePath)
    // 1 src + 2 audit shards = 3 spawns.
    const srcRow = rows.find((r) => r.agent === 'src')
    const auditRows = rows.filter((r) => r.agent === 'auditor')
    expect(srcRow?.model).toBe('anthropic/claude-haiku-4-5') // src node has no override
    expect(auditRows.length).toBe(2)
    for (const r of auditRows) {
      expect(r.model).toBe('anthropic/claude-opus-4-7')
    }
  })
})
