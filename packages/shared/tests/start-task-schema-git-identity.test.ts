// RFC-067: locks the optional Git commit identity fields added to
// StartTaskSchema — XOR (both set or both blank) + loose email format.
//
// These cases also document the wire contract for the launcher form: the
// frontend may send both fields together OR omit both, never one alone.

import { describe, expect, test } from 'bun:test'
import { StartTaskSchema } from '../src/schemas/task'

const BASE = {
  workflowId: 'wf-1',
  name: 'fixture-task',
  repoUrl: 'https://github.com/o/repo.git',
  ref: 'main',
  inputs: {},
}

describe('StartTaskSchema RFC-067 git identity', () => {
  test('both omitted → ok (default behavior, byte-identical to pre-RFC-067)', () => {
    const r = StartTaskSchema.safeParse({ ...BASE })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.gitUserName).toBeUndefined()
      expect(r.data.gitUserEmail).toBeUndefined()
    }
  })

  test('both set with a valid email → ok, values pass through verbatim', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      gitUserName: 'AI Bot',
      gitUserEmail: 'bot@workflow.local',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.gitUserName).toBe('AI Bot')
      expect(r.data.gitUserEmail).toBe('bot@workflow.local')
    }
  })

  test('only gitUserName set → reject with git-identity-incomplete on email path', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, gitUserName: 'Lonely Bot' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.message === 'git-identity-incomplete')
      expect(issue).toBeDefined()
      expect(issue?.path).toEqual(['gitUserEmail'])
    }
  })

  test('only gitUserEmail set → reject with git-identity-incomplete on name path', () => {
    const r = StartTaskSchema.safeParse({ ...BASE, gitUserEmail: 'lonely@bot.local' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.message === 'git-identity-incomplete')
      expect(issue).toBeDefined()
      expect(issue?.path).toEqual(['gitUserName'])
    }
  })

  test('email missing `@` → reject with git-identity-email-invalid', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      gitUserName: 'Bot',
      gitUserEmail: 'not-an-email',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.message === 'git-identity-email-invalid')
      expect(issue).toBeDefined()
      expect(issue?.path).toEqual(['gitUserEmail'])
    }
  })

  test('loose pseudo-email (bot@local, no TLD) → ok (we are not stricter than git)', () => {
    const r = StartTaskSchema.safeParse({
      ...BASE,
      gitUserName: 'Bot',
      gitUserEmail: 'bot@local',
    })
    expect(r.success).toBe(true)
  })

  test('whitespace-only fields count as blank for the XOR check', () => {
    // Sneaking through with "   " on one side and a real value on the other
    // must still be rejected — otherwise the runner would receive a half
    // identity at spawn time.
    const r = StartTaskSchema.safeParse({
      ...BASE,
      gitUserName: '   ',
      gitUserEmail: 'real@bot.local',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === 'git-identity-incomplete')).toBe(true)
    }
  })
})
