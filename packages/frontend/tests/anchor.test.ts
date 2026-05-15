// RFC-005 PR-D T22: client-side anchor computation.
//
// Locks in findAllOccurrences + computeSectionPath + computeParagraphIdx +
// anchorKey + the full computeAnchorFromSelection path. Backend canonicalize-
// Anchor remains the source of truth on occurrence_index — these tests just
// guarantee the client produces a well-formed anchor so the backend isn't
// rejecting on shape.

import { describe, expect, test, beforeEach } from 'vitest'
import {
  anchorKey,
  computeAnchorFromSelection,
  computeParagraphIdx,
  computeSectionPath,
  findAllOccurrences,
} from '@/lib/review/anchor'

describe('findAllOccurrences', () => {
  test('returns 0-based offsets in document order', () => {
    expect(findAllOccurrences('foo bar foo baz foo', 'foo')).toEqual([0, 8, 16])
  })

  test('non-overlapping (advances by needle length after each match)', () => {
    expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2])
  })

  test('needle absent → empty', () => {
    expect(findAllOccurrences('abc', 'zzz')).toEqual([])
  })

  test('empty needle → empty', () => {
    expect(findAllOccurrences('abc', '')).toEqual([])
  })
})

describe('computeSectionPath', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    root.innerHTML = `
      <h1>Design</h1>
      <p>p1</p>
      <h2>Interfaces</h2>
      <p>p2</p>
      <h3>POST endpoints</h3>
      <p id="target">payload</p>
      <h2>Sequence</h2>
      <p>p3</p>
    `
    document.body.appendChild(root)
  })

  test('walks back through h1/h2/h3 to compose breadcrumb', () => {
    const target = root.querySelector('#target')!
    const path = computeSectionPath(root, target.firstChild!)
    expect(path).toBe('# Design > ## Interfaces > ### POST endpoints')
  })

  test('no preceding heading → empty string', () => {
    const tinyRoot = document.createElement('div')
    tinyRoot.innerHTML = '<p>just a paragraph</p>'
    document.body.appendChild(tinyRoot)
    const p = tinyRoot.querySelector('p')!
    expect(computeSectionPath(tinyRoot, p.firstChild!)).toBe('')
  })

  test('siblings closer than ancestors win when both exist', () => {
    const r = document.createElement('div')
    r.innerHTML = `
      <h1>Outer</h1>
      <section>
        <h2>Inner</h2>
        <p id="t">x</p>
      </section>
    `
    document.body.appendChild(r)
    const target = r.querySelector('#t')!
    expect(computeSectionPath(r, target.firstChild!)).toBe('# Outer > ## Inner')
  })
})

describe('computeParagraphIdx', () => {
  test('counts P / LI / PRE / TR before target inside the deepest section', () => {
    const r = document.createElement('div')
    r.innerHTML = `
      <h2>Section</h2>
      <p>first</p>
      <p>second</p>
      <pre>code</pre>
      <p id="t">target</p>
    `
    document.body.appendChild(r)
    const target = r.querySelector('#t')!
    expect(computeParagraphIdx(r, target.firstChild!)).toBe(3)
  })

  test('zero when target is the first block of its section', () => {
    const r = document.createElement('div')
    r.innerHTML = `<h2>Section</h2><p id="t">first</p>`
    document.body.appendChild(r)
    const target = r.querySelector('#t')!
    expect(computeParagraphIdx(r, target.firstChild!)).toBe(0)
  })
})

describe('anchorKey', () => {
  test('produces a stable key for the same anchor', () => {
    const a = {
      sectionPath: '## Foo',
      paragraphIdx: 1,
      offsetStart: 10,
      offsetEnd: 14,
      selectedText: 'hello',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
    }
    expect(anchorKey(a)).toBe(anchorKey(a))
  })

  test('different selectedText → different key', () => {
    const a = {
      sectionPath: '## Foo',
      paragraphIdx: 0,
      offsetStart: 0,
      offsetEnd: 1,
      selectedText: 'a',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
    }
    const b = { ...a, selectedText: 'b' }
    expect(anchorKey(a)).not.toBe(anchorKey(b))
  })
})

describe('computeAnchorFromSelection', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    root.innerHTML = `
      <h2>Design</h2>
      <p id="p1">The order_status enum should include partially_refunded.</p>
    `
    document.body.appendChild(root)
  })

  test('returns null for collapsed selection', () => {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    const p = root.querySelector('#p1')!.firstChild!
    r.setStart(p, 4)
    r.setEnd(p, 4)
    sel.addRange(r)
    expect(computeAnchorFromSelection(root, sel, 'whatever')).toBeNull()
  })

  test('returns null when selectedText absent from sourceBody', () => {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    const text = root.querySelector('#p1')!.firstChild!
    r.setStart(text, 4)
    r.setEnd(text, 16)
    sel.addRange(r)
    // sourceBody doesn't contain the selected substring
    expect(computeAnchorFromSelection(root, sel, 'unrelated body')).toBeNull()
  })

  test('builds a well-formed anchor for a valid selection', () => {
    const sel = window.getSelection()!
    sel.removeAllRanges()
    const r = document.createRange()
    const text = root.querySelector('#p1')!.firstChild!
    // Select "order_status"
    const para = text.textContent!
    const start = para.indexOf('order_status')
    r.setStart(text, start)
    r.setEnd(text, start + 'order_status'.length)
    sel.addRange(r)

    const sourceBody = '## Design\n\nThe order_status enum should include partially_refunded.\n'
    const a = computeAnchorFromSelection(root, sel, sourceBody)
    expect(a).not.toBeNull()
    expect(a?.selectedText).toBe('order_status')
    expect(a?.sectionPath).toBe('## Design')
    expect(a?.occurrenceIndex).toBe(1)
    expect(a?.offsetStart).toBe(sourceBody.indexOf('order_status'))
    expect(a?.offsetEnd).toBe(sourceBody.indexOf('order_status') + 'order_status'.length)
    expect(a?.contextBefore).toContain('The ')
  })
})
