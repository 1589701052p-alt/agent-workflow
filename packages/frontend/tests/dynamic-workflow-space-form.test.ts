// RFC-167 T4 — dynamic workflow space form helpers (pure).

import { describe, expect, test } from 'vitest'
import {
  addPoolAgent,
  buildQuickCreateSpacePayload,
  removePoolAgentAt,
} from '../src/lib/dynamic-workflow-space-form'

describe('buildQuickCreateSpacePayload', () => {
  test('valid name → payload', () => {
    const r = buildQuickCreateSpacePayload({ name: 'my-space', description: 'x' })
    expect(r).toEqual({ ok: true, payload: { name: 'my-space', description: 'x' } })
  })

  test('empty name → nameRequired', () => {
    const r = buildQuickCreateSpacePayload({ name: '', description: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.name).toBe('dynamicWorkflowSpaces.errors.nameRequired')
  })

  test('non-slug name → nameInvalid', () => {
    const r = buildQuickCreateSpacePayload({ name: 'Bad Name', description: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.name).toBe('dynamicWorkflowSpaces.errors.nameInvalid')
  })
})

describe('pool helpers', () => {
  test('addPoolAgent de-dupes + trims + preserves order', () => {
    expect(addPoolAgent(['a'], 'b')).toEqual(['a', 'b'])
    expect(addPoolAgent(['a'], 'a')).toEqual(['a']) // dup ignored
    expect(addPoolAgent(['a'], '  c  ')).toEqual(['a', 'c']) // trimmed
    expect(addPoolAgent(['a'], '   ')).toEqual(['a']) // blank ignored
  })

  test('removePoolAgentAt removes the indexed entry', () => {
    expect(removePoolAgentAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })
})
