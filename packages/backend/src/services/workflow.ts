// Workflow service — CRUD on the workflows table.
//
// Definition is stored as a JSON string in the DB and parsed at this boundary.
// M1 keeps the schema permissive (passthrough on unknown node-kind fields);
// strict validation lands in P-2-01.

import type {
  CreateWorkflow,
  UpdateWorkflow,
  Workflow,
  WorkflowDefinition,
  WorkflowValidationResult,
} from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type WorkflowRow = typeof workflows.$inferSelect

export async function listWorkflows(db: DbClient): Promise<Workflow[]> {
  const rows = await db.select().from(workflows)
  return rows.map(rowToWorkflow)
}

export async function getWorkflow(db: DbClient, id: string): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToWorkflow(row) : null
}

export async function createWorkflow(db: DbClient, input: CreateWorkflow): Promise<Workflow> {
  const id = ulid()
  const now = Date.now()
  await db.insert(workflows).values({
    id,
    name: input.name,
    description: input.description,
    definition: JSON.stringify(input.definition),
    version: 1,
    createdAt: now,
    updatedAt: now,
  })
  const created = await getWorkflow(db, id)
  if (created === null) throw new Error('workflow disappeared right after insert')
  return created
}

export async function updateWorkflow(
  db: DbClient,
  id: string,
  patch: UpdateWorkflow,
): Promise<Workflow> {
  const existing = await getWorkflow(db, id)
  if (existing === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }

  const set: Partial<typeof workflows.$inferInsert> = {
    version: existing.version + 1,
    updatedAt: Date.now(),
  }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.description !== undefined) set.description = patch.description
  if (patch.definition !== undefined) set.definition = JSON.stringify(patch.definition)

  await db.update(workflows).set(set).where(eq(workflows.id, id))
  const updated = await getWorkflow(db, id)
  if (updated === null) throw new Error('workflow disappeared after update')
  return updated
}

export async function deleteWorkflow(db: DbClient, id: string): Promise<void> {
  const existing = await getWorkflow(db, id)
  if (existing === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  // Refuse on ANY task referencing this workflow — running, done, failed,
  // canceled, interrupted. Per the user's decision in design Q&A round 18:
  // "被引用拒绝（没引用才能删）". A future iteration may relax this by making
  // tasks.workflowId nullable + ON DELETE SET NULL.
  const refs = await findReferencingTasks(db, id)
  if (refs.length > 0) {
    throw new ConflictError(
      'workflow-in-use',
      `workflow '${id}' has ${refs.length} task(s) referencing it; delete those tasks first`,
      { tasks: refs },
    )
  }
  await db.delete(workflows).where(eq(workflows.id, id))
}

/**
 * M1 stub. P-2-01 fleshes this out to the full 5-item static check:
 *   1. edge port existence
 *   2. topology legality (cycles only inside loop wrappers)
 *   3. wrapper required fields (max_iterations / exit_condition; ≥1 inner)
 *   4. reference resolution (agent / skill names; sourcePort; bindings)
 *   5. node prompt template {{port_name}} references resolve
 */
export async function validateWorkflow(
  db: DbClient,
  id: string,
): Promise<WorkflowValidationResult> {
  const wf = await getWorkflow(db, id)
  if (wf === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
  }
  // M1 stub — always ok.
  return { ok: true, issues: [] }
}

// --- helpers ---

async function findReferencingTasks(
  db: DbClient,
  workflowId: string,
): Promise<Array<{ id: string; status: string }>> {
  const rows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.workflowId, workflowId))
  return rows
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(row.definition)
    const parsed = WorkflowDefinitionSchema.safeParse(raw)
    if (!parsed.success) {
      // Definition was stored but no longer parses — likely a schema drift.
      // Surface as a domain error so the API returns a structured 422.
      throw new ValidationError('workflow-definition-corrupt', 'stored definition is invalid', {
        workflowId: row.id,
        issues: parsed.error.issues,
      })
    }
    definition = parsed.data
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError('workflow-definition-corrupt', 'stored definition is not JSON', {
      workflowId: row.id,
      error: (err as Error).message,
    })
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition,
    version: row.version,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
