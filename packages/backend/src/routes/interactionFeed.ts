// RFC-W002 - REST endpoint for the task「评论区」interaction timeline.
//
//   GET /api/tasks/:id/interaction-feed   -> { items, total, truncated }
//
// Auth: read inherits task visibility (canViewTask -> 404 mirrors task routes,
// same shape as "not found"). No write path - the feed is pure read-side
// aggregation over existing tables (tasks / node_runs / node_run_outputs /
// clarify_rounds / doc_versions / review_comments). The aggregation itself is
// the pure `buildInteractionFeed` in @agent-workflow/shared (zero IO, unit-tested);
// this route only maps DB rows to its input shapes.

import { eq, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import { buildInteractionFeed, type InteractionFeedResult } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import {
  clarifyRounds,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks as tasksTable,
} from '@/db/schema'
import type { AppDeps } from '@/server'
import { canViewTask } from '@/services/taskCollab'
import { NotFoundError } from '@/util/errors'

async function loadVisibleTask(deps: AppDeps, taskId: string, actor: Actor) {
  const [t] = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
  if (!t || !(await canViewTask(deps.db, actor, t))) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return t
}

export function mountInteractionFeedRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:id/interaction-feed', async (c) => {
    const taskId = c.req.param('id')
    const task = await loadVisibleTask(deps, taskId, actorOf(c))

    // node_runs for the task (the function filters status='done'; fetching all
    // keeps the query simple and the pure function the single source of truth).
    const runs = await deps.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const runIds = runs.map((r) => r.id)

    // node_run_outputs for those runs (skip the query when there are no runs).
    const outputRows =
      runIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(nodeRunOutputs)
            .where(inArray(nodeRunOutputs.nodeRunId, runIds))

    // clarify_rounds for the task.
    const rounds = await deps.db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.taskId, taskId))

    // doc_versions for the task + review_comments on those versions.
    const docs = await deps.db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    const docIds = docs.map((d) => d.id)
    const commentRows =
      docIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(reviewComments)
            .where(inArray(reviewComments.docVersionId, docIds))

    const result: InteractionFeedResult = buildInteractionFeed({
      task: { id: task.id, startedAt: task.startedAt, inputsJson: task.inputs },
      nodeRuns: runs.map((r) => ({
        id: r.id,
        nodeId: r.nodeId,
        status: r.status,
        finishedAt: r.finishedAt,
      })),
      outputs: outputRows.map((o) => ({
        nodeRunId: o.nodeRunId,
        portName: o.portName,
        content: o.content,
        kind: o.kind,
      })),
      clarifyRounds: rounds.map((r) => ({
        id: r.id,
        kind: r.kind,
        askingNodeId: r.askingNodeId,
        intermediaryNodeRunId: r.intermediaryNodeRunId,
        status: r.status,
        questionsJson: r.questionsJson,
        answersJson: r.answersJson,
        createdAt: r.createdAt,
        answeredAt: r.answeredAt,
      })),
      docVersions: docs.map((d) => ({
        id: d.id,
        reviewNodeRunId: d.reviewNodeRunId,
        sourceNodeId: d.sourceNodeId,
        decision: d.decision,
        decisionReason: d.decisionReason,
        commentsJson: d.commentsJson,
        decidedAt: d.decidedAt,
      })),
      reviewComments: commentRows.map((c) => ({
        docVersionId: c.docVersionId,
        selectedText: c.selectedText,
        commentText: c.commentText,
        author: c.author,
      })),
      workflowSnapshot: task.workflowSnapshot,
    })

    return c.json(result)
  })
}
