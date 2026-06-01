// RFC-057 — common DB query helpers shared between option modules.
// Living in a sibling file (not the engine entry) avoids cycles.

import { and, desc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'

import type { RepairNodeRunRow } from './types'

const NODE_RUN_COLS = {
  id: nodeRuns.id,
  nodeId: nodeRuns.nodeId,
  status: nodeRuns.status,
  retryIndex: nodeRuns.retryIndex,
  reviewIteration: nodeRuns.reviewIteration,
  shardKey: nodeRuns.shardKey,
  iteration: nodeRuns.iteration,
}

export async function loadNodeRun(
  db: DbClient,
  nodeRunId: string,
): Promise<RepairNodeRunRow | null> {
  const rows = await db
    .select(NODE_RUN_COLS)
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  return rows[0] ?? null
}

export async function loadNodeRunsForNode(
  db: DbClient,
  taskId: string,
  nodeId: string,
): Promise<RepairNodeRunRow[]> {
  return db
    .select(NODE_RUN_COLS)
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
    .orderBy(desc(nodeRuns.retryIndex))
}

export async function loadAllNodeRunsForTask(
  db: DbClient,
  taskId: string,
): Promise<RepairNodeRunRow[]> {
  return db.select(NODE_RUN_COLS).from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
}

/** TERMINAL excluding 'done' — used by "the row got force-terminated by orphan
 * reap / shutdown and we want to bring it back to life" preflights. */
export const TERMINAL_NON_DONE = ['failed', 'canceled', 'interrupted', 'exhausted'] as const
export type TerminalNonDoneStatus = (typeof TERMINAL_NON_DONE)[number]

export function isTerminalNonDone(s: string): s is TerminalNonDoneStatus {
  return (TERMINAL_NON_DONE as readonly string[]).includes(s)
}
