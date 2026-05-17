// RFC-028 T9 — source-code wiring locks for the /mcps page.
//
// We don't render the full TanStack-Router component tree here (the i18next /
// react-query stack would need a full harness); instead we assert the wiring
// from text patterns. This catches:
//   - sidebar nav loses the /mcps entry (regression to pre-RFC-028)
//   - editor file ever introduces a `cwd` input (opencode lacks the field)
//   - i18n bundles drift apart for the mcps section

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function read(path: string): string {
  return readFileSync(resolve(FRONTEND_SRC, path), 'utf-8')
}

describe('RFC-028 /mcps page — source wiring', () => {
  test('sidebar nav exposes a /mcps entry', () => {
    const root = read('routes/__root.tsx')
    expect(root).toContain("{ to: '/mcps', key: 'mcps' }")
  })

  test('router registers mcpsRoute under the root tree', () => {
    const router = read('router.tsx')
    expect(router).toContain("import { Route as mcpsRoute } from '@/routes/mcps'")
    expect(router).toContain('mcpsRoute,')
  })

  test('editor file never references the `cwd` field (opencode McpLocalConfig has none)', () => {
    const page = read('routes/mcps.tsx')
    // The hint string explains that cwd is intentionally absent — that's
    // allowed. What we ban is ever showing a `cwd` input or persisting one.
    // Match a JSX attribute (`cwd=`) or an object literal entry (`cwd:`) but
    // NOT prose ("cwd = worktree" in a comment), class names
    // (`mcp-editor__cwd-hint`), or i18n key names (`cwdHint`). The colon /
    // equals must be immediately adjacent to the word `cwd`.
    expect(/\bcwd:|\bcwd=|\bdata-testid="mcp-field-cwd"/.test(page)).toBe(false)
  })

  test('form builder file never lists cwd in its form state', () => {
    const form = read('lib/mcp-form.ts')
    expect(/\bcwd\b/.test(form)).toBe(false)
  })

  test('zh-CN and en-US bundles both define the mcps section', () => {
    const zh = read('i18n/zh-CN.ts')
    const en = read('i18n/en-US.ts')
    // Spot a few i18n keys to make sure both bundles share the same surface.
    for (const key of [
      'title',
      'newButton',
      'emptyList',
      'typeLocal',
      'typeRemote',
      'fieldCommand',
      'fieldUrl',
      'toolNamingHint',
      'cwdHint',
      'oauthCliHint',
    ]) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
    // Nav key
    expect(zh).toContain("mcps: 'MCP'")
    expect(en).toContain("mcps: 'MCPs'")
  })
})
