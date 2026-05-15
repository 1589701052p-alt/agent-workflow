// RFC-009-T5: derive a 1-based [start, end] line range from char offsets
// into the canonical doc body. Used by the review sidebar to render the
// "Line N" / "Line N–M" chip on each comment bubble without touching the
// anchor schema.
//
// Notes:
// - Both \n and \r\n are treated as one line break (the \r is part of the
//   preceding line, the \n bumps the counter).
// - offset clamping: if either offset is past the body length, we clamp to
//   the last line. This handles comments whose anchor was canonicalized
//   against an older body — we still want to show *something* sensible.
// - Empty body → returns { start: 1, end: 1 } (a single virtual line).
//
// O(N) over `body`; called once per comment per render via a memoized
// outer loop in reviews.detail.tsx.

export function computeLineRange(
  body: string,
  offsetStart: number,
  offsetEnd: number,
): { start: number; end: number } {
  if (body.length === 0) return { start: 1, end: 1 }
  const safeStart = Math.max(0, Math.min(offsetStart, body.length))
  const safeEnd = Math.max(safeStart, Math.min(offsetEnd, body.length))
  let line = 1
  let start = 1
  let end = 1
  for (let i = 0; i <= safeEnd && i < body.length; i++) {
    if (i === safeStart) start = line
    if (i === safeEnd) {
      end = line
      break
    }
    if (body.charCodeAt(i) === 10 /* \n */) line++
  }
  // Two edge cases: offsetEnd === body.length (loop exits before assigning
  // `end`) and offsetStart === body.length (same for `start`). Resolve by
  // computing line at the clamped offset directly.
  if (safeEnd >= body.length) {
    let l = 1
    for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) l++
    end = l
    if (safeStart >= body.length) start = l
  }
  return { start, end }
}
