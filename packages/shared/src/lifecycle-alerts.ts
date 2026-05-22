// RFC-057 — canonical lifecycle alert rule list shared across backend +
// frontend + repair-option taxonomy. Mirrors `InvariantRule | StuckRule`
// in `packages/backend/src/services/lifecycleInvariants.ts`, but lives in
// shared so the diagnose-repair option map (rule → option[]) can satisfy
// the same union at compile time.

export const LIFECYCLE_ALERT_RULES = [
  // invariants (lifecycleInvariants.ts)
  'R1',
  'R2',
  'C1',
  'T1',
  'T2',
  'T3',
  'U1',
  'CR-1',
  // stuck-task detector (stuckTaskDetector.ts)
  'S1',
  'S2',
  'S3',
  'S4',
] as const

export type LifecycleAlertRule = (typeof LIFECYCLE_ALERT_RULES)[number]

export type LifecycleAlertSeverity = 'warning' | 'error'

export function isLifecycleAlertRule(s: string): s is LifecycleAlertRule {
  return (LIFECYCLE_ALERT_RULES as readonly string[]).includes(s)
}
