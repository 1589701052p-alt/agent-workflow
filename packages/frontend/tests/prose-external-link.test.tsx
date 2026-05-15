// RFC-008 T1 — rehype-external-links contract.
//
// External (http/https) links should open in a new tab with rel attributes
// preventing window.opener exfiltration; the `prose__external-icon` span
// must be appended so the CSS svg-mask icon renders. Internal anchors
// (e.g. `#foo`) must NOT be tagged external.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — external links', () => {
  test('https link gets target=_blank and rel="noopener noreferrer"', () => {
    const { container } = render(<Prose body={`[ex](https://example.com)`} />)
    const a = container.querySelector('a[href="https://example.com"]')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('target')).toBe('_blank')
    const rel = a?.getAttribute('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')
  })

  test('external icon span is appended inside the link', () => {
    const { container } = render(<Prose body={`[ex](https://example.com)`} />)
    const icon = container.querySelector('a[href*="example.com"] .prose__external-icon')
    expect(icon).not.toBeNull()
  })

  test('internal #anchor link is NOT tagged external', () => {
    const { container } = render(<Prose body={`[here](#section)`} />)
    const a = container.querySelector('a[href="#section"]')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('target')).not.toBe('_blank')
    expect(a?.querySelector('.prose__external-icon')).toBeNull()
  })
})
