// RFC-008 T2 — GitHub-style blockquote alerts.
//
// Locks remark-github-blockquote-alert wiring: each of the five recognized
// alert kinds (note/tip/important/warning/caution) renders into a
// `.markdown-alert.markdown-alert-{kind}` container, and the alert title
// row carries the recognizable text label.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — GitHub-style alerts', () => {
  const cases: Array<{ kind: 'note' | 'tip' | 'important' | 'warning' | 'caution' }> = [
    { kind: 'note' },
    { kind: 'tip' },
    { kind: 'important' },
    { kind: 'warning' },
    { kind: 'caution' },
  ]

  for (const c of cases) {
    test(`> [!${c.kind.toUpperCase()}] → .markdown-alert-${c.kind}`, () => {
      const md = `> [!${c.kind.toUpperCase()}]\n> body line`
      const { container } = render(<Prose body={md} />)
      const wrap = container.querySelector(`.markdown-alert.markdown-alert-${c.kind}`)
      expect(wrap).not.toBeNull()
      expect(wrap?.textContent?.toLowerCase()).toContain('body line')
    })
  }

  test('alert title row is tagged with .markdown-alert-title', () => {
    const { container } = render(<Prose body={`> [!NOTE]\n> hi`} />)
    expect(container.querySelector('.markdown-alert-title')).not.toBeNull()
  })

  test('a plain blockquote (no [!KIND]) is NOT promoted to an alert', () => {
    const { container } = render(<Prose body={`> regular quote`} />)
    expect(container.querySelector('.markdown-alert')).toBeNull()
    expect(container.querySelector('blockquote')).not.toBeNull()
  })
})
