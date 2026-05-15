// Locks in the pure DOM helper that wraps review-comment anchors in the
// rendered markdown body. The helper exists so the IntersectionObserver
// scroll-spy in /reviews/:nodeRunId can find [data-comment-id] anchors
// (previously a no-op — the spy queried for elements that nobody ever
// inserted) and so the bubble layout effect can measure each anchor's
// vertical offset.

import { beforeEach, describe, expect, test } from 'vitest'
import { unwrapAnchors, wrapAnchorsInDom } from '@/lib/review/wrapAnchorsInDom'

describe('wrapAnchorsInDom', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.append(root)
  })

  test('wraps the n-th occurrence (occurrenceIndex is 1-based)', () => {
    root.innerHTML = '<p>foo bar foo baz foo</p>'
    wrapAnchorsInDom(root, [{ commentId: 'c1', selectedText: 'foo', occurrenceIndex: 2 }])
    const marks = root.querySelectorAll('mark.comment-anchor')
    expect(marks.length).toBe(1)
    expect(marks[0]!.textContent).toBe('foo')
    expect(marks[0]!.getAttribute('data-comment-id')).toBe('c1')
    // The wrapped occurrence should be the second one. Verify by checking
    // the prefix text: everything before the <mark> should contain exactly
    // one "foo".
    const html = root.innerHTML
    const before = html.split('<mark')[0] ?? ''
    expect(before.match(/foo/g)?.length).toBe(1)
  })

  test('skips text inside <pre> / <code> blocks', () => {
    root.innerHTML = '<p>need</p><pre>need need</pre><p>need</p>'
    wrapAnchorsInDom(root, [{ commentId: 'c1', selectedText: 'need', occurrenceIndex: 2 }])
    const marks = root.querySelectorAll('mark.comment-anchor')
    expect(marks.length).toBe(1)
    // occurrenceIndex 2 (after skipping pre) is the second visible "need" —
    // i.e. the one in the trailing <p>, not anywhere inside <pre>.
    expect(marks[0]!.parentElement!.tagName).toBe('P')
    expect(root.querySelector('pre')!.innerHTML).toBe('need need')
  })

  test('idempotent across repeated calls (unwraps previous marks)', () => {
    root.innerHTML = '<p>alpha beta gamma</p>'
    const anchors = [{ commentId: 'c1', selectedText: 'beta', occurrenceIndex: 1 }]
    wrapAnchorsInDom(root, anchors)
    wrapAnchorsInDom(root, anchors)
    wrapAnchorsInDom(root, anchors)
    expect(root.querySelectorAll('mark.comment-anchor').length).toBe(1)
    expect(root.textContent).toBe('alpha beta gamma')
  })

  test('selection that spans an element boundary wraps each text node', () => {
    root.innerHTML = '<p>hello <em>cruel</em> world</p>'
    wrapAnchorsInDom(root, [{ commentId: 'c1', selectedText: 'cruel world', occurrenceIndex: 1 }])
    const marks = root.querySelectorAll('mark.comment-anchor')
    // "cruel" lives in <em>, " world" lives in the trailing text node — two marks.
    expect(marks.length).toBe(2)
    for (const m of marks) {
      expect(m.getAttribute('data-comment-id')).toBe('c1')
    }
    expect(
      Array.from(marks)
        .map((m) => m.textContent)
        .join(''),
    ).toBe('cruel world')
  })

  test('leaves DOM untouched when selectedText is absent', () => {
    root.innerHTML = '<p>nothing matches here</p>'
    const before = root.innerHTML
    wrapAnchorsInDom(root, [{ commentId: 'c1', selectedText: 'xyz', occurrenceIndex: 1 }])
    expect(root.innerHTML).toBe(before)
  })

  test('wraps multiple distinct anchors simultaneously', () => {
    root.innerHTML = '<p>aa bb cc</p>'
    wrapAnchorsInDom(root, [
      { commentId: 'c1', selectedText: 'aa', occurrenceIndex: 1 },
      { commentId: 'c2', selectedText: 'cc', occurrenceIndex: 1 },
    ])
    const marks = root.querySelectorAll('mark.comment-anchor')
    expect(marks.length).toBe(2)
    const byId = new Map(Array.from(marks).map((m) => [m.getAttribute('data-comment-id'), m]))
    expect(byId.get('c1')!.textContent).toBe('aa')
    expect(byId.get('c2')!.textContent).toBe('cc')
  })

  test('out-of-range occurrenceIndex clamps to the last available occurrence', () => {
    root.innerHTML = '<p>x y x z</p>'
    wrapAnchorsInDom(root, [{ commentId: 'c1', selectedText: 'x', occurrenceIndex: 99 }])
    const marks = root.querySelectorAll('mark.comment-anchor')
    expect(marks.length).toBe(1)
    // The clamp should pick the *last* "x" — verify nothing after the mark contains "x".
    const html = root.innerHTML
    const after = html.split('</mark>').pop() ?? ''
    expect(after.includes('x')).toBe(false)
  })

  // Regression: user report "only one review comment renders" — the wrap
  // helper used to skip text inside existing <mark.comment-anchor> when
  // collecting nodes, so two comments anchored to adjacent/overlapping
  // selections in the same paragraph lost the second match: comment B's
  // selectedText was no longer findable in the walked text once A had been
  // wrapped, so B never got a [data-comment-id] mark, the bubble layout
  // measure couldn't position it, and it collapsed onto bubble A at top 0.
  test('adjacent anchors in the same text node each get their own mark', () => {
    root.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>'
    wrapAnchorsInDom(root, [
      { commentId: 'cA', selectedText: 'quick brown', occurrenceIndex: 1 },
      { commentId: 'cB', selectedText: 'lazy dog', occurrenceIndex: 1 },
    ])
    expect(root.querySelector('mark.comment-anchor[data-comment-id="cA"]')).not.toBeNull()
    expect(root.querySelector('mark.comment-anchor[data-comment-id="cB"]')).not.toBeNull()
    // The unwrapped text is preserved (no character loss from the splits).
    expect(root.textContent).toBe('the quick brown fox jumps over the lazy dog')
  })

  test('overlapping anchors each get their own mark (later may nest inside earlier)', () => {
    root.innerHTML = '<p>the quick brown fox jumps over the lazy dog</p>'
    wrapAnchorsInDom(root, [
      { commentId: 'cA', selectedText: 'quick brown fox', occurrenceIndex: 1 },
      { commentId: 'cB', selectedText: 'brown fox jumps', occurrenceIndex: 1 },
    ])
    // Both marks must exist — even though the selections overlap. The
    // measure step in the review route picks the first match per id, so
    // the position can always be computed.
    expect(root.querySelector('mark.comment-anchor[data-comment-id="cA"]')).not.toBeNull()
    expect(root.querySelector('mark.comment-anchor[data-comment-id="cB"]')).not.toBeNull()
    expect(root.textContent).toBe('the quick brown fox jumps over the lazy dog')
  })

  test('three comments on the same paragraph all get marks (was the user repro)', () => {
    // Mirrors a typical review pattern: several comments left on different
    // phrases of the same paragraph. Before the fix, only the first
    // comment's mark survived because subsequent collectTextNodes calls
    // skipped the already-wrapped text and lost the others' anchors.
    root.innerHTML = '<p>alpha beta gamma delta epsilon zeta</p>'
    wrapAnchorsInDom(root, [
      { commentId: 'c1', selectedText: 'alpha', occurrenceIndex: 1 },
      { commentId: 'c2', selectedText: 'gamma', occurrenceIndex: 1 },
      { commentId: 'c3', selectedText: 'epsilon', occurrenceIndex: 1 },
    ])
    expect(root.querySelector('mark.comment-anchor[data-comment-id="c1"]')).not.toBeNull()
    expect(root.querySelector('mark.comment-anchor[data-comment-id="c2"]')).not.toBeNull()
    expect(root.querySelector('mark.comment-anchor[data-comment-id="c3"]')).not.toBeNull()
    expect(root.textContent).toBe('alpha beta gamma delta epsilon zeta')
  })
})

describe('unwrapAnchors', () => {
  test('strips every <mark.comment-anchor> and merges adjacent text nodes', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<p>before <mark class="comment-anchor" data-comment-id="c1">selected</mark> after</p>'
    unwrapAnchors(root)
    expect(root.querySelector('mark.comment-anchor')).toBeNull()
    expect(root.textContent).toBe('before selected after')
    // normalize() should have coalesced — only one text child inside <p>.
    expect(root.querySelector('p')!.childNodes.length).toBe(1)
  })

  test('leaves unrelated <mark> elements alone', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>this is <mark>highlighted</mark> text</p>'
    unwrapAnchors(root)
    expect(root.querySelector('mark')).not.toBeNull()
  })
})
