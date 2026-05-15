// RFC-008 T1 — ```mermaid blocks route to the MermaidBlock React shell.
//
// We mock MermaidBlock.render so the test doesn't pull mermaid's ~3MB
// runtime; we just need to confirm the dispatch path (pre override → lang
// extraction → MermaidDiagram component → MermaidBlock.render call).

import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const renderSpy = vi.fn()
vi.mock('@/components/review/MermaidBlock', () => ({
  MermaidBlock: {
    render: (mount: HTMLElement, source: string) => {
      renderSpy(source)
      mount.innerHTML = '<svg data-mocked="mermaid"/>'
      return Promise.resolve()
    },
  },
}))

import { Prose } from '@/components/prose/Prose'

describe('Prose — mermaid fenced block', () => {
  beforeEach(() => {
    renderSpy.mockClear()
  })

  test('``` mermaid `` mounts a prose__diagram--mermaid container', () => {
    const md = '```mermaid\nsequenceDiagram\nA->>B: hi\n```'
    const { container } = render(<Prose body={md} />)
    const node = container.querySelector('[data-prose-diagram="mermaid"]')
    expect(node).not.toBeNull()
    expect(node?.className).toContain('prose__diagram')
  })

  test('MermaidBlock.render is called with the un-fenced source', () => {
    const md = '```mermaid\nsequenceDiagram\nA->>B: hi\n```'
    render(<Prose body={md} />)
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(renderSpy.mock.calls[0]?.[0]).toContain('sequenceDiagram')
    expect(renderSpy.mock.calls[0]?.[0]).toContain('A->>B: hi')
  })

  test('a plain js fence does NOT route to MermaidBlock', () => {
    const md = '```js\nconst x = 1\n```'
    render(<Prose body={md} />)
    expect(renderSpy).not.toHaveBeenCalled()
  })
})
