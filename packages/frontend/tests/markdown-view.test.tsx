// MarkdownView — RFC-005 PR-C T17.
//
// Locks in the rendering shell: GFM passes through, fenced code blocks for
// known diagram kinds (mermaid / plantuml) become placeholder elements that
// the runtime hydrates, image hrefs resolve through the worktree-files
// proxy, and DOMPurify strips dangerous markup.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { MarkdownView, resolveImageHref } from '@/components/review/MarkdownView'

describe('resolveImageHref', () => {
  test('absolute http URLs pass through unchanged', () => {
    expect(resolveImageHref('https://example.com/x.png', 't_1')).toBe('https://example.com/x.png')
  })

  test('data: URIs pass through unchanged', () => {
    const data = 'data:image/png;base64,AAAA'
    expect(resolveImageHref(data, 't_1')).toBe(data)
  })

  test('blob: URLs pass through unchanged', () => {
    expect(resolveImageHref('blob:http://localhost/abc', 't_1')).toBe('blob:http://localhost/abc')
  })

  test('relative path rewrites to worktree-files proxy', () => {
    expect(resolveImageHref('./design/img/x.png', 't_1')).toBe(
      '/api/worktree-files/t_1/design/img/x.png',
    )
  })

  test('absolute-looking leading slash treated as worktree-relative', () => {
    expect(resolveImageHref('/foo/bar.png', 't_1')).toBe('/api/worktree-files/t_1/foo/bar.png')
  })

  test('no taskId → original href returned (broken image visible in preview)', () => {
    expect(resolveImageHref('./x.png', undefined)).toBe('./x.png')
  })

  test('empty href → empty', () => {
    expect(resolveImageHref('', 't_1')).toBe('')
  })
})

describe('MarkdownView GFM rendering', () => {
  test('renders heading + paragraph', () => {
    const { container } = render(<MarkdownView body={'# Hi\n\nbody text'} />)
    expect(container.querySelector('h1')?.textContent).toBe('Hi')
    expect(container.querySelector('p')?.textContent).toBe('body text')
  })

  test('renders GFM table', () => {
    const md = `| a | b |\n| --- | --- |\n| 1 | 2 |\n`
    const { container } = render(<MarkdownView body={md} />)
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelector('th')?.textContent).toBe('a')
  })

  test('renders code block (non-diagram) inside <pre><code>', () => {
    const md = '```js\nconst x = 1\n```'
    const { container } = render(<MarkdownView body={md} />)
    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    expect(code?.className).toContain('language-js')
    expect(code?.textContent).toContain('const x = 1')
  })

  test('mermaid code block emits diagram placeholder (kind=mermaid)', () => {
    const md = '```mermaid\nsequenceDiagram\nA->>B: hi\n```'
    const { container } = render(<MarkdownView body={md} />)
    const ph = container.querySelector('[data-review-diagram]')
    expect(ph).not.toBeNull()
    expect(ph?.getAttribute('data-review-diagram-kind')).toBe('mermaid')
    // source is base64-encoded into data-review-diagram-src
    const src = ph?.getAttribute('data-review-diagram-src') ?? ''
    expect(src.length).toBeGreaterThan(0)
  })

  test('plantuml code block emits diagram placeholder (kind=plantuml)', () => {
    const md = '```plantuml\n@startuml\nA -> B\n@enduml\n```'
    const { container } = render(<MarkdownView body={md} />)
    const ph = container.querySelector('[data-review-diagram]')
    expect(ph).not.toBeNull()
    expect(ph?.getAttribute('data-review-diagram-kind')).toBe('plantuml')
  })

  test('relative image href rewrites to worktree proxy when taskId present', () => {
    const md = '![diagram](./img/x.png)'
    const { container } = render(<MarkdownView body={md} taskId="t_1" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/api/worktree-files/t_1/img/x.png')
  })

  test('absolute image src passes through', () => {
    const md = '![](https://example.com/x.png)'
    const { container } = render(<MarkdownView body={md} taskId="t_1" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/x.png')
  })

  test('XSS attempts are stripped by DOMPurify', () => {
    // onerror attribute on img → stripped.
    const md1 = 'Look: <img src="ok.png" onerror="alert(1)" alt="x">'
    const { container: c1 } = render(<MarkdownView body={md1} />)
    expect(c1.innerHTML).not.toContain('onerror')
    expect(c1.innerHTML).not.toContain('alert(1)')

    // <script> tag inside paragraph → script element stripped from DOM.
    const md2 = 'Hi <script>alert(2)</script> there'
    const { container: c2 } = render(<MarkdownView body={md2} />)
    expect(c2.querySelector('script')).toBeNull()

    // javascript: href → stripped.
    const md3 = '[click](javascript:alert(3))'
    const { container: c3 } = render(<MarkdownView body={md3} />)
    expect(c3.innerHTML.toLowerCase()).not.toMatch(/href=["']?javascript:/)
  })
})
