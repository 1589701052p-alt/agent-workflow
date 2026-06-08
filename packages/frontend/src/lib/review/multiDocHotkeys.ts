// RFC-090 — pure keyboard-shortcut oracles for the multi-document review page.
//
// Extracted so the key→action mapping and the clamped list navigation are unit
// testable without mounting MultiDocReviewView (which pulls in TanStack Query,
// useTaskSync, the Prose pipeline, IntersectionObserver, etc.). The component
// wires these into a single `window` keydown listener; see MultiDocReviewView.tsx.

/** The four keyboard actions the multi-doc review page supports. */
export type MultiDocHotkeyAction = 'prev' | 'next' | 'accept' | 'not_accept'

/**
 * Map a keydown to a multi-doc action, or `null` if the key isn't a shortcut.
 *
 * Bails on ctrl / meta / alt so we never shadow browser / OS chords (Cmd+W
 * close-tab, Alt+Arrow history nav, …); shift is also excluded so Shift+Arrow
 * text selection inside the document body is untouched.
 *
 * ArrowUp→prev, ArrowDown→next, q/Q→accept, w/W→not_accept.
 */
export function multiDocHotkeyAction(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): MultiDocHotkeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
  switch (e.key) {
    case 'ArrowUp':
      return 'prev'
    case 'ArrowDown':
      return 'next'
    case 'q':
    case 'Q':
      return 'accept'
    case 'w':
    case 'W':
      return 'not_accept'
    default:
      return null
  }
}

/**
 * Clamped neighbour index for ↑/↓ navigation. No wraparound (matches the
 * ReviewDocPane J/K comment-jump clamp). Returns `currentIdx` unchanged when the
 * list is empty; an unknown current (`-1`, e.g. active doc not in the list)
 * resolves to the first item in either direction.
 */
export function nextDocIndex(currentIdx: number, len: number, dir: 'prev' | 'next'): number {
  if (len <= 0) return currentIdx
  return dir === 'next' ? Math.min(currentIdx + 1, len - 1) : Math.max(currentIdx - 1, 0)
}
