// RFC-019: client-side pure helpers for the ZIP import flow. Kept separate
// from the React component so they're easy to unit-test.

import { SKILL_NAME_RE } from '@agent-workflow/shared'
import type { ParseSkillZipResponse, SkillZipCandidateView } from '@agent-workflow/shared'

export type DecisionAction = 'import' | 'skip' | 'overwrite' | 'rename'

export interface DecisionState {
  action: DecisionAction
  /** Only meaningful when action === 'rename'. */
  newName: string
}

export interface RowState {
  /** Original candidate name from parse response. */
  candidate: SkillZipCandidateView
  decision: DecisionState
}

/**
 * Compute the initial decision per candidate row when a parse response comes
 * in: no conflict → import; managed conflict → skip (safer than overwrite);
 * external conflict → skip (and overwrite/rename will be disabled in UI).
 */
export function initialDecisionFor(c: SkillZipCandidateView): DecisionState {
  if (c.conflict === undefined) return { action: 'import', newName: '' }
  return { action: 'skip', newName: '' }
}

export interface RenameValidation {
  ok: boolean
  reason?: 'invalid' | 'duplicate-in-batch' | 'conflict-with-db' | 'empty'
}

/**
 * Validate a proposed rename target against:
 *   - kebab-case regex
 *   - other rename targets in the same batch (no two renames to the same name)
 *   - existing skills (the DB conflict info known from /api/skills)
 */
export function validateRenameTarget(
  newName: string,
  selfCandidateName: string,
  allRows: RowState[],
  existingSkillNames: ReadonlySet<string>,
): RenameValidation {
  if (newName.length === 0) return { ok: false, reason: 'empty' }
  if (!SKILL_NAME_RE.test(newName)) return { ok: false, reason: 'invalid' }
  if (existingSkillNames.has(newName)) return { ok: false, reason: 'conflict-with-db' }
  for (const row of allRows) {
    if (row.candidate.name === selfCandidateName) continue
    const target = effectiveTargetName(row)
    if (target === newName) return { ok: false, reason: 'duplicate-in-batch' }
  }
  return { ok: true }
}

/**
 * The skill name a row will land on after commit. Skip → null (won't write).
 */
export function effectiveTargetName(row: RowState): string | null {
  if (row.decision.action === 'skip') return null
  if (row.decision.action === 'rename') return row.decision.newName
  return row.candidate.name
}

/**
 * Build the decisions map to POST to /api/skills/import-zip/commit. Rows
 * with invalid rename targets are filtered out (caller's `submitDisabled`
 * should prevent that case anyway).
 */
export function buildDecisionMap(rows: RowState[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const d = row.decision
    if (d.action === 'skip') {
      out[row.candidate.name] = { action: 'skip' }
    } else if (d.action === 'overwrite') {
      out[row.candidate.name] = { action: 'overwrite' }
    } else if (d.action === 'rename') {
      if (d.newName.length === 0) continue
      out[row.candidate.name] = { action: 'rename', newName: d.newName }
    } else {
      out[row.candidate.name] = { action: 'import' }
    }
  }
  return out
}

/** Summary line: "Will import N, overwrite M, skip K". Used in import button. */
export interface RowsSummary {
  importing: number
  overwriting: number
  renaming: number
  skipping: number
  total: number
}

export function summarizeRows(rows: RowState[]): RowsSummary {
  let importing = 0
  let overwriting = 0
  let renaming = 0
  let skipping = 0
  for (const row of rows) {
    switch (row.decision.action) {
      case 'import':
        importing++
        break
      case 'overwrite':
        overwriting++
        break
      case 'rename':
        renaming++
        break
      case 'skip':
        skipping++
        break
    }
  }
  return { importing, overwriting, renaming, skipping, total: rows.length }
}

export function rowsFromParseResponse(resp: ParseSkillZipResponse): RowState[] {
  return resp.skills.map((c) => ({
    candidate: c,
    decision: initialDecisionFor(c),
  }))
}
