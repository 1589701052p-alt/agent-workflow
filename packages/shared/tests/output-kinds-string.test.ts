// RFC-049 — `string` kind handler contract: validate passthrough, no prompt
// guidance, no repair block. This is the "no validation" kind — any drift
// here means the framework has started gating string ports on something they
// don't owe a contract on.

import { describe, expect, test } from 'bun:test'

import { stringHandler, type ValidateIO } from '@agent-workflow/shared'

// Backed by stubs; string handler never touches io.
const STUB_IO: ValidateIO = {
  resolveWorktreePath: () => {
    throw new Error('not used by string handler')
  },
  readFileUtf8: () => {
    throw new Error('not used by string handler')
  },
}

describe('RFC-049 string kind handler', () => {
  test('validate is passthrough for any input', () => {
    for (const input of ['', '   ', 'hello', 'multi\nline\nbody', '<port>not-XML</port>']) {
      const r = stringHandler.validate(
        input,
        { kind: 'string', port: 'p', worktreePath: '/tmp' },
        STUB_IO,
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.body).toBe(input)
    }
  })

  test('buildPromptGuidance returns null for any port set', () => {
    expect(stringHandler.buildPromptGuidance({ ports: [] })).toBeNull()
    expect(stringHandler.buildPromptGuidance({ ports: ['a'] })).toBeNull()
    expect(stringHandler.buildPromptGuidance({ ports: ['a', 'b', 'c'] })).toBeNull()
  })

  test('buildRepairBlock returns null even when given fabricated failures', () => {
    expect(stringHandler.buildRepairBlock({ failures: [], ports: [] })).toBeNull()
    expect(
      stringHandler.buildRepairBlock({
        failures: [{ port: 'p', kind: 'string', subReason: 'whatever' }],
        ports: ['p'],
      }),
    ).toBeNull()
  })

  test('subReasons set is empty (kind cannot fail)', () => {
    expect(stringHandler.subReasons.size).toBe(0)
  })
})
