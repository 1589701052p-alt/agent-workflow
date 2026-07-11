// RFC-167 T4 — dynamic workflow space form helpers (pure; unit-testable).
// Mirrors lib/workgroup-form.ts's quick-create shape: the list-page dialog
// POSTs {name, description} only (the pool + everything else is managed on the
// detail page and defaulted server-side).

import {
  CreateDynamicWorkflowSpaceSchema,
  DYNAMIC_WORKFLOW_SPACE_NAME_RE,
} from '@agent-workflow/shared'

export interface QuickCreateSpaceBody {
  name: string
  description: string
}

export type BuiltSpace =
  | { ok: true; payload: QuickCreateSpaceBody }
  | { ok: false; errors: Record<string, string> }

/** Validate the quick-create dialog; i18n keys mirror the workgroup dialog. */
export function buildQuickCreateSpacePayload(input: QuickCreateSpaceBody): BuiltSpace {
  const errors: Record<string, string> = {}
  if (input.name.length === 0) errors.name = 'dynamicWorkflowSpaces.errors.nameRequired'
  else if (input.name.length > 128 || !DYNAMIC_WORKFLOW_SPACE_NAME_RE.test(input.name)) {
    errors.name = 'dynamicWorkflowSpaces.errors.nameInvalid'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  // Wire-shape net: the same schema the server parses (defaults fill in).
  const parsed = CreateDynamicWorkflowSpaceSchema.safeParse(input)
  if (!parsed.success) {
    const out: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && out[key] === undefined) {
        out[key] = 'dynamicWorkflowSpaces.errors.nameInvalid'
      }
    }
    return { ok: false, errors: out }
  }
  return { ok: true, payload: { name: input.name, description: input.description } }
}

/** Add an agent to the pool (de-duped, order preserved). Returns a new array. */
export function addPoolAgent(pool: readonly string[], name: string): string[] {
  const trimmed = name.trim()
  if (trimmed.length === 0 || pool.includes(trimmed)) return [...pool]
  return [...pool, trimmed]
}

/** Remove the pool entry at `index`. Returns a new array. */
export function removePoolAgentAt(pool: readonly string[], index: number): string[] {
  return pool.filter((_, i) => i !== index)
}
