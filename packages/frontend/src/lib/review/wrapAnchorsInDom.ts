// Wraps review-comment anchors in the rendered markdown DOM with
// <mark class="comment-anchor" data-comment-id="..."> so the bubble layout
// and IntersectionObserver scroll-spy can locate them.
//
// The rendered markdown body lives in a ref'd <div>; on every change to
// `comments` or the rendered body, the route effect calls
// wrapAnchorsInDom(rootEl, anchors). Idempotent: any previously inserted
// marks are unwrapped first.
//
// Pure DOM helper, no React.

import { findAllOccurrences } from './anchor'

const SKIP_TAGS = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE'])

export interface AnchorWrap {
  commentId: string
  selectedText: string
  /** 1-based, matches ReviewCommentAnchor.occurrenceIndex. */
  occurrenceIndex: number
}

interface TextSegment {
  node: Text
  /** Char offset where this node's data begins in the concatenated text. */
  start: number
}

function isSkippedElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true
  // NB: previously we also skipped <mark.comment-anchor> during collection
  // so that a wrapped selection wouldn't be counted twice. That stripped
  // every prior comment's text out of the walked output, which broke
  // adjacent/overlapping anchors: if comment B's selectedText overlapped
  // (or even just *contained* a character from) comment A's already-wrapped
  // span, B's findAllOccurrences returned zero, no mark was inserted, the
  // bubble layout couldn't measure a position, and the bubble collapsed to
  // the static top:0 location — visually leaving only one comment on
  // screen. Walking into existing marks instead lets B find its text and
  // pick up a position; if a later wrap lands inside an existing mark the
  // result is a nested <mark> (cosmetic — the per-comment querySelector
  // still finds it).
  return false
}

/**
 * Walk `root` in document order, collecting text-node data while skipping
 * code blocks and already-wrapped anchors. Returns the concatenated text +
 * segment offsets so callers can translate (text-offset → DOM position).
 */
function collectTextNodes(root: HTMLElement): { text: string; segments: TextSegment[] } {
  const segments: TextSegment[] = []
  let text = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element
      if (el !== root && isSkippedElement(el)) return
      for (let c = el.firstChild; c !== null; c = c.nextSibling) walk(c)
    } else if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text
      if (t.data.length === 0) return
      segments.push({ node: t, start: text.length })
      text += t.data
    }
  }
  walk(root)
  return { text, segments }
}

/**
 * Strip every <mark.comment-anchor> in `root`, leaving its children in
 * place. Coalesces adjacent text nodes via `normalize()` so the next pass
 * sees clean text.
 */
export function unwrapAnchors(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll<HTMLElement>('mark.comment-anchor'))
  for (const m of marks) {
    const parent = m.parentNode
    if (parent === null) continue
    while (m.firstChild !== null) parent.insertBefore(m.firstChild, m)
    parent.removeChild(m)
  }
  root.normalize()
}

/**
 * Wrap each anchor's text selection in the rendered DOM. Existing
 * comment-anchor marks are unwrapped first so this function is safe to
 * call on every render.
 */
export function wrapAnchorsInDom(root: HTMLElement, anchors: AnchorWrap[]): void {
  unwrapAnchors(root)
  for (const a of anchors) {
    if (a.selectedText.length === 0) continue
    const { text, segments } = collectTextNodes(root)
    const occs = findAllOccurrences(text, a.selectedText)
    if (occs.length === 0) continue
    const clamped = Math.min(Math.max(a.occurrenceIndex - 1, 0), occs.length - 1)
    const startOff = occs[clamped]!
    const endOff = startOff + a.selectedText.length
    wrapRange(segments, startOff, endOff, a.commentId)
  }
}

/**
 * Wrap the sub-range [startOff, endOff) of the concatenated text. For each
 * text segment that intersects the range, splitText off the prefix /
 * suffix and wrap the middle in a fresh <mark>. Selections that span
 * multiple text nodes produce multiple sibling <mark> elements all sharing
 * the same data-comment-id.
 */
function wrapRange(
  segments: TextSegment[],
  startOff: number,
  endOff: number,
  commentId: string,
): void {
  for (const seg of segments) {
    const segEnd = seg.start + seg.node.data.length
    if (segEnd <= startOff) continue
    if (seg.start >= endOff) break
    const from = Math.max(0, startOff - seg.start)
    const to = Math.min(seg.node.data.length, endOff - seg.start)
    if (from >= to) continue
    let target = seg.node
    if (from > 0) target = target.splitText(from)
    if (to - from < target.data.length) target.splitText(to - from)
    const doc = target.ownerDocument ?? document
    const m = doc.createElement('mark')
    m.className = 'comment-anchor'
    m.setAttribute('data-comment-id', commentId)
    target.parentNode?.insertBefore(m, target)
    m.appendChild(target)
  }
}
