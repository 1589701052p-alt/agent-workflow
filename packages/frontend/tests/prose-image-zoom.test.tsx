// RFC-008 T2 — medium-zoom attached on image mount.
//
// We mock medium-zoom to assert it's called with the rendered <img>. The
// zoom attach is the visible UX win (click image → modal preview) and
// happens via a dynamic import inside ProseImage's useEffect; verifying
// the mock was called catches future refactors that drop the wiring.

import { describe, expect, test, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const zoomAttach = vi.fn<(el: HTMLElement, opts?: unknown) => { detach: () => void }>(() => ({
  detach: () => {},
}))
vi.mock('medium-zoom', () => ({
  default: (el: HTMLElement, opts?: unknown) => zoomAttach(el, opts),
}))

import { Prose } from '@/components/prose/Prose'

describe('Prose — medium-zoom on <img>', () => {
  test('mounting an image triggers mediumZoom(el, opts)', async () => {
    zoomAttach.mockClear()
    render(<Prose body={`![alt](https://example.com/x.png)`} />)
    await waitFor(() => {
      expect(zoomAttach).toHaveBeenCalledTimes(1)
    })
    const [el] = zoomAttach.mock.calls[0] ?? []
    expect((el as HTMLImageElement).tagName).toBe('IMG')
    expect((el as HTMLImageElement).getAttribute('src')).toBe('https://example.com/x.png')
  })
})
