// RFC-W004 T8 - runtime stub guard: a dispatched clarify-to-agent node FAILS
// with `to-agent-runtime-not-implemented` instead of running half-baked.
//
// PR-1 ships the editor surface (draw / configure / save a to-agent node) but
// NOT the runtime (B->A->B data flow lands in PR-2 via services/toAgentClarify.ts).
// This guard makes a saved-but-unrunnable to-agent workflow surface a CLEAR
// failure at execution time rather than silently parking / no-op'ing. Mirrors
// RFC-167 PR-1's workgroup-dynamic-not-implemented shape (since removed once
// that runtime landed - this guard is likewise removed in PR-2).
//
// LOCKS:
//   1. Source: scheduler.ts contains the `to-agent-runtime-not-implemented`
//      dispatch branch keyed on `node.kind === 'clarify-to-agent'`.
//   2. Behavioral: runOneNode(to-agent) returns { kind: 'failed', message:
//      'to-agent-runtime-not-implemented' } (the guard fires, not a silent ok).
//   3. Saving is NOT blocked: a valid to-agent workflow validates ok=true
//      (the runtime code is scheduler-only; the validator never emits it).

import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runOneNode, type RunTaskOptions } from '../src/services/scheduler'
import { validateWorkflowDef } from '../src/services/workflow.validator'
import { Semaphore } from '@/util/semaphore'
import type { Logger } from '@/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_TS = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

const NOOP_LOG: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOG,
}

const answererAgent: Agent = {
  id: 'agent-answerer',
  name: 'answerer',
  description: '',
  outputs: ['result'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}
const questionerAgent: Agent = {
  ...answererAgent,
  id: 'agent-questioner',
  name: 'questioner',
  outputs: ['main'],
}

const toAgentNode = { id: 'ta1', kind: 'clarify-to-agent' } as WorkflowNode

function validToAgentWorkflow(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'A', kind: 'agent-single', agentName: 'answerer' },
      { id: 'B', kind: 'agent-single', agentName: 'questioner' },
      { id: 'ta1', kind: 'clarify-to-agent' },
    ],
    edges: [
      {
        id: 'e_A_B',
        source: { nodeId: 'A', portName: 'result' },
        target: { nodeId: 'B', portName: 'main' },
      },
      {
        id: 'e_B_ta1',
        source: { nodeId: 'B', portName: '__clarify__' },
        target: { nodeId: 'ta1', portName: 'questions' },
      },
      {
        id: 'e_ta1_B',
        source: { nodeId: 'ta1', portName: 'to_questioner' },
        target: { nodeId: 'B', portName: '__clarify_response__' },
      },
      {
        id: 'e_ta1_A',
        source: { nodeId: 'ta1', portName: 'to_answerer' },
        target: { nodeId: 'A', portName: '__clarify_request__' },
      },
    ],
  }
}

describe('RFC-W004 T8 - to-agent runtime stub guard', () => {
  test('source: scheduler dispatches clarify-to-agent to to-agent-runtime-not-implemented', () => {
    const src = readFileSync(SCHEDULER_TS, 'utf-8')
    expect(src).toContain("node.kind === 'clarify-to-agent'")
    expect(src).toContain("'to-agent-runtime-not-implemented'")
  })

  test('behavioral: runOneNode(to-agent) fails with to-agent-runtime-not-implemented (guard fires, not silent ok)', async () => {
    // Build a minimal SchedulerState. The to-agent branch returns immediately
    // (no git / process spawn), so a fake repoPath + stub task row suffice -
    // the to-agent dispatch must fail BEFORE touching any runtime infra.
    const db = createInMemoryDb(MIGRATIONS)
    const workflowId = 'wf-stub'
    await db.insert(workflows).values({
      id: workflowId,
      name: 'stub-guard',
      description: '',
      definition: JSON.stringify(validToAgentWorkflow()),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: 't-stub',
      name: 'stub-guard',
      workflowId,
      workflowSnapshot: JSON.stringify(validToAgentWorkflow()),
      repoPath: '/tmp/fake-repo',
      worktreePath: '/tmp/fake-repo',
      baseBranch: 'main',
      branch: 'agent-workflow/t-stub',
      status: 'running',
      inputs: '{}',
      startedAt: 1_700_000_000_000,
    })
    // The to-agent branch returns before reading `task`, so a stub row
    // suffices (no git, no process spawn). We still insert a real task row
    // for realism, but pass a minimal stub into state.
    const opts: RunTaskOptions = { taskId: 't-stub', db, appHome: '/tmp/fake-apphome' }
    const state = {
      db,
      task: { id: 't-stub' } as never,
      taskId: 't-stub',
      definition: validToAgentWorkflow(),
      opts,
      log: NOOP_LOG,
      inputsMap: {} as Record<string, string>,
      globalSem: new Semaphore(4),
      writeSem: new Semaphore(4),
      subprocessSem: new Semaphore(4),
      containerOf: new Map<string, string>(),
      topLevelIds: new Set<string>(['ta1']),
      repos: [
        {
          repoPath: '/tmp/fake-repo',
          worktreePath: '/tmp/fake-repo',
          worktreeDirName: '',
          baseBranch: 'main',
        },
      ],
    }
    const result = await runOneNode(state as never, {
      node: toAgentNode,
      iteration: 0,
      log: NOOP_LOG,
    })
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('unreachable')
    expect(result.message).toBe('to-agent-runtime-not-implemented')
    expect(result.summary).toContain('clarify-to-agent')
    expect(result.summary).toContain('RFC-W004 PR-2')
  })

  test('saving is NOT blocked: a valid to-agent workflow validates ok=true (runtime code is scheduler-only)', () => {
    const res = validateWorkflowDef(validToAgentWorkflow(), {
      agents: [answererAgent, questionerAgent],
      skills: [],
    })
    expect(res.ok).toBe(true)
    expect(res.issues.map((i) => i.code)).not.toContain('to-agent-runtime-not-implemented')
  })
})
