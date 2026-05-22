// RFC-056 PR-C T9 — locks NodeInspector + palette wiring for cross-clarify.
//
// LOCKS:
//   1. NodeInspector renders a section keyed by `data-testid='cross-clarify-inspector'`
//      when the selected node is `clarify-cross-agent`.
//   2. The two segmented controls fire `onPatch` with sessionModeForDesigner /
//      sessionModeForQuestioner deltas when clicked.
//   3. Both segmented controls default to 'isolated' on a freshly-dropped node.
//   4. Palette catalog exposes a `clarify-cross-agent` entry under the
//      Human section.
//   5. Source-text guard: clarify-cross-agent reaches NodeInspector.tsx /
//      nodePalette.ts / WorkflowCanvas.tsx so a future rename catches.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render } from '@testing-library/react'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { buildPalette, makeNode } from '../src/components/canvas/nodePalette'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const NODE_INSPECTOR_TSX = resolve(
  __dirname,
  '..',
  'src',
  'components',
  'canvas',
  'NodeInspector.tsx',
)
const PALETTE_TS = resolve(__dirname, '..', 'src', 'components', 'canvas', 'nodePalette.ts')
const CANVAS_TSX = resolve(__dirname, '..', 'src', 'components', 'canvas', 'WorkflowCanvas.tsx')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mkDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'cc1', kind: 'clarify-cross-agent', title: '', description: '' }],
    edges: [],
    outputs: [],
  }
}

function renderInspector(def: WorkflowDefinition, onChange: (next: WorkflowDefinition) => void) {
  return render(
    <NodeInspector
      definition={def}
      selectedNodeId="cc1"
      agents={[] as Agent[]}
      onChange={onChange}
      onClose={() => undefined}
    />,
  )
}

describe('RFC-056 NodeInspector — clarify-cross-agent', () => {
  test('renders the cross-clarify inspector section when selected', () => {
    const def = mkDef()
    renderInspector(def, vi.fn())
    expect(document.querySelector('[data-testid="cross-clarify-inspector"]')).not.toBeNull()
    expect(
      document.querySelector('[data-testid="cross-clarify-session-mode-designer"]'),
    ).not.toBeNull()
    expect(
      document.querySelector('[data-testid="cross-clarify-session-mode-questioner"]'),
    ).not.toBeNull()
  })

  test('clicking the designer "inline" segmented option fires onChange with sessionModeForDesigner=inline', () => {
    const def = mkDef()
    const onChange = vi.fn<(next: WorkflowDefinition) => void>()
    renderInspector(def, onChange)
    const btn = document.querySelector(
      '[data-testid="cross-clarify-session-mode-designer-inline"]',
    ) as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    const lastDef = onChange.mock.calls.at(-1)?.[0]
    expect(lastDef).toBeDefined()
    const node = lastDef!.nodes.find((n) => n.id === 'cc1') as
      | (WorkflowNode & { sessionModeForDesigner?: string })
      | undefined
    expect(node?.sessionModeForDesigner).toBe('inline')
  })

  test('clicking the questioner "inline" segmented option fires onChange with sessionModeForQuestioner=inline', () => {
    const def = mkDef()
    const onChange = vi.fn<(next: WorkflowDefinition) => void>()
    renderInspector(def, onChange)
    const btn = document.querySelector(
      '[data-testid="cross-clarify-session-mode-questioner-inline"]',
    ) as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    fireEvent.click(btn!)
    const lastDef = onChange.mock.calls.at(-1)?.[0]
    expect(lastDef).toBeDefined()
    const node = lastDef!.nodes.find((n) => n.id === 'cc1') as
      | (WorkflowNode & { sessionModeForQuestioner?: string })
      | undefined
    expect(node?.sessionModeForQuestioner).toBe('inline')
  })

  test('both segmented controls default to "isolated" on a freshly-dropped node', () => {
    const def = mkDef()
    renderInspector(def, vi.fn())
    const isolatedDesigner = document.querySelector(
      '[data-testid="cross-clarify-session-mode-designer-isolated"]',
    ) as HTMLButtonElement | null
    const isolatedQuestioner = document.querySelector(
      '[data-testid="cross-clarify-session-mode-questioner-isolated"]',
    ) as HTMLButtonElement | null
    expect(isolatedDesigner?.getAttribute('aria-checked')).toBe('true')
    expect(isolatedQuestioner?.getAttribute('aria-checked')).toBe('true')
  })
})

describe('RFC-056 palette catalog', () => {
  test('buildPalette includes a clarify-cross-agent item in the Human section', () => {
    const sections = buildPalette([], (key) => key)
    const human = sections.find((s) => s.label === 'editor.paletteHuman')
    expect(human).toBeDefined()
    const cross = human?.items.find(
      (it) => (it.item as { kind: string }).kind === 'clarify-cross-agent',
    )
    expect(cross).toBeDefined()
  })

  test('makeNode for clarify-cross-agent produces a node with kind=clarify-cross-agent and default fields', () => {
    const node = makeNode(
      { kind: 'clarify-cross-agent' },
      { x: 0, y: 0 },
      { existingIds: new Set() },
    )
    expect(node.kind).toBe('clarify-cross-agent')
    const rec = node as unknown as Record<string, unknown>
    expect(rec.title).toBe('')
    expect(rec.description).toBe('')
  })
})

describe('RFC-056 source-text grep guards (T9)', () => {
  test('NodeInspector.tsx references cross-clarify-inspector + session-mode-* testids', () => {
    const src = readFileSync(NODE_INSPECTOR_TSX, 'utf-8')
    expect(src).toContain('cross-clarify-inspector')
    expect(src).toContain('cross-clarify-session-mode-designer')
    expect(src).toContain('cross-clarify-session-mode-questioner')
    expect(src).toContain('sessionModeForDesigner')
    expect(src).toContain('sessionModeForQuestioner')
  })

  test('nodePalette.ts has clarify-cross-agent in PaletteItem + SHORT', () => {
    const src = readFileSync(PALETTE_TS, 'utf-8')
    expect(src).toMatch(/'clarify-cross-agent'/)
    expect(src).toContain('crossClarify.canvas.paletteLabel')
  })

  test('WorkflowCanvas.tsx wires CrossClarifyNode + classifyCrossClarifyConnection', () => {
    const src = readFileSync(CANVAS_TSX, 'utf-8')
    expect(src).toContain('CrossClarifyNode')
    expect(src).toContain('classifyCrossClarifyConnection')
    expect(src).toContain('applyCrossClarifyQuestionerReverseDrag')
    expect(src).toContain('applyCrossClarifyDesignerDrag')
    expect(src).toContain('clearCrossClarifyEdgesForRemovedNodes')
  })
})
