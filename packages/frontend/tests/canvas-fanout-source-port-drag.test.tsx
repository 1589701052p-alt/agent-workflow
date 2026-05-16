// RFC-015 — integration coverage for the agent-multi top-side `sourcePort`
// drag-set Handle. The connect / disconnect / removal pure-function paths
// live in `fanout-source-sync.test.ts`; here we lock the DOM-visible
// contract that JSDOM CAN render: the Handle's existence + visual state
// flips correctly on `data.sourcePort`, single-form nodes don't render
// the top Handle, and NodeInspector keeps the drag-hint visible.
//
// xyflow's drag-and-drop is not simulatable in JSDOM, so the
// `handleConnect` / `isValidConnection` / `handleNodesChange` wiring in
// WorkflowCanvas is covered by:
//   1. fanout-source-sync.test.ts — the pure helpers themselves
//   2. canvas-fanout-source-port-not-floating.test.ts — fs.read source-level
//      assertions that WorkflowCanvas IMPORTS and CALLS the helpers
// Together they pin "handle visible" + "helpers exist + are called",
// closing the loop without needing a real browser.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import { I18nextProvider } from 'react-i18next'
import { useState } from 'react'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { MULTI_SOURCE_PORT_HANDLE_ID } from '../src/components/canvas/fanoutSourceSync'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { setBaseUrl, setToken } from '../src/stores/auth'
import i18n from '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // NodeInspector pulls ModelSelect which fires GET /api/runtime/models on
  // mount; resolve to an empty list so the QueryClient never logs a
  // post-teardown error.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{"models":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderNode(ui: React.ReactNode) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

// xyflow v12's NodeProps carries a chunky required surface (draggable /
// selectable / deletable / positionAbsoluteX-Y) that the AgentNode under
// test doesn't read. The helper builds a minimal props bag and casts to
// AgentNode's parameter type so the test can focus on the data shape we
// actually care about.
type AgentNodeProps = Parameters<typeof AgentNode>[0]
function nodeProps(id: string, kind: string, data: CanvasNodeData): AgentNodeProps {
  return {
    id,
    type: kind,
    data,
    selected: false,
    zIndex: 0,
    isConnectable: true,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    draggable: true,
    selectable: true,
    deletable: true,
  } as unknown as AgentNodeProps
}

function fanoutData(
  sourcePort: { nodeId: string; portName: string } | undefined = undefined,
): CanvasNodeData {
  return {
    nodeId: 'audit',
    kind: 'agent-multi',
    title: 'auditor',
    inputPorts: [],
    outputPorts: ['result'],
    ...(sourcePort !== undefined ? { sourcePort } : {}),
  }
}

function singleData(): CanvasNodeData {
  return {
    nodeId: 'worker',
    kind: 'agent-single',
    title: 'worker',
    inputPorts: [],
    outputPorts: ['out'],
  }
}

describe('AgentNode — RFC-015 top-side sourcePort Handle', () => {
  test('agent-multi renders the top Handle with id __multi_source_port__', () => {
    const { container } = renderNode(
      <AgentNode {...nodeProps('audit', 'agent-multi', fanoutData())} />,
    )
    const handle = container.querySelector(`[data-handleid="${MULTI_SOURCE_PORT_HANDLE_ID}"]`)
    expect(handle).toBeTruthy()
    expect(handle?.getAttribute('aria-label')).toBe('multi-source-port')
    // shard-source visual class is always present on the top handle.
    expect(handle?.classList.contains('canvas-node__handle--shard-source')).toBe(true)
  })

  test('agent-single does NOT render the top Handle', () => {
    const { container } = renderNode(
      <AgentNode {...nodeProps('worker', 'agent-single', singleData())} />,
    )
    const handle = container.querySelector(`[data-handleid="${MULTI_SOURCE_PORT_HANDLE_ID}"]`)
    expect(handle).toBeNull()
  })

  test('is-connected class toggles based on data.sourcePort.nodeId', () => {
    const empty = renderNode(
      <AgentNode
        {...nodeProps('audit', 'agent-multi', fanoutData({ nodeId: '', portName: '' }))}
      />,
    )
    const h1 = empty.container.querySelector(`[data-handleid="${MULTI_SOURCE_PORT_HANDLE_ID}"]`)!
    expect(h1.classList.contains('is-connected')).toBe(false)
    empty.unmount()

    const filled = renderNode(
      <AgentNode
        {...nodeProps(
          'audit',
          'agent-multi',
          fanoutData({ nodeId: 'designer', portName: 'markdown_design' }),
        )}
      />,
    )
    const h2 = filled.container.querySelector(`[data-handleid="${MULTI_SOURCE_PORT_HANDLE_ID}"]`)!
    expect(h2.classList.contains('is-connected')).toBe(true)
  })

  test('top Handle is rendered BEFORE the header (top-of-node anchor)', () => {
    const { container } = renderNode(
      <AgentNode {...nodeProps('audit', 'agent-multi', fanoutData())} />,
    )
    const header = container.querySelector('.canvas-node__header')!
    const handle = container.querySelector(`[data-handleid="${MULTI_SOURCE_PORT_HANDLE_ID}"]`)!
    // DOCUMENT_POSITION_FOLLOWING = 4 — header comes after handle.
    expect(handle.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// NodeInspector still wires the drag-hint copy into the agent-multi panel.
// (The two-dropdown SourcePortField itself is covered by RFC-003 tests; we
// only verify the new hint text is rendered.)
// ---------------------------------------------------------------------------

function makeFanoutDef(sp = { nodeId: '', portName: '' }): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
      {
        id: 'audit',
        kind: 'agent-multi',
        agentName: 'stub',
        sourcePort: sp,
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
}

function InspectorHost({
  initialDef,
  selectedNodeId,
}: {
  initialDef: WorkflowDefinition
  selectedNodeId: string
}) {
  const [def, setDef] = useState(initialDef)
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <NodeInspector
          definition={def}
          selectedNodeId={selectedNodeId}
          agents={[]}
          onChange={setDef}
          onClose={() => {}}
        />
      </I18nextProvider>
    </QueryClientProvider>
  )
}

describe('NodeInspector — RFC-015 drag-hint copy', () => {
  test('agent-multi inspector includes the drag-hint paragraph below SourcePortField', () => {
    const { container } = render(
      <InspectorHost initialDef={makeFanoutDef()} selectedNodeId="audit" />,
    )
    // The hint i18n key copy includes "顶部" (zh) — match either locale by
    // probing for the localized chunk that survives translation regardless
    // of current language.
    const text = container.textContent ?? ''
    const matchesZh = text.includes('顶部') && text.includes('拖入')
    const matchesEn =
      text.toLowerCase().includes('top of this node') && text.toLowerCase().includes('drag')
    expect(matchesZh || matchesEn).toBe(true)
  })
})
