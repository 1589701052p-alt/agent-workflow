// RFC-028 — MCP dependsOn-closure helpers used by the scheduler before each
// runNode spawn. Kept tiny + pure on purpose so the same code is exercised
// by isolated unit tests, scheduler integration tests, and live spawn paths.
//
// Two functions:
//   collectMcpNamesFromClosure(closure)  — pure; unions every closure member's
//                                          mcp[] into a deduped string[] in
//                                          first-seen order.
//   loadMcpsByNames(db, names)           — single DB query (`inArray`) returning
//                                          the matching mcps rows.
//
// Composed in scheduler.ts as:
//   const closure = await agentDeps.computeClosure(db, agent)
//   const names   = collectMcpNamesFromClosure(closure)
//   const mcps    = await loadMcpsByNames(db, names)
//   await runNode({ ..., dependents: closure, mcps })

import type { Agent, Mcp } from '@agent-workflow/shared'
import { McpSchema } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { mcps as mcpsTable } from '@/db/schema'

/**
 * Union the `mcp[]` names declared on every closure agent, preserving the
 * first-seen order across BFS visit order.
 *
 * The closure is whatever shape RFC-022 `resolveDependsClosure` returns:
 * primary agent first, then dependents in BFS order. We rely on that order
 * to make the inline-injection output deterministic across runs (and easy to
 * read in spawn logs).
 */
export function collectMcpNamesFromClosure(closure: readonly Agent[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const agent of closure) {
    for (const name of agent.mcp ?? []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * Hydrate a list of MCP names into full `Mcp` rows. Unknown names are
 * silently skipped: the caller is expected to have already validated names
 * at save time (RFC-028 T5 `mcp-not-found` guard) but at spawn time a row
 * could have been deleted out from under us, and crashing the node spawn
 * over a missing MCP is worse than starting the opencode process without it
 * (opencode itself tolerates missing MCPs by simply not exposing those
 * tools).
 *
 * Empty input returns `[]` without hitting the DB.
 */
export async function loadMcpsByNames(db: DbClient, names: readonly string[]): Promise<Mcp[]> {
  if (names.length === 0) return []
  const rows = await db
    .select()
    .from(mcpsTable)
    .where(inArray(mcpsTable.name, [...names]))
  // Re-parse via the public schema so we never hand the runner a malformed
  // row (the same `mcp-row-corrupt` validation that services/mcp.ts uses).
  const byName = new Map<string, Mcp>()
  for (const row of rows) {
    let config: unknown
    try {
      config = JSON.parse(row.config)
    } catch {
      config = {}
    }
    const parsed = McpSchema.safeParse({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      config,
      enabled: row.enabled,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    if (parsed.success) byName.set(row.name, parsed.data)
  }
  // Preserve caller's name order (matches closure traversal order) so the
  // resulting inline JSON keys list is deterministic.
  const out: Mcp[] = []
  for (const n of names) {
    const m = byName.get(n)
    if (m !== undefined) out.push(m)
  }
  return out
}
