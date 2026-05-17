// Regression for the "blank node labels" bug found while debugging the
// markdown review page: MermaidBlock used to run mermaid's output through
// DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }),
// which silently strips <foreignObject> — the element mermaid uses to host
// the XHTML node/edge labels in flowcharts. The diagram came out with all
// boxes drawn but every label empty.
//
// This test mounts a stub mermaid module that returns an SVG containing a
// <foreignObject> with label text, then asserts that after MermaidBlock.render,
// (a) the <foreignObject> survives, and (b) its label text is still readable.
// If a future refactor reintroduces a second DOMPurify pass over the SVG,
// this assertion will go red.

import { describe, expect, test, vi, beforeEach } from 'vitest'

vi.mock('mermaid', () => {
  return {
    default: {
      initialize: vi.fn(),
      render: vi.fn(async (_id: string, _src: string) => {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" class="flowchart" viewBox="0 0 200 80">' +
          '<g class="node">' +
          '<rect width="180" height="40" />' +
          '<foreignObject width="180" height="40">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" class="nodeLabel">' +
          '<span class="nodeLabel">hello world</span>' +
          '</div>' +
          '</foreignObject>' +
          '</g>' +
          '</svg>'
        return { svg }
      }),
    },
  }
})

import { MermaidBlock } from '../src/components/review/MermaidBlock'

describe('MermaidBlock — node labels survive rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('foreignObject and its XHTML label children are preserved', async () => {
    const mount = document.createElement('div')
    document.body.appendChild(mount)

    await MermaidBlock.render(mount, 'flowchart TD\n A[hello world]')

    const svg = mount.querySelector('svg')
    expect(svg).not.toBeNull()
    const fo = mount.querySelectorAll('foreignObject')
    expect(fo.length).toBe(1)
    // The XHTML label inside the foreignObject must survive. A previous
    // DOMPurify(svg-only) pass was wiping it out.
    expect(mount.textContent ?? '').toContain('hello world')
  })
})
