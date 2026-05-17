// RFC-032 SettingsGearButton — locks the gear's accessibility + active /
// inactive class wiring, and verifies that clicking it actually invokes the
// router navigation helper.
//
// Why this test exists: the gear replaces the old top-level Settings nav
// link, so it is now the only way for the user to discover the settings
// page from the sidebar. A regression that drops the aria-label, mis-wires
// the active class, or breaks the click navigation would render the
// settings UI undiscoverable for sighted + screen-reader users.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as RouterModule from '@tanstack/react-router'
import '../src/i18n'

const navigateSpy = vi.fn()

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof RouterModule>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  }
})

// Imported AFTER vi.mock so the mock applies inside the component module.
import { SettingsGearButton } from '../src/components/shell/SettingsGearButton'

beforeEach(() => {
  navigateSpy.mockReset()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('RFC-032 SettingsGearButton', () => {
  test('default render exposes aria-label + tooltip + the gear icon (svg)', () => {
    render(<SettingsGearButton active={false} />)
    const btn = screen.getByRole('button', { name: /(settings|设置)/i })
    expect(btn.className).toContain('settings-gear')
    expect(btn.className).not.toContain('settings-gear--active')
    expect(btn.getAttribute('aria-current')).toBeNull()
    expect(btn.getAttribute('title')).toBeTruthy()
    // The icon is an inline SVG, not an image.
    expect(btn.querySelector('svg')).toBeTruthy()
  })

  test('active=true flips the class and sets aria-current="page"', () => {
    render(<SettingsGearButton active={true} />)
    const btn = screen.getByRole('button', { name: /(settings|设置)/i })
    expect(btn.className).toContain('settings-gear--active')
    expect(btn.getAttribute('aria-current')).toBe('page')
  })

  test('click invokes router.navigate({ to: "/settings" })', () => {
    render(<SettingsGearButton active={false} />)
    fireEvent.click(screen.getByRole('button', { name: /(settings|设置)/i }))
    expect(navigateSpy).toHaveBeenCalledTimes(1)
    expect(navigateSpy).toHaveBeenCalledWith({ to: '/settings' })
  })
})
