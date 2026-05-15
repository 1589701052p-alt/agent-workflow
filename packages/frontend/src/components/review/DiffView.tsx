// DiffView — RFC-005 PR-E T34.
//
// Side-by-side diff of two doc_version bodies with selectable granularity:
//   - word   : jsdiff diffWordsWithSpace + Intl.Segmenter for CJK
//   - line   : jsdiff diffLines
//   - block  : split on blank-line boundaries, then jsdiff (paragraph-ish)
//
// Both panes show the same markdown bodies but with insert/delete spans
// styled. Heading rows on either side get a `data-heading-slug` attribute
// so the parent component can sync-scroll one side to the other by
// matching slugs.

import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import { useEffect, useMemo, useRef } from 'react'

export type DiffGranularity = 'word' | 'line' | 'block'

export interface DiffViewProps {
  left: string
  right: string
  granularity: DiffGranularity
  /** Stable id for left / right pane so scroll sync can pair them. */
  leftLabel?: string
  rightLabel?: string
  /** Optional callback invoked on horizontal sync — when one pane scrolls
   *  to a heading, the consumer can scroll its companion view (the live
   *  comment sidebar etc.) along. */
  onScrollSync?: (slug: string, side: 'left' | 'right') => void
}

interface Segment {
  text: string
  kind: 'context' | 'insert' | 'delete'
}

/**
 * UTF-8 / CJK-safe word splitter. jsdiff's diffWords splits on `\W` which
 * collapses Chinese text into a single token; we pre-segment Chinese with
 * Intl.Segmenter when available so the diff goes per-CJK-character.
 */
function splitForWordDiff(s: string): string {
  // diff library's diffWordsWithSpace already handles whitespace + punctuation;
  // for CJK we widen by inserting a hair-space between graphemes so the splitter
  // sees them as separate tokens. The space is dropped before display.
  const Seg = (globalThis as Record<string, unknown>).Intl as
    | { Segmenter?: typeof Intl.Segmenter }
    | undefined
  if (Seg?.Segmenter === undefined) return s
  // Heuristic: only segment when CJK present, to avoid touching pure-ASCII.
  // eslint-disable-next-line no-irregular-whitespace
  if (!/[　-鿿가-힯]/.test(s)) return s
  const seg = new Seg.Segmenter('zh', { granularity: 'word' })
  let out = ''
  for (const it of seg.segment(s)) {
    out += it.segment
    out += '\u200B' // zero-width space delimiter
  }
  return out
}

function postProcessWordSegments(segments: Segment[]): Segment[] {
  // Strip the zero-width spaces we injected for the CJK splitter.
  return segments.map((s) => ({ ...s, text: s.text.replace(/\u200B/g, '') }))
}

function diffBlocks(left: string, right: string): Change[] {
  const splitBlocks = (s: string): string[] => s.split(/\n{2,}/g)
  const L = splitBlocks(left).join('\n')
  const R = splitBlocks(right).join('\n')
  const raw = diffLines(L, R)
  return raw.map((c) => ({ ...c, value: c.value.replace(/\n/g, '\n\n') }))
}

function computeDiff(left: string, right: string, granularity: DiffGranularity): Change[] {
  if (granularity === 'word') {
    return diffWordsWithSpace(splitForWordDiff(left), splitForWordDiff(right))
  }
  if (granularity === 'line') return diffLines(left, right)
  return diffBlocks(left, right)
}

function changesToSegments(changes: Change[]): { left: Segment[]; right: Segment[] } {
  const left: Segment[] = []
  const right: Segment[] = []
  for (const c of changes) {
    if (c.added === true) {
      right.push({ text: c.value, kind: 'insert' })
    } else if (c.removed === true) {
      left.push({ text: c.value, kind: 'delete' })
    } else {
      left.push({ text: c.value, kind: 'context' })
      right.push({ text: c.value, kind: 'context' })
    }
  }
  return { left, right }
}

function headingSlug(line: string): string | null {
  const m = /^(#{1,6})\s+(.+)$/.exec(line.trim())
  if (m === null) return null
  return slugify(m[2] ?? '')
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/gi, '-')
    .replace(/^-+|-+$/g, '')
}

function renderPane(
  segments: Segment[],
  paneRef: React.RefObject<HTMLDivElement | null>,
): React.ReactElement {
  // Stitch segments back together preserving newlines so we can render line
  // by line + map heading lines to anchors.
  const text = segments.map((s) => s.text).join('')
  const lines = text.split('\n')
  // Build a parallel map from absolute char offset → segment kind. This lets
  // us coloring lines that fall inside an insert/delete span.
  const charKinds: ('context' | 'insert' | 'delete')[] = new Array(text.length).fill('context')
  let offset = 0
  for (const seg of segments) {
    for (let i = 0; i < seg.text.length; i++) charKinds[offset + i] = seg.kind
    offset += seg.text.length
  }
  let charPos = 0
  return (
    <div ref={paneRef} className="diff-view__pane" role="region">
      {lines.map((line, idx) => {
        const slug = headingSlug(line)
        const lineStart = charPos
        const lineEnd = lineStart + line.length
        let kind: 'context' | 'insert' | 'delete' = 'context'
        for (let i = lineStart; i < lineEnd; i++) {
          if (charKinds[i] === 'insert') {
            kind = 'insert'
            break
          }
          if (charKinds[i] === 'delete') {
            kind = 'delete'
            break
          }
        }
        charPos = lineEnd + 1 // +1 for the '\n' between lines
        return (
          <div
            key={idx}
            className={`diff-view__line diff-view__line--${kind}`}
            data-heading-slug={slug ?? undefined}
          >
            {line.length === 0 ? ' ' : line}
          </div>
        )
      })}
    </div>
  )
}

export function DiffView({
  left,
  right,
  granularity,
  leftLabel,
  rightLabel,
  onScrollSync,
}: DiffViewProps) {
  const { left: leftSegments, right: rightSegments } = useMemo(() => {
    const changes = computeDiff(left, right, granularity)
    const initial = changesToSegments(changes)
    if (granularity === 'word') {
      return {
        left: postProcessWordSegments(initial.left),
        right: postProcessWordSegments(initial.right),
      }
    }
    return initial
  }, [left, right, granularity])

  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // Heading-anchored scroll sync: when one pane scrolls, find the heading
  // closest to its viewport top, then scroll the other pane to its matching
  // slug (if present).
  useEffect(() => {
    const L = leftRef.current
    const R = rightRef.current
    if (L === null || R === null) return
    let syncing = false
    const handler = (src: 'left' | 'right') => () => {
      if (syncing) return
      const root = src === 'left' ? L : R
      const peer = src === 'left' ? R : L
      const headings = Array.from(
        root.querySelectorAll<HTMLElement>('.diff-view__line[data-heading-slug]'),
      )
      const rootTop = root.getBoundingClientRect().top
      let best: { slug: string; el: HTMLElement } | null = null
      for (const h of headings) {
        const top = h.getBoundingClientRect().top
        if (top - rootTop <= 0) {
          const slug = h.dataset.headingSlug ?? ''
          best = { slug, el: h }
        } else {
          break
        }
      }
      if (best === null) return
      const peerMatch = peer.querySelector<HTMLElement>(
        `.diff-view__line[data-heading-slug="${best.slug}"]`,
      )
      if (peerMatch === null) return
      syncing = true
      try {
        peerMatch.scrollIntoView({ block: 'start', behavior: 'auto' })
        onScrollSync?.(best.slug, src)
      } finally {
        setTimeout(() => {
          syncing = false
        }, 30)
      }
    }
    const leftHandler = handler('left')
    const rightHandler = handler('right')
    L.addEventListener('scroll', leftHandler)
    R.addEventListener('scroll', rightHandler)
    return () => {
      L.removeEventListener('scroll', leftHandler)
      R.removeEventListener('scroll', rightHandler)
    }
  }, [onScrollSync])

  return (
    <div className="diff-view">
      <div className="diff-view__pane-wrap">
        {leftLabel !== undefined && <div className="diff-view__label muted">{leftLabel}</div>}
        {renderPane(leftSegments, leftRef)}
      </div>
      <div className="diff-view__pane-wrap">
        {rightLabel !== undefined && <div className="diff-view__label muted">{rightLabel}</div>}
        {renderPane(rightSegments, rightRef)}
      </div>
    </div>
  )
}

// Exported for unit tests.
export const _internal = {
  splitForWordDiff,
  changesToSegments,
  computeDiff,
  diffBlocks,
  headingSlug,
  slugify,
}
