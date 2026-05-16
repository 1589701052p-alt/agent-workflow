// RFC-016 §3.1 / T5: GroupWrapperNode is the unified replacement for the
// old GitWrapperNode + LoopWrapperNode placeholder cards. These tests lock
// the structural contract: branching on data.kind picks the icon / label
// / pill, loop wrappers keep the RFC-003 catch-all but lose named left
// input ports, empty wrappers show the drop-here hint.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { GroupWrapperNode, type WrapperNodeData } from '../src/components/canvas/nodes/WrapperNodes'
import { INBOUND_HANDLE_ID } from '../src/components/canvas/nodes/types'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderNode(data: WrapperNodeData, selected = false) {
  // Cast to any so we don't need to mock the entire NodeProps surface.
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <GroupWrapperNode {...({ data, selected, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

function gitData(overrides: Partial<WrapperNodeData> = {}): WrapperNodeData {
  return {
    nodeId: 'w1',
    kind: 'wrapper-git',
    title: 'w1',
    inputPorts: [],
    outputPorts: ['out'],
    innerCount: 2,
    ...overrides,
  }
}
function loopData(overrides: Partial<WrapperNodeData> = {}): WrapperNodeData {
  return {
    nodeId: 'loop1',
    kind: 'wrapper-loop',
    title: 'loop1',
    inputPorts: [],
    outputPorts: ['result'],
    innerCount: 3,
    maxIterations: 5,
    exitConditionKind: 'port-equals',
    ...overrides,
  }
}

describe('GroupWrapperNode', () => {
  test('git wrapper carries the wrapper-group--git modifier class', () => {
    const { container } = renderNode(gitData())
    const root = container.querySelector('.canvas-node--wrapper-group')
    expect(root).not.toBeNull()
    expect(root?.classList.contains('canvas-node--wrapper-group--git')).toBe(true)
  })

  test('loop wrapper carries the wrapper-group--loop modifier class', () => {
    const { container } = renderNode(loopData())
    const root = container.querySelector('.canvas-node--wrapper-group')
    expect(root?.classList.contains('canvas-node--wrapper-group--loop')).toBe(true)
  })

  test('git pill renders the "snapshot" string', () => {
    const { container } = renderNode(gitData())
    const pill = container.querySelector('.wrapper-header-pill')
    expect(pill?.textContent).toContain('snapshot')
  })

  test('loop pill renders × maxIterations · exit condition kind', () => {
    const { container } = renderNode(
      loopData({ maxIterations: 7, exitConditionKind: 'port-empty' }),
    )
    const pill = container.querySelector('.wrapper-header-pill')
    expect(pill?.textContent).toContain('× 7')
    expect(pill?.textContent).toContain('port-empty')
  })

  test('loop wrapper keeps the catch-all inbound handle (RFC-003)', () => {
    const { container } = renderNode(loopData())
    const catchAll = container.querySelector('.canvas-node__handle--catchall')
    expect(catchAll).not.toBeNull()
    expect(catchAll?.getAttribute('data-handleid')).toBe(INBOUND_HANDLE_ID)
  })

  test('loop wrapper no longer renders named left input ports', () => {
    // Even when inputPorts contains entries (legacy data), the new node
    // only renders the catch-all on the left. Named-left handles would
    // have shown up as additional `.canvas-node__handle` elements with
    // a non-catchall class.
    const { container } = renderNode(loopData({ inputPorts: ['orphan_a', 'orphan_b'] }))
    const named = container.querySelectorAll(
      '.canvas-node__handle:not(.canvas-node__handle--catchall)',
    )
    // Right-side `outputPorts` handles are the only named ones expected.
    expect(named.length).toBe(1)
    expect(named[0]?.getAttribute('data-handleid')).toBe('result')
  })

  test('empty wrapper (innerCount=0) shows the "Drop nodes here" hint', () => {
    const { container } = renderNode(gitData({ innerCount: 0 }))
    expect(container.textContent ?? '').toContain('Drop nodes here')
  })

  test('non-empty wrapper does NOT show the drop-here hint', () => {
    const { container } = renderNode(gitData({ innerCount: 2 }))
    expect((container.textContent ?? '').includes('Drop nodes here')).toBe(false)
  })
})
