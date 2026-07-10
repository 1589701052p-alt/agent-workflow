// RFC-024: locks the URL-source rules on StartTaskSchema.
//
// RFC-165: the local-path launch mode is retired — repoPath/baseBranch/
// fetchBeforeLaunch left the schema entirely (unknown keys strip; the raw-key
// reject gate at every route entrance turns them into 422s BEFORE parsing —
// see rfc165-contract-v2.test.ts / rfc165-banned-locks.test.ts in backend).
// The path-mode cases that used to live here were deleted with the mode; the
// strip semantics are locked below so the schema can't quietly re-accept them.

import { describe, expect, test } from 'bun:test'
import { StartTaskSchema } from '../src/schemas/task'

describe('StartTaskSchema (RFC-024)', () => {
  test('url mode parses (ref optional)', () => {
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

  test('rejects when no source given (start-task-source-required)', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'start-task-source-required')).toBe(true)
    }
  })
})

describe('StartTaskSchema RFC-165 — retired path-mode keys strip (never re-accepted)', () => {
  test('repoPath/baseBranch/fetchBeforeLaunch are unknown keys — stripped, not parsed', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoUrl: 'git@github.com:foo/bar.git',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      fetchBeforeLaunch: true,
      inputs: {},
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('repoPath' in r.data).toBe(false)
      expect('baseBranch' in r.data).toBe(false)
      expect('fetchBeforeLaunch' in r.data).toBe(false)
    }
  })

  test('a path-only legacy body has no source after the strip → rejected', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'start-task-source-required')).toBe(true)
    }
  })
})
