// RFC-008 T3 — locks the MarkdownEditor → <Prose> unification.
//
// Two regression locks:
//
// 1. Behavioral — the preview pane renders GFM tables. The previous
//    in-house renderer had no table support; if anyone reverts to it
//    this assertion flips red.
//
// 2. Source-level — MarkdownEditor.tsx contains a `<Prose>` JSX call and
//    NOT the old minimal renderer's symbol names. This catches refactors
//    that accidentally bring the legacy renderer back via copy-paste.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MarkdownEditor } from '@/components/MarkdownEditor'

describe('MarkdownEditor preview uses <Prose>', () => {
  test('GFM table renders into the preview pane', () => {
    const md = `| a | b |\n| --- | --- |\n| 1 | 2 |\n`
    const { container } = render(<MarkdownEditor value={md} onChange={() => {}} />)
    expect(container.querySelector('.md-editor__preview table')).not.toBeNull()
    expect(container.querySelector('.md-editor__preview thead th')?.textContent).toBe('a')
  })

  test('blank input keeps the "Nothing to preview" placeholder', () => {
    const { container } = render(<MarkdownEditor value="" onChange={() => {}} />)
    expect(container.textContent).toContain('Nothing to preview yet')
    expect(container.querySelector('.md-editor__preview table')).toBeNull()
  })

  test('source-level: MarkdownEditor.tsx mounts <Prose> and does NOT carry the legacy renderer symbols', () => {
    const src = readFileSync(resolve(__dirname, '../src/components/MarkdownEditor.tsx'), 'utf-8')
    expect(src).toContain('<Prose')
    expect(src).not.toContain('renderMarkdown')
    expect(src).not.toContain('formatBoldItalic')
    expect(src).not.toContain('__testRenderMarkdown')
  })
})
