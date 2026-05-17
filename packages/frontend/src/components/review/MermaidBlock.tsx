// MermaidBlock — RFC-005 PR-C T17.
//
// Renders ```mermaid fenced blocks. mermaid is a ~3 MB dependency at the
// time of writing, so we lazy-load it the first time a diagram appears in
// the rendered markdown. The component is a static helper, not a React
// component — see MarkdownView for why we mount diagrams as DOM-side
// attachments (one React tree for the whole document, not per diagram).
//
// NOTE: we intentionally do not run an extra DOMPurify pass on the SVG
// mermaid returns. mermaid flowcharts emit node labels as <foreignObject>
// wrapping XHTML, and no DOMPurify configuration we tested (svg profile,
// html profile, ADD_TAGS: ['foreignObject'], PARSER_MEDIA_TYPE xhtml) can
// preserve the foreignObject children through the SVG↔HTML namespace
// transition — the labels come out blank. mermaid.initialize already
// applies its own DOMPurify in `securityLevel: 'strict'` mode (text-level
// `<script>` is encoded, click handlers disabled), so this is the
// defensive layer; an outer pass was double-sanitizing and breaking
// labels (see the prose-code-mermaid-labels regression test).

import type * as MermaidNS from 'mermaid'

type Mermaid = (typeof MermaidNS)['default']

let mermaidPromise: Promise<Mermaid> | null = null

async function loadMermaid(): Promise<Mermaid> {
  if (mermaidPromise === null) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict' })
      return m.default
    })
  }
  return mermaidPromise
}

function isMermaidAvailable(): boolean {
  // We can't synchronously check whether `mermaid` is installed in tests
  // running under happy-dom; treat the lazy import as available unless
  // explicitly turned off (no env switch yet).
  return true
}

export const MermaidBlock = {
  /**
   * Async render. Resolves when the SVG is in place (or an error message
   * if rendering failed). Caller hands us the mount element + the diagram
   * source.
   */
  async render(mount: HTMLElement, source: string): Promise<void> {
    if (!isMermaidAvailable()) {
      mount.innerHTML =
        '<pre class="review-diagram__source"><code>' + escapeHtml(source) + '</code></pre>'
      return
    }
    try {
      const mermaid = await loadMermaid()
      const id = 'mermaid-' + Math.random().toString(36).slice(2, 10)
      const { svg } = await mermaid.render(id, source)
      mount.innerHTML = svg
    } catch (err) {
      mount.innerHTML =
        `<div class="review-diagram__error">${escapeHtml((err as Error).message)}</div>` +
        `<pre class="review-diagram__source"><code>${escapeHtml(source)}</code></pre>`
    }
  },
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
