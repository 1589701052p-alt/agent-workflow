// useResolvedTheme — single source of truth for "what color scheme is
// rendered right now", used by features whose output bakes in a palette
// (mermaid SVG is the motivating case; CSS-variable-driven UI never needs
// this hook). Locks three contracts:
//
//   1. Explicit <html data-theme="dark"> / "light" wins over system.
//   2. With the attribute absent, the hook falls back to
//      prefers-color-scheme via matchMedia.
//   3. Mutating the attribute at runtime re-renders consumers (MermaidDiagram
//      depends on this to recolor SVGs when the user flips theme).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useResolvedTheme } from '@/hooks/useTheme'

function Probe() {
  const theme = useResolvedTheme()
  return <span data-testid="theme">{theme}</span>
}

let systemMatches = false
let mqlListeners: Array<() => void> = []

function installMatchMedia(matches: boolean) {
  systemMatches = matches
  mqlListeners = []
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((q: string) => {
      const mql: MediaQueryList = {
        matches: q.includes('dark') ? systemMatches : !systemMatches,
        media: q,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_: string, cb: EventListenerOrEventListenerObject) => {
          mqlListeners.push(cb as () => void)
        },
        removeEventListener: (_: string, cb: EventListenerOrEventListenerObject) => {
          mqlListeners = mqlListeners.filter((fn) => fn !== cb)
        },
        dispatchEvent: () => true,
      }
      return mql
    }),
  })
}

describe('useResolvedTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    installMatchMedia(false)
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  test('returns the value of <html data-theme> when set explicitly', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('theme').textContent).toBe('dark')
  })

  test('falls back to prefers-color-scheme when <html data-theme> is absent', () => {
    installMatchMedia(true) // system dark
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('theme').textContent).toBe('dark')
  })

  test('mutating <html data-theme> at runtime re-renders consumers', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('theme').textContent).toBe('light')

    act(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await waitFor(() => expect(getByTestId('theme').textContent).toBe('dark'))
  })

  test('removing <html data-theme> falls back to system again', async () => {
    installMatchMedia(true) // system dark
    document.documentElement.setAttribute('data-theme', 'light')
    const { getByTestId } = render(<Probe />)
    expect(getByTestId('theme').textContent).toBe('light')

    act(() => {
      document.documentElement.removeAttribute('data-theme')
    })
    await waitFor(() => expect(getByTestId('theme').textContent).toBe('dark'))
  })
})
