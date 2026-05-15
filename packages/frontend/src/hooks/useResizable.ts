// RFC-009-T2: width persistence + pointer-driven resize for the review
// sidebar. A small hook so the math + listener wiring + localStorage round-trip
// lives in one place — the route just renders <div onPointerDown={...} />.
//
// Width is clamped to [min, max] on every update; the persisted value is
// re-clamped on load so changing the bounds in code doesn't surface an
// out-of-range width from an older session.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseResizableOptions {
  /** localStorage key used to persist the width across reloads. */
  storageKey: string
  /** Initial width if localStorage is empty or value is invalid. */
  initial: number
  min: number
  max: number
}

export interface UseResizableResult {
  width: number
  setWidth: (n: number) => void
  /**
   * Attach to the resizer handle. Captures pointer + listens on window for
   * move/up; restores cursor on release.
   */
  onResizerPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  /** True while the user is actively dragging the handle. */
  dragging: boolean
}

function readPersisted(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
  } catch {
    return fallback
  }
}

export function useResizable(opts: UseResizableOptions): UseResizableResult {
  const { storageKey, initial, min, max } = opts
  const [width, setWidthRaw] = useState<number>(() => readPersisted(storageKey, initial, min, max))
  const [dragging, setDragging] = useState(false)
  // Direction of growth: the resizer sits on the LEFT edge of the right
  // sidebar, so dragging *left* (negative deltaX) makes the sidebar *wider*.
  const startRef = useRef<{ x: number; width: number } | null>(null)

  const setWidth = useCallback(
    (n: number) => {
      const clamped = Math.max(min, Math.min(max, n))
      setWidthRaw(clamped)
    },
    [min, max],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(storageKey, String(width))
    } catch {
      // localStorage can throw (private mode, quota); silently swallow.
    }
  }, [storageKey, width])

  const onResizerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault()
      startRef.current = { x: e.clientX, width }
      setDragging(true)
      const prevCursor = document.body.style.cursor
      const prevSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: PointerEvent): void => {
        if (startRef.current === null) return
        const delta = ev.clientX - startRef.current.x
        // Left-edge handle: subtract delta so dragging left grows the panel.
        setWidth(startRef.current.width - delta)
      }
      const onUp = (): void => {
        startRef.current = null
        setDragging(false)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevSelect
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [width, setWidth],
  )

  return { width, setWidth, onResizerPointerDown, dragging }
}
