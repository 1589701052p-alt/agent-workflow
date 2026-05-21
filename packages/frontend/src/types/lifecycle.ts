// RFC-053 P-6 — shared types for lifecycle alerts on the frontend.
// Kept narrow on purpose: the panel + banner only need rule / severity /
// detail / detectedAt; bigger schemas live in `@agent-workflow/shared`.

export type LifecycleAlertRule =
  | 'R1'
  | 'R2'
  | 'C1'
  | 'T1'
  | 'T2'
  | 'T3'
  | 'U1'
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'

export type LifecycleAlertSeverity = 'warning' | 'error'
