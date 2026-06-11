// P-4-08: YAML import/export for workflows.
//
// Export: dump the canonical Workflow object (id + name + description +
// definition) as YAML using the `yaml` package's pretty printer.
//
// Import: parse YAML, validate the embedded definition with
// `WorkflowDefinitionSchema`, and decide how to handle conflicts:
//   - if the YAML provides an `id` that already exists, return a 409
//     `workflow-import-conflict` with details so the frontend can pop the
//     Skip/Overwrite/Import-as-new dialog
//   - if no id is provided, always insert as a new workflow

import type { Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { workflows } from '@/db/schema'
import { requireResourceOwner } from '@/services/resourceAcl'
import {
  assertNewRefsUsable,
  diffNewNames,
  extractWorkflowAgentNames,
} from '@/services/resourceRefs'
import { createWorkflow, getWorkflow, updateWorkflow } from '@/services/workflow'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

export async function exportWorkflowYaml(db: DbClient, id: string): Promise<string> {
  const wf = await getWorkflow(db, id)
  if (wf === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  const payload = {
    id: wf.id,
    name: wf.name,
    description: wf.description,
    definition: wf.definition,
  }
  return stringifyYaml(payload, { indent: 2, lineWidth: 120 })
}

export interface ImportYamlOptions {
  /**
   * Conflict policy when the YAML's id collides with an existing workflow:
   *   - 'fail' (default): throws ConflictError so the frontend can prompt
   *   - 'overwrite': updates the existing row (bumps version)
   *   - 'new': inserts as a brand-new workflow (id discarded)
   */
  onConflict?: 'fail' | 'overwrite' | 'new'
  /**
   * RFC-099 — the importing user. When present: create path stamps them as
   * owner + checks agent-reference usability; overwrite path additionally
   * requires them to own the existing workflow. Absent (internal/test
   * callers) skips ACL entirely (daemon-context back-compat).
   */
  actor?: Actor
}

export interface YamlImportPreview {
  /** Workflow id parsed from YAML, if any. */
  id: string | null
  name: string
  description: string
  definition: WorkflowDefinition
  /** True when a workflow with `id` already exists in DB. */
  conflicts: boolean
}

/**
 * Parse + validate a YAML payload without persisting it. The route layer can
 * use this to render a Preview dialog before deciding on the conflict policy.
 */
export function previewWorkflowYaml(yamlText: string): Omit<YamlImportPreview, 'conflicts'> {
  const raw = safeParse(yamlText)
  if (raw === null || typeof raw !== 'object') {
    throw new ValidationError('workflow-yaml-invalid', 'YAML did not parse to an object')
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : null
  if (name === null) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML missing required field: name')
  }
  const id = typeof obj.id === 'string' && obj.id.length > 0 ? obj.id : null
  const description = typeof obj.description === 'string' ? obj.description : ''
  const definitionRaw = obj.definition
  const parsed = WorkflowDefinitionSchema.safeParse(definitionRaw)
  if (!parsed.success) {
    throw new ValidationError('workflow-yaml-invalid', 'YAML definition failed schema validation', {
      issues: parsed.error.issues,
    })
  }
  return { id, name, description, definition: parsed.data }
}

export async function importWorkflowYaml(
  db: DbClient,
  yamlText: string,
  opts: ImportYamlOptions = {},
): Promise<Workflow> {
  const preview = previewWorkflowYaml(yamlText)
  const onConflict = opts.onConflict ?? 'fail'

  if (preview.id !== null && onConflict !== 'new') {
    const existing = (
      await db.select().from(workflows).where(eq(workflows.id, preview.id)).limit(1)
    )[0]
    if (existing !== undefined) {
      if (onConflict === 'fail') {
        throw new ConflictError(
          'workflow-import-conflict',
          `workflow '${preview.id}' already exists`,
          {
            workflowId: preview.id,
            existingName: existing.name,
            incomingName: preview.name,
          },
        )
      }
      // overwrite — RFC-099: only the owner (or admin) may overwrite, and
      // newly-added agent references must be usable by the importer.
      if (opts.actor !== undefined) {
        await requireResourceOwner(db, opts.actor, 'workflow', existing)
        const prevDef = JSON.parse(existing.definition) as {
          nodes?: Array<Record<string, unknown>>
        }
        const newNames = diffNewNames(
          extractWorkflowAgentNames(prevDef),
          extractWorkflowAgentNames(preview.definition),
        )
        await assertNewRefsUsable(db, opts.actor, [{ type: 'agent', names: newNames }])
      }
      return await updateWorkflow(db, preview.id, {
        name: preview.name,
        description: preview.description,
        definition: preview.definition,
      })
    }
  }

  // Either no id, or onConflict==='new', or id had no collision — create.
  // RFC-099: importer becomes owner; on create every reference is new.
  if (opts.actor !== undefined) {
    await assertNewRefsUsable(db, opts.actor, [
      { type: 'agent', names: [...extractWorkflowAgentNames(preview.definition)] },
    ])
  }
  return await createWorkflow(
    db,
    {
      name: preview.name,
      description: preview.description,
      definition: preview.definition,
    },
    opts.actor !== undefined ? { ownerUserId: opts.actor.user.id } : undefined,
  )
}

function safeParse(yamlText: string): unknown {
  try {
    return parseYaml(yamlText)
  } catch (err) {
    throw new ValidationError(
      'workflow-yaml-invalid',
      `YAML parse error: ${(err as Error).message}`,
    )
  }
}
