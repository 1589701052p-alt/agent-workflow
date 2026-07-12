// flag-audit W0 (§4.6) — single source of truth for review decision → chip kind.
// Replaces three drifted mappings that used TWO color-name systems:
//   - routes/reviews.tsx `decisionChipColor` (legacy green/red/blue/gray)
//   - routes/reviews.tsx list-row nested ternary (legacy names + awaiting→amber)
//   - components/review/ReviewDecisionInfo.tsx `chipKind` (semantic names)
// Only ReviewDecisionInfo handled 'superseded'; the other two silently fell
// back to gray. One table, semantic StatusChip kinds only.

import type { DocVersionDecision } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

// RFC-149: the view union IS the shared wire enum (`DOC_VERSION_DECISION`) —
// re-exported under the existing name so call sites keep compiling and a new
// decision value shows up here as a compile error instead of a silent-neutral.
export type ReviewDecisionView = DocVersionDecision

export const DECISION_CHIP_KIND: Record<ReviewDecisionView, StatusChipKind> = {
  pending: 'neutral',
  approved: 'success',
  rejected: 'danger',
  iterated: 'info',
  superseded: 'neutral',
}

/** Tolerant accessor — unknown / null decisions render neutral instead of throwing. */
export function decisionChipKind(decision: string | null | undefined): StatusChipKind {
  if (decision === undefined || decision === null) return 'neutral'
  return DECISION_CHIP_KIND[decision as ReviewDecisionView] ?? 'neutral'
}
