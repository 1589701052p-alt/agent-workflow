// Regression lock for the xyflow canvas corner widgets (bottom-left Controls,
// bottom-right MiniMap + attribution watermark) being themed consistently
// across EVERY react-flow canvas in the app.
//
// History: commit 8bd1ccb (RFC-007) re-bound these widgets to our theme tokens
// because xyflow's defaults are hard-coded white-on-light (--xy-*-default), so
// in dark mode they render as white bricks. That fix was scoped to the single
// `.workflow-canvas` wrapper. When `.structure-graph` (RFC-083 structural-diff
// graph) was added it did NOT inherit the wrapper-scoped rules, so its
// bottom-left zoom strip regressed to the white brick in dark mode — the exact
// "fixed before, came back" report this test guards against.
//
// The corners are styled by xyflow's own internal classes, not inline styles,
// so JSDOM can't meaningfully compute them; the cheapest durable contract is to
// scan styles.css and assert the theming is GLOBAL (reachable by every canvas)
// and uses theme tokens (so dark mode works). If a future change re-scopes the
// theming to one wrapper, or hard-codes a white background, an assertion below
// fails.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(__dirname, '..', 'src', 'styles.css')
function css(): string {
  return readFileSync(CSS_PATH, 'utf8')
}

// Body of the FIRST top-level (column-0) rule whose selector is exactly
// `selector` — i.e. an unscoped/global rule, not `.some-wrapper <selector>`.
// xyflow corner rules contain no nested braces, so `[^}]*` is sufficient.
function globalRuleBody(text: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(text)
  return m?.[1] ?? null
}

describe('canvas corner widgets — themed globally for every react-flow canvas', () => {
  test('Controls (bottom-left) is themed at the global scope, not per-wrapper', () => {
    const body = globalRuleBody(css(), '.react-flow__controls-button')
    expect(body, 'expected a global .react-flow__controls-button rule').not.toBeNull()
    // theme tokens → resolves per data-theme (works in light AND dark)
    expect(body).toContain('var(--panel)')
    expect(body).toContain('var(--text)')
    // and NOT a hard-coded light background that would brick in dark mode
    expect(body).not.toMatch(/#fff\b|#fefefe\b|\bwhite\b|rgba\(\s*255/i)
  })

  test('MiniMap (bottom-right) is themed at the global scope', () => {
    const body = globalRuleBody(css(), '.react-flow__minimap')
    expect(body, 'expected a global .react-flow__minimap rule').not.toBeNull()
    expect(body).toContain('var(--panel)')
    expect(body).toContain('var(--border)')
  })

  test('attribution watermark (bottom-right) is themed, not a translucent-white smudge', () => {
    const body = globalRuleBody(css(), '.react-flow__attribution')
    expect(body, 'expected a global .react-flow__attribution rule').not.toBeNull()
    expect(body).toContain('var(--panel)')
    expect(body).not.toMatch(/#fff\b|\bwhite\b|rgba\(\s*255/i)
  })

  test('corner theming is NOT re-scoped to a single canvas wrapper', () => {
    // The whole point is that .workflow-canvas (editor / task-detail DAG) and
    // .structure-graph (structural-diff graph) share identical corners. A
    // wrapper-scoped rule would exclude the other canvas and reintroduce the
    // dark-mode brick — reject it so the fix can't silently narrow again.
    const c = css()
    for (const wrapper of ['.workflow-canvas', '.structure-graph']) {
      for (const widget of [
        'react-flow__controls',
        'react-flow__minimap',
        'react-flow__attribution',
      ]) {
        expect(c, `${wrapper} ${widget} must stay global, not wrapper-scoped`).not.toMatch(
          new RegExp(`\\${wrapper}\\s+\\.${widget}\\b`),
        )
      }
    }
  })
})
