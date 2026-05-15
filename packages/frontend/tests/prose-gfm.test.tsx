// RFC-008 T1 — GFM coverage for <Prose>.
//
// Locks the GFM feature surface: tables (with thead/tbody), task lists with
// rendered checkboxes, strikethrough, autolinks, and footnotes. If anyone
// later rips remark-gfm out of the pipeline these all flip red.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — GFM', () => {
  test('renders a table with thead/tbody/td', () => {
    const md = `| a | b |\n| --- | --- |\n| 1 | 2 |\n`
    const { container } = render(<Prose body={md} />)
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(container.querySelector('thead th')?.textContent).toBe('a')
    expect(container.querySelector('tbody td')?.textContent).toBe('1')
  })

  test('task list emits checkboxes', () => {
    const md = `- [x] done\n- [ ] todo\n`
    const { container } = render(<Prose body={md} />)
    const boxes = container.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(true)
    expect((boxes[1] as HTMLInputElement).checked).toBe(false)
  })

  test('strikethrough wraps in <del>', () => {
    const { container } = render(<Prose body={`~~gone~~`} />)
    expect(container.querySelector('del')?.textContent).toBe('gone')
  })

  test('GFM autolink turns bare URL into <a>', () => {
    const { container } = render(<Prose body={`visit https://example.com today`} />)
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com')
  })

  test('footnote reference + definition', () => {
    const md = `Statement[^1].\n\n[^1]: clarification`
    const { container } = render(<Prose body={md} />)
    const fnRef = container.querySelector('a[id^="user-content-fnref"]')
    const fnDef = container.querySelector('li[id^="user-content-fn-"]')
    expect(fnRef).not.toBeNull()
    expect(fnDef).not.toBeNull()
  })
})
