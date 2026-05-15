// Agent service — CRUD on the agents table.
// JSON fields (outputs / skills / permission / frontmatterExtra) are stored as
// strings in the DB and (un)marshaled at this boundary. Routes upstream see
// pure JS objects.

import type { Agent, CreateAgent, RenameAgent, UpdateAgent } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, workflows } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'

type AgentRow = typeof agents.$inferSelect

export async function listAgents(db: DbClient): Promise<Agent[]> {
  const rows = await db.select().from(agents)
  return rows.map(rowToAgent)
}

export async function getAgent(db: DbClient, name: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.name, name)).limit(1)
  const row = rows[0]
  return row ? rowToAgent(row) : null
}

export async function createAgent(db: DbClient, input: CreateAgent): Promise<Agent> {
  const existing = await getAgent(db, input.name)
  if (existing !== null) {
    throw new ConflictError('agent-name-in-use', `agent '${input.name}' already exists`)
  }

  const id = ulid()
  const now = Date.now()
  // RFC-005: outputKinds is a sidecar map ported through `frontmatter_extra`
  // (under reserved key `outputKinds`) until a dedicated column is needed.
  // services/review.ts:loadUpstreamPortKind reads from the same place.
  const fmExtra = { ...input.frontmatterExtra } as Record<string, unknown>
  if (input.outputKinds !== undefined) fmExtra.outputKinds = input.outputKinds
  await db.insert(agents).values({
    id,
    name: input.name,
    description: input.description,
    outputs: JSON.stringify(input.outputs),
    readonly: input.readonly,
    model: input.model ?? null,
    variant: input.variant ?? null,
    temperature: input.temperature ?? null,
    permission: JSON.stringify(input.permission),
    steps: input.steps ?? null,
    maxSteps: input.maxSteps ?? null,
    skills: JSON.stringify(input.skills),
    frontmatterExtra: JSON.stringify(fmExtra),
    bodyMd: input.bodyMd,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getAgent(db, input.name)
  if (created === null) throw new Error('agent disappeared right after insert')
  return created
}

export async function updateAgent(db: DbClient, name: string, patch: UpdateAgent): Promise<Agent> {
  const existing = await getAgent(db, name)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
  }

  const set: Partial<typeof agents.$inferInsert> = { updatedAt: Date.now() }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.outputs !== undefined) set.outputs = JSON.stringify(patch.outputs)
  if (patch.readonly !== undefined) set.readonly = patch.readonly
  if (patch.model !== undefined) set.model = patch.model
  if (patch.variant !== undefined) set.variant = patch.variant
  if (patch.temperature !== undefined) set.temperature = patch.temperature
  if (patch.permission !== undefined) set.permission = JSON.stringify(patch.permission)
  if (patch.steps !== undefined) set.steps = patch.steps
  if (patch.maxSteps !== undefined) set.maxSteps = patch.maxSteps
  if (patch.skills !== undefined) set.skills = JSON.stringify(patch.skills)
  // RFC-005: merge outputKinds into frontmatter_extra alongside the explicit
  // patch (if any). Tests that PATCH only outputKinds preserve the rest of
  // frontmatter_extra; tests that PATCH only frontmatterExtra drop outputKinds
  // only if the caller passes a fresh object without that key (existing
  // overwrite semantics).
  if (patch.frontmatterExtra !== undefined || patch.outputKinds !== undefined) {
    const baseFm =
      patch.frontmatterExtra !== undefined
        ? { ...patch.frontmatterExtra }
        : ((JSON.parse(existing.frontmatterExtra !== undefined ? '{}' : '{}') as Record<
            string,
            unknown
          >) ?? {})
    if (patch.frontmatterExtra === undefined) {
      // Caller patched only outputKinds — start from current row state.
      const fresh = await getAgent(db, name)
      if (fresh !== null) Object.assign(baseFm, fresh.frontmatterExtra)
    }
    if (patch.outputKinds !== undefined) {
      ;(baseFm as Record<string, unknown>).outputKinds = patch.outputKinds
    }
    set.frontmatterExtra = JSON.stringify(baseFm)
  }
  if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd

  await db.update(agents).set(set).where(eq(agents.name, name))
  const updated = await getAgent(db, name)
  if (updated === null) throw new Error('agent disappeared after update')
  return updated
}

export async function deleteAgent(db: DbClient, name: string): Promise<void> {
  const existing = await getAgent(db, name)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
  }
  const refs = await findWorkflowsUsingAgent(db, name)
  if (refs.length > 0) {
    throw new ConflictError('agent-in-use', `agent '${name}' is referenced by workflows`, {
      workflows: refs,
    })
  }
  await db.delete(agents).where(eq(agents.name, name))
}

export async function renameAgent(
  db: DbClient,
  oldName: string,
  input: RenameAgent,
): Promise<Agent> {
  const existing = await getAgent(db, oldName)
  if (existing === null) {
    throw new NotFoundError('agent-not-found', `agent '${oldName}' not found`)
  }
  if (input.newName === oldName) return existing

  const refs = await findWorkflowsUsingAgent(db, oldName)
  if (refs.length > 0) {
    throw new ConflictError(
      'agent-in-use',
      `agent '${oldName}' is referenced by workflows; cannot rename`,
      { workflows: refs },
    )
  }

  const collision = await getAgent(db, input.newName)
  if (collision !== null) {
    throw new ConflictError('agent-name-in-use', `agent '${input.newName}' already exists`)
  }

  await db
    .update(agents)
    .set({ name: input.newName, updatedAt: Date.now() })
    .where(eq(agents.name, oldName))

  const renamed = await getAgent(db, input.newName)
  if (renamed === null) throw new Error('agent disappeared after rename')
  return renamed
}

/**
 * Find every workflow whose definition.nodes[].agentName matches.
 * Stable identity for the "referenced by" check in delete/rename.
 */
async function findWorkflowsUsingAgent(
  db: DbClient,
  agentName: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: workflows.id, name: workflows.name, definition: workflows.definition })
    .from(workflows)

  const out: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    try {
      const def = JSON.parse(row.definition) as {
        nodes?: Array<{ agentName?: string }>
      }
      const used = def.nodes?.some((n) => n.agentName === agentName) ?? false
      if (used) out.push({ id: row.id, name: row.name })
    } catch {
      // Skip malformed JSON; workflow validator catches it on save in P-2-01.
    }
  }
  return out
}

function rowToAgent(row: AgentRow): Agent {
  const fmExtra = JSON.parse(row.frontmatterExtra) as Record<string, unknown>
  // RFC-005: lift outputKinds back out of frontmatter_extra into a top-level
  // property on the Agent DTO so consumers (review validator, scheduler,
  // frontend AgentForm) see it without poking into nested JSON.
  let outputKinds: Agent['outputKinds'] | undefined
  if (
    fmExtra.outputKinds !== undefined &&
    fmExtra.outputKinds !== null &&
    typeof fmExtra.outputKinds === 'object'
  ) {
    outputKinds = {} as Agent['outputKinds']
    for (const [port, kind] of Object.entries(fmExtra.outputKinds as Record<string, unknown>)) {
      if (kind === 'string' || kind === 'markdown' || kind === 'markdown_file') {
        ;(outputKinds as Record<string, typeof kind>)[port] = kind
      }
    }
  }
  const exposedFm = { ...fmExtra }
  delete (exposedFm as Record<string, unknown>).outputKinds

  const agent: Agent = {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: JSON.parse(row.outputs) as string[],
    readonly: row.readonly,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: JSON.parse(row.skills) as string[],
    frontmatterExtra: exposedFm,
    bodyMd: row.bodyMd,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (outputKinds !== undefined) agent.outputKinds = outputKinds
  if (row.model !== null) agent.model = row.model
  if (row.variant !== null) agent.variant = row.variant
  if (row.temperature !== null) agent.temperature = row.temperature
  if (row.steps !== null) agent.steps = row.steps
  if (row.maxSteps !== null) agent.maxSteps = row.maxSteps
  return agent
}
