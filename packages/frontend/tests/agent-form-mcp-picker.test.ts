// RFC-028 T10 — locks the AgentForm + Stats tab wiring at source level:
//   - AgentForm imports McpsPicker
//   - AgentForm renders an `agentForm.fieldMcps` Field next to the Skills one
//   - NodeDetailDrawer Stats tab includes NodeMcpClosureSection
//   - Both i18n bundles cover all new keys (fieldMcps / mcpClosureXxx)

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')
const read = (rel: string): string => readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')

describe('RFC-028 T10 — AgentForm MCP picker', () => {
  test('AgentForm.tsx imports McpsPicker and renders the Field', () => {
    const src = read('components/AgentForm.tsx')
    expect(src).toContain("import { McpsPicker } from './McpsPicker'")
    expect(src).toContain('agentForm.fieldMcps')
    // Ensures the new picker hangs off value.mcp (not skills) — otherwise
    // saves would silently lose the user's selection.
    expect(src).toContain("patch('mcp', v)")
  })

  test('McpsPicker.tsx uses the /api/mcps endpoint via TanStack query', () => {
    const src = read('components/McpsPicker.tsx')
    expect(src).toContain('queryKey: MCPS_QUERY_KEY')
    expect(src).toContain("api.get('/api/mcps'")
  })
})

describe('RFC-028 T10 — Stats tab MCP closure', () => {
  test('NodeDetailDrawer imports + renders NodeMcpClosureSection', () => {
    const src = read('components/NodeDetailDrawer.tsx')
    expect(src).toContain("import { NodeMcpClosureSection } from './agents/NodeMcpClosureSection'")
    expect(src).toContain('statMcpClosure')
    expect(src).toContain('<NodeMcpClosureSection agentName={agentName} />')
  })

  test('NodeMcpClosureSection unions mcp[] across closure agents (first-seen order)', () => {
    const src = read('components/agents/NodeMcpClosureSection.tsx')
    // First-seen order matches services/mcpClosure.ts behavior.
    expect(src).toContain('first-seen order')
    expect(src).toContain('collectMcpNamesFromClosure')
  })
})

describe('RFC-028 T10 — i18n parity', () => {
  test('zh-CN + en-US both define the new keys', () => {
    const zh = read('i18n/zh-CN.ts')
    const en = read('i18n/en-US.ts')
    for (const key of [
      'fieldMcps:',
      'fieldMcpsHint:',
      'fieldMcpsPlaceholder:',
      'mcpsPickerLabel:',
      'mcpsPickerLoading:',
      'mcpsPickerEmpty:',
      'mcpsPickerLoadFailed:',
      'statMcpClosure:',
      'mcpClosureEmpty:',
      'mcpClosureLoadFailed:',
    ]) {
      expect(zh).toContain(key)
      expect(en).toContain(key)
    }
  })
})
