import { describe, expect, test } from 'bun:test'
import { SHARED_PACKAGE_VERSION } from '@agent-workflow/shared'

describe('M0 smoke', () => {
  test('shared package is reachable from backend', () => {
    expect(SHARED_PACKAGE_VERSION).toBe('0.0.0')
  })
})
