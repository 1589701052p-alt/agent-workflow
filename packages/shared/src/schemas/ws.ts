// WebSocket message schemas for the three channels described in
// design/design.md §4.3. All messages are JSON; the daemon never sends
// binary frames in v1.

import { z } from 'zod'
import { TaskStatusSchema, TaskSummarySchema } from './task'
import { NodeRunStatusSchema } from './task'
import { DocVersionDecisionSchema, ReviewCommentSchema, ReviewDecisionKindSchema } from './review'

// -----------------------------------------------------------------------------
// /ws/tasks/{taskId}
// -----------------------------------------------------------------------------

export const NodeEventKindSchema = z.enum([
  'tool_use',
  'text',
  'reasoning',
  'permission_asked',
  'error',
  'step_start',
  'step_finish',
  'stderr',
])
export type NodeEventKind = z.infer<typeof NodeEventKindSchema>

export const TaskWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.number().int(),
    type: z.literal('task.status'),
    status: TaskStatusSchema,
    errorSummary: z.string().optional(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('node.status'),
    nodeRunId: z.string(),
    nodeId: z.string(),
    status: NodeRunStatusSchema,
    iteration: z.number().int().optional(),
    retryIndex: z.number().int().optional(),
    shardKey: z.string().optional(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('node.event'),
    nodeRunId: z.string(),
    ts: z.number().int(),
    kind: NodeEventKindSchema,
    payload: z.unknown(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('node.output'),
    nodeRunId: z.string(),
    portName: z.string(),
    content: z.string(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('task.done'),
    status: z.enum(['done', 'failed', 'canceled', 'interrupted']),
  }),
  // -------------------------------------------------------------------------
  // RFC-005 review events. Delivered on the per-task /ws/tasks/{taskId}
  // channel — global Reviews tab uses polling + invalidation on its own.
  // -------------------------------------------------------------------------
  z.object({
    id: z.number().int(),
    type: z.literal('review.created'),
    nodeRunId: z.string(),
    reviewNodeId: z.string(),
    docVersionId: z.string(),
    versionIndex: z.number().int().positive(),
    reviewIteration: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.decision_made'),
    nodeRunId: z.string(),
    decision: ReviewDecisionKindSchema,
    /** New iteration index after this decision (post-bump). */
    reviewIteration: z.number().int().nonnegative(),
    /** Mirrors doc_versions.decision so listeners can refresh in one round-trip. */
    docVersionDecision: DocVersionDecisionSchema,
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_added'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    comment: ReviewCommentSchema,
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_deleted'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    commentId: z.string(),
  }),
  // RFC-009-T1: PATCH on an existing comment broadcasts the updated row so
  // other tabs can replace it in place without re-fetching the full review.
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_updated'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    comment: ReviewCommentSchema,
  }),
])
export type TaskWsMessage = z.infer<typeof TaskWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/tasks (list page)
// -----------------------------------------------------------------------------

export const TasksListWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.created'), task: TaskSummarySchema }),
  z.object({ type: z.literal('task.status'), taskId: z.string(), status: TaskStatusSchema }),
  z.object({ type: z.literal('task.deleted'), taskId: z.string() }),
])
export type TasksListWsMessage = z.infer<typeof TasksListWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/workflows (list + editor multi-tab sync)
// -----------------------------------------------------------------------------

export const WorkflowsWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow.created'),
    workflowId: z.string(),
    name: z.string(),
    version: z.number().int(),
  }),
  z.object({
    type: z.literal('workflow.updated'),
    workflowId: z.string(),
    version: z.number().int(),
    updatedAt: z.number().int(),
  }),
  z.object({ type: z.literal('workflow.deleted'), workflowId: z.string() }),
])
export type WorkflowsWsMessage = z.infer<typeof WorkflowsWsMessageSchema>

// -----------------------------------------------------------------------------
// Server → client control frames common to every channel.
// -----------------------------------------------------------------------------

export const WsControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), channel: z.string(), since: z.number().int().optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
export type WsControlMessage = z.infer<typeof WsControlMessageSchema>
