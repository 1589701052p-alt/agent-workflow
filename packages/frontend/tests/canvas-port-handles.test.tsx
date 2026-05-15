// PortHandles — RFC-003 catch-all rendering & precedence.
//
// xyflow's Handle requires a ReactFlowProvider in context. We wrap the
// component under test in <ReactFlowProvider> so xyflow's hooks can run
// without complaining; we don't assert on its internal state.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { PortHandles } from '../src/components/canvas/nodes/PortHandles'
import { INBOUND_HANDLE_ID } from '../src/components/canvas/nodes/types'

afterEach(() => {
  document.body.innerHTML = ''
})

function renderHandles(ui: React.ReactNode) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>)
}

describe('PortHandles', () => {
  test('side=left, no ports, no catchAll → renders nothing', () => {
    const { container } = renderHandles(<PortHandles side="left" ports={[]} />)
    expect(container.querySelectorAll('.canvas-node__handle').length).toBe(0)
  })

  test('side=left, no ports + catchAll → 1 invisible target handle', () => {
    const { container } = renderHandles(
      <PortHandles side="left" ports={[]} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = container.querySelectorAll('.canvas-node__handle')
    expect(handles.length).toBe(1)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(true)
    expect(handles[0]?.getAttribute('data-handleid')).toBe(INBOUND_HANDLE_ID)
  })

  test('side=left, ports + catchAll → catch-all rendered BEFORE named handles', () => {
    const { container } = renderHandles(
      <PortHandles side="left" ports={['a', 'b']} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = Array.from(container.querySelectorAll('.canvas-node__handle'))
    expect(handles.length).toBe(3)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(true)
    // Named handles do NOT carry the catchall class — they win on z-index
    // (asserted via styles.css; not testable here but the class separation
    // is the structural guarantee).
    expect(handles[1]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
    expect(handles[2]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
    // Named handle ids are the port names.
    expect(handles[1]?.getAttribute('data-handleid')).toBe('a')
    expect(handles[2]?.getAttribute('data-handleid')).toBe('b')
  })

  test('side=right + catchAll → catch-all is ignored (right side has no inbound)', () => {
    const { container } = renderHandles(
      <PortHandles side="right" ports={['a']} catchAll={{ id: INBOUND_HANDLE_ID }} />,
    )
    const handles = container.querySelectorAll('.canvas-node__handle')
    expect(handles.length).toBe(1)
    expect(handles[0]?.classList.contains('canvas-node__handle--catchall')).toBe(false)
  })
})
