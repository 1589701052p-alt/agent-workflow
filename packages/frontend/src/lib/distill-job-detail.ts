// RFC-043 T5 — pure helpers for the distill-job detail page.
//
// Kept dependency-free (no React / router imports) so unit tests run
// in the vitest JSDOM env without harness setup. UI components compose
// these for labels, grouping, and stderr clipping.

import type {
  DistillJobStatus,
  MemoryDistillSessionAttempt,
  MemoryDistillSourceEventEntry,
} from '@agent-workflow/shared'

import i18n from '@/i18n'

export type SourceKind = MemoryDistillSourceEventEntry['kind']

export interface GroupedSourceEvents {
  clarify: MemoryDistillSourceEventEntry[]
  review: MemoryDistillSourceEventEntry[]
  feedback: MemoryDistillSourceEventEntry[]
}

/**
 * Bucket sourceEvents into three groups in stable order. Each bucket
 * preserves the input order so the UI can show "1st sibling, 2nd
 * sibling …" within a kind for debouncedmerged jobs.
 */
export function groupSourceEventsByKind(
  events: MemoryDistillSourceEventEntry[],
): GroupedSourceEvents {
  const out: GroupedSourceEvents = { clarify: [], review: [], feedback: [] }
  for (const e of events) {
    out[e.kind].push(e)
  }
  return out
}

/**
 * Sort distill session attempts by attemptIndex ascending. Returns a new
 * array; the input is not mutated. Defends against backend returning
 * out-of-order rows for any reason.
 */
export function selectAttempts(
  attempts: readonly MemoryDistillSessionAttempt[],
): MemoryDistillSessionAttempt[] {
  return [...attempts].sort((a, b) => a.attemptIndex - b.attemptIndex)
}

/**
 * Render the exitCode for the failure-diagnostics block. Pre-spawn
 * failures (null exitCode) render as a "—" so admin can distinguish
 * "process never produced an exit" from "process exited cleanly".
 */
export function formatExitCode(code: number | null | undefined): string {
  if (code === null || code === undefined) return i18n.t('common.emDash')
  return String(code)
}

/**
 * Soft-clip a stderr blob for inline rendering. Backend already redacts
 * + clips to 2 KB; this is a defensive UI cap so a future backend bug
 * dumping 50 KB of stderr can't lock up the browser. Returns null when
 * the input is null / empty so callers can collapse the block entirely.
 */
export function truncateStderr(input: string | null | undefined, maxChars = 4000): string | null {
  if (input === null || input === undefined) return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}${i18n.t('memory.distillJobDetail.stderrClipped', { n: maxChars })}`
}

/**
 * Should the FailureDiagnostics block be expanded by default? The
 * component is rendered conditionally — when this returns false, the
 * page skips the section entirely (no empty card).
 */
export function shouldShowFailureDiagnostics(job: {
  status: DistillJobStatus
  exitCode?: number | null
  lastError?: string | null
  attempts: number
}): boolean {
  if (job.status === 'failed') return true
  if (typeof job.exitCode === 'number' && job.exitCode !== 0) return true
  if (job.lastError !== null && job.lastError !== undefined && job.lastError !== '') return true
  if (job.attempts > 0) return true
  return false
}
