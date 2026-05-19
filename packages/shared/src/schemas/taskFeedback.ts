// RFC-041: Per-task user notes ("dear future me"). Each row, on insert,
// enqueues one memory_distill_job. See design/RFC-041-platform-long-term-memory/design.md §3.2.

import { z } from 'zod'

export const TaskFeedbackSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  authorUserId: z.string().nullable(),
  bodyMd: z.string().min(1).max(4000),
  createdAt: z.number().int(),
  distilled: z.boolean(),
  distillJobId: z.string().nullable(),
})
export type TaskFeedback = z.infer<typeof TaskFeedbackSchema>

export const TaskFeedbackCreateSchema = z.object({
  bodyMd: z.string().trim().min(1).max(4000),
})
export type TaskFeedbackCreate = z.infer<typeof TaskFeedbackCreateSchema>
