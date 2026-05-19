// RFC-049 — `markdown` kind handler contract: same passthrough as `string`
// today. Locked separately because we explicitly reserved the option to
// surface markdown-specific guidance later (e.g. lint hints) without
// conflating with the plain-text kind.

import { describe, expect, test } from 'bun:test'

import { markdownHandler, type ValidateIO } from '@agent-workflow/shared'

const STUB_IO: ValidateIO = {
  resolveWorktreePath: () => {
    throw new Error('not used by markdown handler')
  },
  readFileUtf8: () => {
    throw new Error('not used by markdown handler')
  },
}

describe('RFC-049 markdown kind handler', () => {
  test('validate is passthrough for any input', () => {
    for (const input of ['', '# Title', '# Title\n\nbody', 'plain text', '## with [link](x.md)']) {
      const r = markdownHandler.validate(
        input,
        { kind: 'markdown', port: 'p', worktreePath: '/tmp' },
        STUB_IO,
      )
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.body).toBe(input)
    }
  })

  test('buildPromptGuidance returns null for any port set', () => {
    expect(markdownHandler.buildPromptGuidance({ ports: [] })).toBeNull()
    expect(markdownHandler.buildPromptGuidance({ ports: ['a', 'b'] })).toBeNull()
  })

  test('buildRepairBlock returns null even when given fabricated failures', () => {
    expect(
      markdownHandler.buildRepairBlock({
        failures: [{ port: 'p', kind: 'markdown', subReason: 'whatever' }],
        ports: ['p'],
      }),
    ).toBeNull()
  })

  test('subReasons set is empty (kind cannot fail)', () => {
    expect(markdownHandler.subReasons.size).toBe(0)
  })
})
