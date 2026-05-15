// RFC-008 T1 — heading slug + auto-anchor wiring.
//
// Locks rehype-slug → rehype-autolink-headings ordering and the `prose__anchor`
// element shape, so the CSS hover rule in prose.css stays load-bearing.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — headings + anchors', () => {
  test('h2 gets slug id derived from text', () => {
    const { container } = render(<Prose body={`## Hello World`} />)
    const h2 = container.querySelector('h2')
    expect(h2).not.toBeNull()
    expect(h2?.id).toBe('hello-world')
  })

  test('autolink appends a `.prose__anchor` link inside the heading', () => {
    const { container } = render(<Prose body={`## Hello`} />)
    const anchor = container.querySelector('h2 a.prose__anchor')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe('#hello')
  })

  test('anchor link is aria-hidden', () => {
    const { container } = render(<Prose body={`## A`} />)
    const anchor = container.querySelector('a.prose__anchor')
    expect(anchor?.getAttribute('aria-hidden')).toBe('true')
  })

  test('all heading levels keep their tag name', () => {
    const md = `# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n`
    const { container } = render(<Prose body={md} />)
    expect(container.querySelector('h1')?.textContent?.startsWith('h1')).toBe(true)
    expect(container.querySelector('h6')?.textContent?.startsWith('h6')).toBe(true)
  })
})
