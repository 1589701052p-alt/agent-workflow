// RFC-037 — locks the task.name + StartTaskSchema trim/length/required contract.
//
// Why this file exists: future refactors that touch `TaskNameSchema` or
// `StartTaskSchema.name` must keep these invariants (especially the trim
// semantic and the 1..255 inclusive bounds) — they are the same contract the
// backend route, launcher form, and multipart parser all assume.

import { describe, expect, test } from 'bun:test'
import {
  StartTaskSchema,
  TaskNameSchema,
  TASK_NAME_MAX,
  TaskSchema,
  TaskSummarySchema,
} from '../src/schemas/task'

describe('TaskNameSchema', () => {
  test('accepts a normal name and returns it unchanged', () => {
    const r = TaskNameSchema.safeParse('PR-1234 fix pagination')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('PR-1234 fix pagination')
  })

  test('trims surrounding whitespace', () => {
    const r = TaskNameSchema.safeParse('   hello   ')
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toBe('hello')
  })

  test('rejects empty string', () => {
    expect(TaskNameSchema.safeParse('').success).toBe(false)
  })

  test('rejects whitespace-only string (after trim)', () => {
    expect(TaskNameSchema.safeParse('     ').success).toBe(false)
    expect(TaskNameSchema.safeParse('\t\n').success).toBe(false)
  })

  test('accepts exactly 255 chars', () => {
    const s = 'x'.repeat(TASK_NAME_MAX)
    const r = TaskNameSchema.safeParse(s)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.length).toBe(TASK_NAME_MAX)
  })

  test('rejects 256 chars', () => {
    expect(TaskNameSchema.safeParse('x'.repeat(TASK_NAME_MAX + 1)).success).toBe(false)
  })

  test('exposes constant for callers (frontend maxLength prop)', () => {
    expect(TASK_NAME_MAX).toBe(255)
  })
})

describe('StartTaskSchema name field', () => {
  const base = { workflowId: 'wf-1', repoPath: '/tmp/repo', baseBranch: 'main' }

  test('rejects missing name', () => {
    const r = StartTaskSchema.safeParse(base as unknown)
    expect(r.success).toBe(false)
  })

  test('rejects empty name', () => {
    const r = StartTaskSchema.safeParse({ ...base, name: '' })
    expect(r.success).toBe(false)
  })

  test('rejects whitespace-only name', () => {
    const r = StartTaskSchema.safeParse({ ...base, name: '   ' })
    expect(r.success).toBe(false)
  })

  test('accepts valid name and trims it', () => {
    const r = StartTaskSchema.safeParse({ ...base, name: '  hello  ' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.name).toBe('hello')
  })

  test('rejects overlong name', () => {
    const r = StartTaskSchema.safeParse({ ...base, name: 'x'.repeat(TASK_NAME_MAX + 1) })
    expect(r.success).toBe(false)
  })
})

describe('TaskSchema and TaskSummarySchema include name', () => {
  test('TaskSchema requires name (non-empty string field)', () => {
    expect('name' in TaskSchema.shape).toBe(true)
    // missing name → fail
    const r = TaskSchema.safeParse({
      id: 't1',
      workflowId: 'wf-1',
      workflowName: 'wf',
      workflowSnapshot: {},
      repoPath: '/tmp',
      repoUrl: null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      baseCommit: null,
      status: 'pending',
      inputs: {},
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: 0,
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
    })
    expect(r.success).toBe(false)
  })

  test('TaskSummarySchema requires name', () => {
    const ok = TaskSummarySchema.safeParse({
      id: 't1',
      name: 'fixture-task',
      workflowId: 'wf-1',
      workflowName: 'wf',
      repoPath: '/tmp',
      repoUrl: null,
      status: 'pending',
      startedAt: 0,
      finishedAt: null,
      errorSummary: null,
    })
    expect(ok.success).toBe(true)
    const missing = TaskSummarySchema.safeParse({
      id: 't1',
      workflowId: 'wf-1',
      workflowName: 'wf',
      repoPath: '/tmp',
      repoUrl: null,
      status: 'pending',
      startedAt: 0,
      finishedAt: null,
      errorSummary: null,
    })
    expect(missing.success).toBe(false)
  })
})
