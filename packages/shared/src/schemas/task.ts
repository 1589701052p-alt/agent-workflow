// Task schemas. Mirrors design.md §3 (tasks table) + plan.md P-1-14.

import { z } from 'zod'

export const TASK_STATUS = [
  'pending',
  'running',
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const
export const TaskStatusSchema = z.enum(TASK_STATUS)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/** Full task row as returned by GET /api/tasks/:id. */
export const TaskSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  /** Snapshotted workflow definition; survives later workflow edits. */
  workflowSnapshot: z.unknown(),
  repoPath: z.string(),
  worktreePath: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  baseCommit: z.string().nullable(),
  status: TaskStatusSchema,
  inputs: z.record(z.string(), z.string()),
  maxDurationMs: z.number().int().nonnegative().nullable(),
  maxTotalTokens: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  errorSummary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failedNodeId: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  deletedAt: z.number().int().nullable(),
  schemaVersion: z.number().int(),
})
export type Task = z.infer<typeof TaskSchema>

/** Compact task entry for list pages. */
export const TaskSummarySchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  repoPath: z.string(),
  status: TaskStatusSchema,
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  errorSummary: z.string().nullable(),
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

/** POST /api/tasks body. */
export const StartTaskSchema = z.object({
  workflowId: z.string().min(1),
  repoPath: z.string().min(1),
  baseBranch: z.string().min(1),
  inputs: z.record(z.string(), z.string()).default({}),
  /** Per-task overrides (settings defaults apply when omitted). */
  maxDurationMs: z.number().int().nonnegative().optional(),
  maxTotalTokens: z.number().int().nonnegative().optional(),
})
export type StartTask = z.infer<typeof StartTaskSchema>

/** Filters for GET /api/tasks. */
export const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  workflowId: z.string().optional(),
  repoPath: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>

// -----------------------------------------------------------------------------
// node_runs — per-node execution rows. Loop iterations + multi-process fan-out
// + retries all produce additional rows of the same shape. The frontend
// detail view (P-1-18) flattens them into a status table.
// -----------------------------------------------------------------------------

export const NODE_RUN_STATUS = [
  'pending',
  'running',
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
] as const
export const NodeRunStatusSchema = z.enum(NODE_RUN_STATUS)
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>

export const NodeRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  nodeId: z.string(),
  parentNodeRunId: z.string().nullable(),
  iteration: z.number().int().nonnegative(),
  shardKey: z.string().nullable(),
  retryIndex: z.number().int().nonnegative(),
  status: NodeRunStatusSchema,
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  /** User prompt sent to opencode (populated after runner builds it). */
  promptText: z.string().nullable(),
  tokInput: z.number().int().nullable(),
  tokOutput: z.number().int().nullable(),
  tokTotal: z.number().int().nullable(),
  tokCacheCreate: z.number().int().nullable(),
  tokCacheRead: z.number().int().nullable(),
})
export type NodeRun = z.infer<typeof NodeRunSchema>

/** Output ports captured from an envelope. */
export const NodeRunOutputSchema = z.object({
  nodeRunId: z.string(),
  port: z.string(),
  value: z.string(),
})
export type NodeRunOutput = z.infer<typeof NodeRunOutputSchema>

/** Response shape of GET /api/tasks/:id/node-runs. */
export const TaskNodeRunsSchema = z.object({
  runs: z.array(NodeRunSchema),
  outputs: z.array(NodeRunOutputSchema),
})
export type TaskNodeRuns = z.infer<typeof TaskNodeRunsSchema>

/** Response shape of GET /api/tasks/:id/node-runs/:nodeRunId/events. */

export const NODE_EVENT_KIND = [
  'tool_use',
  'text',
  'reasoning',
  'permission_asked',
  'error',
  'step_start',
  'step_finish',
  'stderr',
] as const

export const NodeRunEventSchema = z.object({
  id: z.number().int(),
  nodeRunId: z.string(),
  ts: z.number().int(),
  kind: z.enum(NODE_EVENT_KIND),
  payload: z.unknown(),
})
export type NodeRunEvent = z.infer<typeof NodeRunEventSchema>

export const NodeRunEventsResponseSchema = z.object({
  events: z.array(NodeRunEventSchema),
  /** Highest event id in this batch (or null when empty). */
  cursor: z.number().int().nullable(),
})
export type NodeRunEventsResponse = z.infer<typeof NodeRunEventsResponseSchema>

/** Response shape of GET /api/tasks/:id/diff. */
export const TaskDiffSchema = z.object({
  /** Empty string when nothing has changed since the worktree was created. */
  diff: z.string(),
  /** baseCommit used; null when the task failed before worktree creation. */
  baseCommit: z.string().nullable(),
  /** True when diff was truncated for transport. v1 caps at 1 MiB. */
  truncated: z.boolean(),
})
export type TaskDiff = z.infer<typeof TaskDiffSchema>
