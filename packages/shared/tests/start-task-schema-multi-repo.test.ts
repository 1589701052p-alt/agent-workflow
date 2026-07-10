// RFC-066 — locks the StartTaskSchema extension that accepts a `repos: [...]`
// array as an alternative to the legacy top-level `repoUrl` field. Mixing the
// legacy field with `repos[]` is rejected with the stable
// `start-task-source-conflict` code so the route can branch on it.
//
// RFC-165: entries are URL-only — the per-entry path arm (repoPath+baseBranch)
// retired with the local-path launch mode; retired keys strip (route raw-key
// gate rejects them BEFORE parse — locked in backend rfc165-banned-locks).

import { describe, expect, test } from 'bun:test'
import { MULTI_REPO_MAX, StartTaskRepoSchema, StartTaskSchema } from '../src/schemas/task'

describe('StartTaskSchema multi-repo (RFC-066)', () => {
  // S2: v2 body with a single repo entry parses.
  test('S2 v2 single-entry repos[] parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ repoUrl: 'https://github.com/o/a.git', ref: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  test('S2b v2 multi-entry repos[] parses', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [
        { repoUrl: 'https://github.com/o/a.git', ref: 'main' },
        { repoUrl: 'https://github.com/o/b.git' },
        { repoUrl: 'git@github.com:foo/bar.git', ref: 'develop' },
      ],
      inputs: {},
    })
    expect(r.success).toBe(true)
  })

  // S3: mixing legacy + v2 → reject with stable code.
  test('S3b rejects legacy repoUrl alongside repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repoUrl: 'git@github.com:foo/bar.git',
      repos: [{ repoUrl: 'https://github.com/o/b.git' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(true)
    }
  })

  // S4: each v2 entry must carry a usable URL (RFC-165: retired path keys
  // strip, so a path-only entry reads as EMPTY and is rejected).
  test('S4b rejects v2 entry missing repoUrl', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ ref: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
  })

  test('S4c a retired path-mode entry strips to empty → rejected', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [{ repoPath: '/tmp/repo', baseBranch: 'main' }],
      inputs: {},
    })
    expect(r.success).toBe(false)
  })

  // S5: empty repos[] also rejected (min(1) Zod constraint).
  test('S5 rejects empty repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      repos: [],
      inputs: {},
    })
    expect(r.success).toBe(false)
  })

  // S6: more than MULTI_REPO_MAX entries → reject.
  test('S6 rejects repos[] longer than MULTI_REPO_MAX', () => {
    const repos = Array.from({ length: MULTI_REPO_MAX + 1 }, (_, i) => ({
      repoUrl: `https://github.com/o/repo-${i}.git`,
      ref: 'main',
    }))
    const r = StartTaskSchema.safeParse({ workflowId: 'wf-1', name: 'task', repos, inputs: {} })
    expect(r.success).toBe(false)
  })

  test('S6b accepts repos[] of exactly MULTI_REPO_MAX', () => {
    const repos = Array.from({ length: MULTI_REPO_MAX }, (_, i) => ({
      repoUrl: `https://github.com/o/repo-${i}.git`,
      ref: 'main',
    }))
    const r = StartTaskSchema.safeParse({ workflowId: 'wf-1', name: 'task', repos, inputs: {} })
    expect(r.success).toBe(true)
  })

  // S7: literal constant lock — guards against silent budget changes.
  test('S7 MULTI_REPO_MAX is exactly 8', () => {
    expect(MULTI_REPO_MAX).toBe(8)
  })

  // S8: bare StartTaskRepoSchema parses standalone entries (consumers / tests).
  test('S8b StartTaskRepoSchema accepts a valid url entry without ref', () => {
    const r = StartTaskRepoSchema.safeParse({ repoUrl: 'git@github.com:foo/bar.git' })
    expect(r.success).toBe(true)
  })

  test('S8c StartTaskRepoSchema rejects an entry without repoUrl', () => {
    const r = StartTaskRepoSchema.safeParse({ ref: 'main' })
    expect(r.success).toBe(false)
  })

  // S9: missing both repos[] and legacy fields → reject (still required to source somewhere).
  test('S9 rejects body without legacy fields and without repos[]', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf-1',
      name: 'task',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      // RFC-165: message unified to the machine code `start-task-source-required`
      // (scratch joined the source union; prose message retired with path mode).
      expect(r.error.issues.some((i) => i.message === 'start-task-source-required')).toBe(true)
    }
  })
})
