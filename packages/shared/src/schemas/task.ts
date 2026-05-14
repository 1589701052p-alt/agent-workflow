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
