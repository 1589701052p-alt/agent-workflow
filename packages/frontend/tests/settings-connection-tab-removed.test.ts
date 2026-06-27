// Regression guard — the Settings "Connection" tab was removed (cleanup
// requested 2026-06-27). It used to show the daemon URL + a masked token + a
// sign-out button, all redundant post-RFC-036:
//   - sign-out lives in UserMenu, which ALSO invalidates the server session via
//     POST /api/auth/logout. The old Connection-tab sign-out only cleared the
//     local token, leaving the session alive server-side — a strictly worse
//     duplicate, which is the main reason the tab had to go.
//   - active sessions / PATs are managed on /account.
//
// These source-text assertions lock the removal in: if a refactor re-introduces
// a settings-local sign-out (or the dead i18n keys), this turns red and points
// at why the tab must not come back. Mirrors the style of
// settings-inline-style-cleanup.test.ts.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.resolve(here, rel), 'utf8')

const settings = read('../src/routes/settings.tsx')
const zhCN = read('../src/i18n/zh-CN.ts')
const enUS = read('../src/i18n/en-US.ts')
const userMenu = read('../src/components/UserMenu.tsx')

describe('Settings Connection tab removal', () => {
  test('settings.tsx no longer defines, registers, or renders a Connection tab', () => {
    expect(settings.includes('ConnectionTab')).toBe(false)
    expect(settings.includes("'connection'")).toBe(false)
    expect(settings.includes('tabConnection')).toBe(false)
  })

  test('settings.tsx no longer owns a local sign-out / token readout', () => {
    // The settings page must not re-grow its own auth affordances.
    expect(settings.includes('clearToken')).toBe(false)
    expect(settings.includes('getBaseUrl')).toBe(false)
    expect(settings.includes('maskToken')).toBe(false)
    expect(settings.includes('settingsForm.signOut')).toBe(false)
    expect(settings.includes('settingsForm.daemonUrl')).toBe(false)
    expect(settings.includes('settingsForm.tokenMask')).toBe(false)
  })

  test('Connection-only i18n keys are gone from both bundles', () => {
    // `daemonUrl` still legitimately exists under the auth section, so we only
    // assert the keys that were unique to the Connection tab.
    for (const bundle of [zhCN, enUS]) {
      expect(bundle.includes('tabConnection')).toBe(false)
      expect(bundle.includes('signOut')).toBe(false)
      expect(bundle.includes('tokenMask')).toBe(false)
    }
  })

  test('UserMenu stays the canonical sign-out and invalidates the server session', () => {
    expect(userMenu.includes('/api/auth/logout')).toBe(true)
    expect(userMenu.includes('clearToken')).toBe(true)
  })
})
