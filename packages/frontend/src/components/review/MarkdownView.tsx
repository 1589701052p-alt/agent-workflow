// MarkdownView — RFC-005 PR-C T17.
//
// Renders the markdown body of a review doc_version. We're deliberately
// not using a full remark/rehype pipeline (which would pull ~1MB of plugins);
// instead, `marked` for parsing + a custom renderer that turns ```mermaid /
// ```plantuml fenced blocks into placeholder elements which React then
// replaces with the appropriate diagram components. The rest of the HTML
// flows through DOMPurify before landing in the DOM.
//
// Image rendering for relative paths goes through the worktree-files proxy
// (`/api/worktree-files/:taskId/*`) — the proxy is token-authed by the same
// middleware as the rest of /api/*, so the browser fetch picks up the
// existing auth header via the api client wrapper.

import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { useEffect, useMemo, useRef } from 'react'
import { MermaidBlock } from './MermaidBlock'
import { PlantUmlBlock } from './PlantUmlBlock'

const DIAGRAM_MARKER = 'data-review-diagram'
const DIAGRAM_KIND = 'data-review-diagram-kind'
const DIAGRAM_SRC = 'data-review-diagram-src'

export interface MarkdownViewProps {
  /** Raw markdown body. */
  body: string
  /** Task id for resolving relative image paths via the worktree-files proxy. */
  taskId?: string
  /** Optional className for outer wrapper. */
  className?: string
  /**
   * PlantUML render endpoint. When empty / undefined, ```plantuml blocks
   * fall back to source-code rendering with a muted hint.
   */
  plantumlEndpoint?: string
  /** Optional Authorization header value for the plantuml endpoint. */
  plantumlAuthHeader?: string
}

/**
 * Build a fresh Marked instance per render context. Reusing a singleton is
 * tempting but the custom renderer references `taskId` which closes over
 * the current props, so we lazy-bind per-render.
 */
function buildMarked(taskId: string | undefined): Marked {
  const md = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
  })

  md.use({
    renderer: {
      code(token) {
        const text = typeof token === 'string' ? token : token.text
        const langInfo = typeof token === 'string' ? '' : (token.lang ?? '')
        const lang = langInfo.split(/\s+/)[0]?.toLowerCase() ?? ''
        if (lang === 'mermaid' || lang === 'plantuml') {
          // Emit a placeholder element React will hydrate. We base64-encode
          // the source to avoid HTML-escape headaches when the body contains
          // arrows, ampersands, etc.
          const b64 = typeof btoa === 'function' ? btoa(unicodeToBase64(text)) : ''
          return `<div ${DIAGRAM_MARKER}="1" ${DIAGRAM_KIND}="${lang}" ${DIAGRAM_SRC}="${b64}"></div>`
        }
        const escaped = escapeHtml(text)
        const cls = lang.length > 0 ? ` class="language-${escapeAttr(lang)}"` : ''
        return `<pre><code${cls}>${escaped}</code></pre>`
      },
      image(token) {
        const href = typeof token === 'string' ? '' : (token.href ?? '')
        const alt = typeof token === 'string' ? '' : (token.text ?? '')
        const title = typeof token === 'string' ? '' : (token.title ?? '')
        const resolvedHref = resolveImageHref(href, taskId)
        const titleAttr = title.length > 0 ? ` title="${escapeAttr(title)}"` : ''
        return `<img src="${escapeAttr(resolvedHref)}" alt="${escapeAttr(alt)}"${titleAttr} loading="lazy"/>`
      },
    },
  })
  return md
}

/**
 * Resolve a markdown image href to a fetchable URL.
 *
 * - Absolute URLs (http: / https: / data: / blob:) pass through unchanged.
 * - Workspace-relative paths get rewritten to /api/worktree-files/{taskId}/{path}
 *   when a taskId is provided; without one the original href stays (so the
 *   broken-image case is visible during preview).
 */
export function resolveImageHref(href: string, taskId: string | undefined): string {
  if (href.length === 0) return href
  if (/^(?:[a-z]+:|\/\/)/i.test(href)) return href
  if (taskId === undefined || taskId.length === 0) return href
  const clean = href.replace(/^\.\//, '').replace(/^\/+/, '')
  return `/api/worktree-files/${encodeURIComponent(taskId)}/${clean}`
}

/**
 * UTF-8 safe btoa input encoder.
 */
function unicodeToBase64(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => String.fromCharCode(b))
    .join('')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

export function MarkdownView({
  body,
  taskId,
  className,
  plantumlEndpoint,
  plantumlAuthHeader,
}: MarkdownViewProps) {
  // 1) Convert markdown → HTML via marked.
  const html = useMemo(() => {
    const m = buildMarked(taskId)
    const raw = m.parse(body, { async: false }) as string
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      // Keep our diagram-placeholder attrs through the sanitize pass.
      ADD_ATTR: [DIAGRAM_MARKER, DIAGRAM_KIND, DIAGRAM_SRC],
    })
  }, [body, taskId])

  // 2) After the HTML lands in the DOM, scan for diagram placeholders and
  // mount the corresponding React diagram component as a portal-style
  // attachment. Cheaper than a full HTML→React tree converter for the few
  // diagrams a typical design doc carries.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (rootRef.current === null) return
    const root = rootRef.current
    const placeholders = root.querySelectorAll(`[${DIAGRAM_MARKER}]`)
    const created: HTMLElement[] = []
    placeholders.forEach((node) => {
      const kind = node.getAttribute(DIAGRAM_KIND) ?? ''
      const b64 = node.getAttribute(DIAGRAM_SRC) ?? ''
      const source = b64.length > 0 ? base64ToUnicode(b64) : ''
      node.innerHTML = ''
      const mount = document.createElement('div')
      mount.className = 'review-diagram'
      mount.dataset.kind = kind
      node.appendChild(mount)
      created.push(mount)
      if (kind === 'mermaid') {
        void renderMermaidInto(mount, source)
      } else if (kind === 'plantuml') {
        renderPlantUmlInto(mount, source, plantumlEndpoint, plantumlAuthHeader)
      }
    })
    return () => {
      for (const m of created) {
        m.innerHTML = ''
      }
    }
  }, [html, plantumlEndpoint, plantumlAuthHeader])

  return (
    <div
      ref={rootRef}
      className={'markdown-view' + (className !== undefined ? ' ' + className : '')}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function base64ToUnicode(b64: string): string {
  try {
    const bin = typeof atob === 'function' ? atob(b64) : ''
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

async function renderMermaidInto(mount: HTMLElement, source: string): Promise<void> {
  if (source.length === 0) {
    mount.innerHTML = '<pre class="review-diagram__source">(empty diagram)</pre>'
    return
  }
  try {
    // Render via the MermaidBlock helper. We do a hand-mount instead of
    // ReactDOM.createRoot because this component renders alongside the
    // surrounding markdown HTML and we don't want to fragment the React
    // tree per diagram.
    await MermaidBlock.render(mount, source)
  } catch (err) {
    mount.innerHTML =
      `<div class="review-diagram__error">mermaid render failed: ${escapeHtml(
        (err as Error).message,
      )}</div>` + `<pre class="review-diagram__source"><code>${escapeHtml(source)}</code></pre>`
  }
}

function renderPlantUmlInto(
  mount: HTMLElement,
  source: string,
  endpoint: string | undefined,
  authHeader: string | undefined,
): void {
  PlantUmlBlock.render(mount, source, endpoint, authHeader)
}
