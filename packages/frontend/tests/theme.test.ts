// P-5-04: theme resolution.

import { describe, expect, test } from 'vitest'
import { resolveTheme } from '../src/hooks/useTheme'

describe('resolveTheme', () => {
  test('explicit dark wins over system', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('dark', 'dark')).toBe('dark')
  })

  test('explicit light wins over system', () => {
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('light', 'light')).toBe('light')
  })

  test('system follows the OS preference', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark')
    expect(resolveTheme('system', 'light')).toBe('light')
  })
})
