// PlantUmlBlock — RFC-005 PR-C T18.
//
// Renders ```plantuml fenced blocks via a user-configured external HTTP
// renderer (kroki-compatible). We do NOT bundle plantuml.jar — that would
// pull in a GPL dependency and require a JVM at runtime; instead the
// platform stays GPL-free and the user wires in their own endpoint (or
// kroki.io if they accept the privacy implications).
//
// Render path:
//   1. If no endpoint configured → fallback to a `<pre>` source dump with
//      a muted hint pointing users at Settings → Rendering.
//   2. Try GET `{endpoint}/plantuml/svg/{deflate-base64}` (kroki format).
//   3. On non-2xx or network failure, fall back to POST `{endpoint}/plantuml/svg`
//      with `text/plain` body (plantuml-server format).
//   4. On any failure → show the error + fall through to source code.
//
// The static helper (PlantUmlBlock.render) mounts directly into a DOM
// element handed in by MarkdownView; no React tree per diagram.

import DOMPurify from 'dompurify'
import pako from 'pako'

export const PlantUmlBlock = {
  /**
   * Synchronously mount the loading state, then kick off the fetch.
   * The mount element receives an SVG when the fetch resolves, or a
   * source-code dump if all attempts fail.
   */
  render(
    mount: HTMLElement,
    source: string,
    endpoint: string | undefined,
    authHeader: string | undefined,
  ): void {
    mount.innerHTML = ''
    if (endpoint === undefined || endpoint.trim().length === 0) {
      mount.appendChild(buildUnconfigured(source))
      return
    }
    mount.appendChild(buildLoading())
    void fetchAndSwap(mount, source, endpoint, authHeader)
  },

  /**
   * Encode source for kroki GET-path: zlib deflate then base64-url.
   * Exported for tests.
   */
  encodeForGet(source: string): string {
    const bytes = new TextEncoder().encode(source)
    const deflated = pako.deflateRaw(bytes)
    return base64UrlEncode(deflated)
  },
}

async function fetchAndSwap(
  mount: HTMLElement,
  source: string,
  endpoint: string,
  authHeader: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = {}
  if (authHeader !== undefined && authHeader.length > 0) headers['Authorization'] = authHeader
  const base = endpoint.replace(/\/+$/, '')
  // 1) GET kroki-style.
  let svg: string | null = null
  let lastErr: Error | null = null
  try {
    const encoded = PlantUmlBlock.encodeForGet(source)
    const r = await fetch(`${base}/plantuml/svg/${encoded}`, { headers })
    if (r.ok) {
      svg = await r.text()
    } else {
      lastErr = new Error(`GET returned ${r.status}`)
    }
  } catch (err) {
    lastErr = err as Error
  }
  // 2) POST raw fallback.
  if (svg === null) {
    try {
      const r = await fetch(`${base}/plantuml/svg`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'text/plain' },
        body: source,
      })
      if (r.ok) {
        svg = await r.text()
      } else {
        lastErr = new Error(`POST returned ${r.status}`)
      }
    } catch (err) {
      lastErr = err as Error
    }
  }

  mount.innerHTML = ''
  if (svg !== null && svg.includes('<svg')) {
    const wrap = document.createElement('div')
    wrap.className = 'review-diagram__svg'
    wrap.innerHTML = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    })
    mount.appendChild(wrap)
    return
  }
  mount.appendChild(buildErrorWithSource(source, lastErr?.message ?? 'unknown error'))
}

function buildUnconfigured(source: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__unconfigured'
  const hint = document.createElement('div')
  hint.className = 'review-diagram__hint'
  hint.textContent = 'plantuml endpoint not configured (Settings → Rendering); showing source.'
  const pre = document.createElement('pre')
  pre.className = 'review-diagram__source'
  pre.textContent = source
  wrap.appendChild(hint)
  wrap.appendChild(pre)
  return wrap
}

function buildLoading(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__loading'
  wrap.textContent = 'rendering…'
  return wrap
}

function buildErrorWithSource(source: string, msg: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'review-diagram__error-wrap'
  const err = document.createElement('div')
  err.className = 'review-diagram__error'
  err.textContent = `plantuml render failed: ${msg}`
  const pre = document.createElement('pre')
  pre.className = 'review-diagram__source'
  pre.textContent = source
  wrap.appendChild(err)
  wrap.appendChild(pre)
  return wrap
}

/**
 * Standard kroki base64-url encoding: same alphabet as base64url but with
 * a stable padding-trimmed form so the URL stays compact.
 */
function base64UrlEncode(bytes: Uint8Array): string {
  let str = ''
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]!)
  const b64 = typeof btoa === 'function' ? btoa(str) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
