// RFC-024: locks the path/url mutual-exclusion + ref/baseBranch rules added
// to StartTaskSchema. Path-mode legacy callers must keep working unchanged.

import { describe, expect, test } from 'bun:test'
import { StartTaskSchema } from '../src/schemas/task'

describe('StartTaskSchema (RFC-024)', () => {
  test('path mode (legacy) parses unchanged', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  test('url mode parses (no baseBranch required)', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoUrl: 'git@github.com:foo/bar.git',
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  test('url mode with explicit ref parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoUrl: 'https://github.com/foo/bar.git',
      ref: 'feature/x',
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  test('rejects when both repoPath and repoUrl given', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      repoUrl: 'git@github.com:foo/bar.git',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => /mutually exclusive/.test(i.message))).toBe(true)
    }
  })

  test('rejects when neither given', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      // RFC-066 widened the message to mention the new `repos[]` field too.
      // Keep the assertion broad enough to survive that text change.
      expect(r.error.issues.some((i) => /one of repoPath.*repoUrl/.test(i.message))).toBe(true)
    }
  })

  test('rejects path mode without baseBranch', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => /baseBranch is required/.test(i.message))).toBe(true)
    }
  })
})

describe('StartTaskSchema fetchBeforeLaunch (RFC-068)', () => {
  test('accepts fetchBeforeLaunch=true in path mode', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      fetchBeforeLaunch: true,
      inputs: {},
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.fetchBeforeLaunch).toBe(true)
  })

  test('accepts fetchBeforeLaunch=false', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      fetchBeforeLaunch: false,
      inputs: {},
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.fetchBeforeLaunch).toBe(false)
  })

  test('fetchBeforeLaunch omitted leaves field undefined (legacy bodies)', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: {},
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.fetchBeforeLaunch).toBeUndefined()
  })

  test('rejects non-boolean fetchBeforeLaunch', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      fetchBeforeLaunch: 'yes' as unknown as boolean,
      inputs: {},
    })
    expect(r.success).toBe(false)
  })
})
