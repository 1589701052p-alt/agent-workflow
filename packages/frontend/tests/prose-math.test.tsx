// RFC-008 T2 — KaTeX inline and block math.
//
// Locks remark-math + rehype-katex pipeline:
//   - `$inline$` renders into a `.katex` span
//   - `$$block$$` renders into a `.katex-display` wrapper
//   - syntax errors fall through (strict: false) without throwing

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — math', () => {
  test('inline $x^2$ renders KaTeX HTML', () => {
    const { container } = render(<Prose body={`The formula is $x^2 + y^2 = z^2$ done.`} />)
    const katex = container.querySelector('.katex')
    expect(katex).not.toBeNull()
    // KaTeX exposes the MathML branch with the original source.
    expect(container.textContent).toContain('done')
  })

  test('block $$x$$ renders inside .katex-display', () => {
    // remark-math 6 only treats a `$$...$$` form as display math when it's
    // delimited by blank lines (its own block-level node).
    const md = `Heading\n\n$$\n\\sum_{i=1}^{n} x_i\n$$\n\nafter`
    const { container } = render(<Prose body={md} />)
    expect(container.querySelector('.katex-display')).not.toBeNull()
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  test('syntax error does not throw (strict: false)', () => {
    expect(() => render(<Prose body={`Bad math: $\\frac{1}{$`} />)).not.toThrow()
  })
})
