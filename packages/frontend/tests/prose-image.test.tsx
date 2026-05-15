// RFC-008 T1 — image override end-to-end.
//
// The pure `resolveImageHref` function is covered by `prose-image-href.test.ts`.
// This file verifies the React-level wiring: that the override actually
// reaches into <img>, threads the taskId rewrite, and tags the element
// with the `data-prose-image` attribute the medium-zoom hook will key off
// in T2.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — image override', () => {
  test('relative href with taskId rewrites to /api/worktree-files/{task}/...', () => {
    const { container } = render(<Prose body={`![diagram](./img/x.png)`} taskId="t_1" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/api/worktree-files/t_1/img/x.png')
  })

  test('absolute href passes through untouched', () => {
    const { container } = render(<Prose body={`![](https://example.com/x.png)`} taskId="t_1" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/x.png')
  })

  test('image gets data-prose-image marker + loading=lazy', () => {
    const { container } = render(<Prose body={`![alt](https://example.com/x.png)`} />)
    const img = container.querySelector('img')
    expect(img?.getAttribute('data-prose-image')).not.toBeNull()
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('alt')).toBe('alt')
  })
})
