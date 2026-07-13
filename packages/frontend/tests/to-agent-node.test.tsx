// RFC-W004 PR-1 T7 - to-agent clarify node editor surface.
//
// LOCKS (mirrors the RFC-056 cross-clarify canvas test suite):
//   - The reverse-drag (B onto to-agent.questions) builds the 2-edge questioner
//     channel (ask + ans); the forward to_answerer drag builds the single
//     answerer edge onto A.__clarify_request__.
//   - cascadeRemoveToAgentChannel drops the (ask, ans) sibling on single-edge
//     delete; the answerer half has no sibling and is NOT cascaded.
//   - classifyToAgentConnection is kind-disjoint from classifyCrossClarifyConnection
//     (the shared `questions` / `to_questioner` literals are disambiguated by
//     node kind), and accepts the forward `to_questioner` / `to_answerer` drop
//     onto the catch-all strip (synthetic system target handles are not visible
//     on a fresh agent).
//   - Multi-source aggregation (design §3.4 / S7): two to-agent nodes pointing
//     at the same answerer A is ALLOWED - the second applyToAgentAnswererDrag
//     does NOT reject (only one-to-agent -> many-A is blocked).
//   - computePorts dynamically registers `__clarify_request__` on A's input
//     side only while a to_answerer edge exists (mirrors __external_feedback__).
//   - ToAgentClarifyNode renders disambiguating handle labels.
//   - NodeInspector's ToAgentClarifyEdit shows title/description, read-only
//     linked-questioner/answerer, and a sessionModeForAnswerer Segmented.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReactFlowProvider } from '@xyflow/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  applyToAgentAnswererDrag,
  applyToAgentQuestionerReverseDrag,
  cascadeRemoveToAgentChannel,
  classifyToAgentConnection,
} from '../src/components/canvas/toAgentClarifyDragHelper'
import { classifyCrossClarifyConnection } from '../src/components/canvas/crossClarifyDragHelper'
import { __testComputePorts as computePorts } from '../src/components/canvas/WorkflowCanvas'
import { ToAgentClarifyNode } from '../src/components/canvas/nodes/ToAgentClarifyNode'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import '../src/i18n'

const WORKFLOW_CANVAS_TSX = resolve(
  __dirname,
  '..',
  'src',
  'components',
  'canvas',
  'WorkflowCanvas.tsx',
)

const ANSWERER: Agent = {
  id: 'a',
  name: 'answerer',
  description: '',
  outputs: ['findings'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

function baseDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'answerer', kind: 'agent-single', agentName: 'answerer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'to1', kind: 'clarify-to-agent' },
    ],
    edges: [],
    outputs: [],
  }
}

function wireQuestioner(def: WorkflowDefinition): WorkflowDefinition {
  return applyToAgentQuestionerReverseDrag(def, {
    questionerNodeId: 'questioner',
    toAgentNodeId: 'to1',
  })
}

describe('to-agent drag helpers: reverse-drag builds the 2-edge questioner channel', () => {
  test('applyToAgentQuestionerReverseDrag appends exactly the ask + ans edges', () => {
    const next = wireQuestioner(baseDef())
    expect(next.edges.length).toBe(2)
    const ask = next.edges.find((e) => e.source.portName === '__clarify__') as WorkflowEdge
    const ans = next.edges.find((e) => e.source.portName === 'to_questioner') as WorkflowEdge
    expect(ask).toBeDefined()
    expect(ans).toBeDefined()
    expect(ask.target.portName).toBe('questions')
    expect(ans.target.portName).toBe('__clarify_response__')
    expect(ask.source.nodeId).toBe('questioner')
    expect(ans.target.nodeId).toBe('questioner')
  })

  test('a second questioner reverse-drag is rejected (one questioner per to-agent)', () => {
    let def = wireQuestioner(baseDef())
    def = applyToAgentQuestionerReverseDrag(def, {
      questionerNodeId: 'answerer',
      toAgentNodeId: 'to1',
    })
    // Still only the original 2 edges.
    expect(def.edges.length).toBe(2)
  })
})

describe('to-agent drag helpers: forward to_answerer drag builds the single answerer edge', () => {
  test('applyToAgentAnswererDrag appends exactly one to_answerer -> __clarify_request__ edge', () => {
    const next = applyToAgentAnswererDrag(baseDef(), {
      toAgentNodeId: 'to1',
      answererNodeId: 'answerer',
    })
    expect(next.edges.length).toBe(1)
    const edge = next.edges[0] as WorkflowEdge
    expect(edge.source.portName).toBe('to_answerer')
    expect(edge.target.portName).toBe('__clarify_request__')
    expect(edge.source.nodeId).toBe('to1')
    expect(edge.target.nodeId).toBe('answerer')
  })

  test('a second to_answerer drag onto a DIFFERENT answerer is rejected (one answerer per to-agent)', () => {
    let def = applyToAgentAnswererDrag(baseDef(), {
      toAgentNodeId: 'to1',
      answererNodeId: 'answerer',
    })
    // Add a second answerer node so the drop target is valid kind-wise.
    def = {
      ...def,
      nodes: [...def.nodes, { id: 'answerer2', kind: 'agent-single', agentName: 'a2' }],
    }
    def = applyToAgentAnswererDrag(def, {
      toAgentNodeId: 'to1',
      answererNodeId: 'answerer2',
    })
    // Still only the original 1 edge - one to-agent -> many answerers is blocked.
    expect(def.edges.length).toBe(1)
    expect(def.edges[0]!.target.nodeId).toBe('answerer')
  })

  test('multi-source ALLOWED: two to-agent nodes pointing at the SAME answerer A (design §3.4)', () => {
    let def = baseDef()
    def = {
      ...def,
      nodes: [...def.nodes, { id: 'to2', kind: 'clarify-to-agent' }],
    }
    def = applyToAgentAnswererDrag(def, { toAgentNodeId: 'to1', answererNodeId: 'answerer' })
    // Second to-agent -> same A must NOT be rejected.
    def = applyToAgentAnswererDrag(def, { toAgentNodeId: 'to2', answererNodeId: 'answerer' })
    expect(def.edges.length).toBe(2)
    expect(def.edges.every((e) => e.target.nodeId === 'answerer')).toBe(true)
  })
})

describe('to-agent drag helpers: cascade drops the sibling on single-edge delete', () => {
  test('removing the ASK edge also drops the ANS edge of the same pair', () => {
    const def = wireQuestioner(baseDef())
    const askEdge = def.edges.find((e) => e.source.portName === '__clarify__') as WorkflowEdge
    const afterDelete: WorkflowDefinition = {
      ...def,
      edges: def.edges.filter((e) => e.id !== askEdge.id),
    }
    const next = cascadeRemoveToAgentChannel(afterDelete, [askEdge])
    expect(next.edges.length).toBe(0)
  })

  test('removing the ANSWERER edge does NOT cascade - it has no sibling', () => {
    let def = wireQuestioner(baseDef())
    def = applyToAgentAnswererDrag(def, { toAgentNodeId: 'to1', answererNodeId: 'answerer' })
    expect(def.edges.length).toBe(3)
    const answererEdge = def.edges.find((e) => e.source.portName === 'to_answerer') as WorkflowEdge
    const afterDelete: WorkflowDefinition = {
      ...def,
      edges: def.edges.filter((e) => e.id !== answererEdge.id),
    }
    const next = cascadeRemoveToAgentChannel(afterDelete, [answererEdge])
    // Questioner pair untouched (2 edges remain).
    expect(next.edges.length).toBe(2)
  })

  test('returns def by reference when no to-agent edges were removed', () => {
    const def = wireQuestioner(baseDef())
    const noisyEdge: WorkflowEdge = {
      id: 'unrelated',
      source: { nodeId: 'answerer', portName: 'main' },
      target: { nodeId: 'questioner', portName: 'inp' },
    }
    const next = cascadeRemoveToAgentChannel(def, [noisyEdge])
    expect(next).toBe(def)
  })
})

describe('to-agent drag helpers: classifier is kind-disjoint from cross-clarify', () => {
  test('to_questioner forward drop onto the catch-all matches as questioner-reverse', () => {
    const def = baseDef()
    const out = classifyToAgentConnection(def, {
      source: 'to1',
      target: 'questioner',
      sourceHandle: 'to_questioner',
      targetHandle: '__inbound__',
    })
    expect(out).toEqual({
      kind: 'questioner-reverse',
      questionerNodeId: 'questioner',
      toAgentNodeId: 'to1',
    })
  })

  test('to_answerer forward drop onto the catch-all matches as answerer-forward', () => {
    const def = baseDef()
    const out = classifyToAgentConnection(def, {
      source: 'to1',
      target: 'answerer',
      sourceHandle: 'to_answerer',
      targetHandle: '__inbound__',
    })
    expect(out).toEqual({
      kind: 'answerer-forward',
      toAgentNodeId: 'to1',
      answererNodeId: 'answerer',
    })
  })

  test('classifyCrossClarifyConnection returns null for a to-agent node (shared `questions` literal disambiguated by kind)', () => {
    const def = baseDef()
    const out = classifyCrossClarifyConnection(def, {
      source: 'questioner',
      target: 'to1',
      sourceHandle: '__clarify__',
      targetHandle: 'questions',
    })
    expect(out).toBeNull()
  })
})

describe('to-agent: computePorts dynamically registers __clarify_request__ on the answerer', () => {
  const byName = new Map<string, Agent>([['answerer', ANSWERER]])

  test('with a to_answerer edge, answerer A exposes __clarify_request__ as an input', () => {
    const def = applyToAgentAnswererDrag(baseDef(), {
      toAgentNodeId: 'to1',
      answererNodeId: 'answerer',
    })
    const answererNode = def.nodes.find((n) => n.id === 'answerer') as WorkflowNode
    const ports = computePorts(answererNode, byName, def)
    expect(ports.inputs).toContain('__clarify_request__')
  })

  test('without a to_answerer edge, answerer A does NOT expose __clarify_request__', () => {
    const def = baseDef()
    const answererNode = def.nodes.find((n) => n.id === 'answerer') as WorkflowNode
    const ports = computePorts(answererNode, byName, def)
    expect(ports.inputs).not.toContain('__clarify_request__')
  })
})

describe('to-agent: WorkflowCanvas wires the classifier + cascade (source-grep lock)', () => {
  test('classifyToAgentConnection is dispatched in onConnect AFTER the cross-clarify classifier', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    const cross = src.indexOf('classifyCrossClarifyConnection(definition, conn)')
    const toAgent = src.indexOf('classifyToAgentConnection(definition, conn)')
    expect(cross).toBeGreaterThan(-1)
    expect(toAgent).toBeGreaterThan(-1)
    expect(toAgent).toBeGreaterThan(cross)
  })

  test('cascadeRemoveToAgentChannel is wired into commitChange after cascadeRemoveCrossClarifyChannel', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    const cross = src.indexOf('cascadeRemoveCrossClarifyChannel(staged')
    const toAgent = src.indexOf('cascadeRemoveToAgentChannel(staged')
    expect(cross).toBeGreaterThan(-1)
    expect(toAgent).toBeGreaterThan(-1)
    expect(toAgent).toBeGreaterThan(cross)
  })

  test('the stray-drop guard covers to-agent handles alongside cross-clarify', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('isStrayToAgentChannelDrop(guardConn)')
  })
})

describe('to-agent: ToAgentClarifyNode renders disambiguating handle labels', () => {
  function renderNode() {
    return render(
      <ReactFlowProvider>
        <ToAgentClarifyNode
          id="to1"
          data={{
            nodeId: 'to1',
            kind: 'clarify-to-agent',
            title: 'to1',
            inputPorts: [],
            outputPorts: [],
          }}
          selected={false}
          type="clarify-to-agent"
          isConnectable
          dragging={false}
          zIndex={0}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          draggable
          selectable
          deletable
        />
      </ReactFlowProvider>,
    )
  }

  test('renders the container with the expected testid', () => {
    renderNode()
    const el = document.querySelector('[data-testid="canvas-node-clarify-to-agent-to1"]')
    expect(el).not.toBeNull()
  })

  test('renders a `to_questioner` (-> B) label with the expected testid', () => {
    renderNode()
    const el = document.querySelector('[data-testid="to-agent-handle-label-to-questioner"]')
    expect(el).not.toBeNull()
    expect(el?.textContent ?? '').toMatch(/B/)
  })

  test('renders a `to_answerer` (-> A) label with the expected testid', () => {
    renderNode()
    const el = document.querySelector('[data-testid="to-agent-handle-label-to-answerer"]')
    expect(el).not.toBeNull()
    expect(el?.textContent ?? '').toMatch(/A/)
  })
})

describe('to-agent: NodeInspector ToAgentClarifyEdit', () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

  function makeDef(
    nodes: WorkflowNode[],
    edges: WorkflowDefinition['edges'] = [],
  ): WorkflowDefinition {
    return { $schema_version: 4, inputs: [], nodes, edges }
  }

  function Host({
    initial,
    onChangeSpy,
  }: {
    initial: WorkflowDefinition
    onChangeSpy: (def: WorkflowDefinition) => void
  }) {
    const [def, setDef] = useState<WorkflowDefinition>(initial)
    return (
      <QueryClientProvider client={qc}>
        <NodeInspector
          definition={def}
          selectedNodeId="to1"
          agents={[]}
          onChange={(next) => {
            setDef(next)
            onChangeSpy(next)
          }}
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
  }

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ binary: 'opencode', cached: false, models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  test('title + description inputs flow through onChange', () => {
    const onChange = vi.fn()
    render(
      <Host
        initial={makeDef([
          {
            id: 'to1',
            kind: 'clarify-to-agent',
            title: '',
            description: '',
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    const titleInput = document.querySelector('input.form-input') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'Ask A' } })
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).title).toBe('Ask A')
  })

  test('shows linked-questioner (B) id when a __clarify__ edge points into the to-agent', () => {
    render(
      <Host
        initial={makeDef(
          [
            { id: 'answerer', kind: 'agent-single', agentName: 'answerer' },
            { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
            { id: 'to1', kind: 'clarify-to-agent' } as unknown as WorkflowNode,
          ],
          [
            {
              id: 'e_ask',
              source: { nodeId: 'questioner', portName: '__clarify__' },
              target: { nodeId: 'to1', portName: 'questions' },
            },
          ],
        )}
        onChangeSpy={() => {}}
      />,
    )
    const el = document.querySelector('[data-testid="to-agent-linked-questioner"]')
    expect(el?.textContent ?? '').toContain('questioner')
  })

  test('shows the linked-questioner-missing warning when no __clarify__ edge is wired', () => {
    render(
      <Host
        initial={makeDef([{ id: 'to1', kind: 'clarify-to-agent' } as unknown as WorkflowNode])}
        onChangeSpy={() => {}}
      />,
    )
    const el = document.querySelector('[data-testid="to-agent-linked-questioner-missing"]')
    expect(el).not.toBeNull()
  })

  test('shows linked-answerer (A) id when a to_answerer edge points at an answerer', () => {
    render(
      <Host
        initial={makeDef(
          [
            { id: 'answerer', kind: 'agent-single', agentName: 'answerer' },
            { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
            { id: 'to1', kind: 'clarify-to-agent' } as unknown as WorkflowNode,
          ],
          [
            {
              id: 'e_ans',
              source: { nodeId: 'to1', portName: 'to_answerer' },
              target: { nodeId: 'answerer', portName: '__clarify_request__' },
            },
          ],
        )}
        onChangeSpy={() => {}}
      />,
    )
    const el = document.querySelector('[data-testid="to-agent-linked-answerer"]')
    expect(el?.textContent ?? '').toContain('answerer')
  })

  test('sessionModeForAnswerer Segmented toggles to inline through onChange', () => {
    const onChange = vi.fn()
    render(
      <Host
        initial={makeDef([
          {
            id: 'to1',
            kind: 'clarify-to-agent',
            sessionModeForAnswerer: 'isolated',
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    const inlineBtn = document.querySelector(
      '[data-testid="to-agent-session-mode-answerer-inline"]',
    ) as HTMLButtonElement
    expect(inlineBtn).not.toBeNull()
    fireEvent.click(inlineBtn)
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).sessionModeForAnswerer).toBe('inline')
  })
})
