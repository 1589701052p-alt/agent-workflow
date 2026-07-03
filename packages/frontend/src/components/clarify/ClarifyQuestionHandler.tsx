// RFC-120 D12 — the clarify page's per-question handler echo + picker. The
// designer/handler of a cross-clarify question is the same single source of
// truth (`task_questions.override_target_node_id`) the board edits; this control
// shows it on the clarify page too and lets a member re-target it (designer-only,
// non-terminal — same capability as the board).
//
// Self-contained + degrades to null when its data is absent, so it can be dropped
// into the (dense, flaky-test-covered) clarify page without disturbing it: the
// existing clarify tests don't mock /api/tasks/:id/questions, so this renders
// nothing there.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Select } from '@/components/Select'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { resolveNodeNameFromSnapshot } from '@/lib/node-names'

/** RFC-138 reassign 响应：collapse（改派给提问节点 ⇒ 退化为反问者 scope、designer 条目
 *  消失）需要区别于常规 override 给出反馈——条目没了，控件会自行消失，留一行知会文案。 */
interface ReassignResponse {
  ok: boolean
  /** RFC-140: + 'collapsed-to-designer' (questioner→designer collapse) — this control only
   *  reassigns DESIGNER rows so it never receives that value; typed for API completeness. */
  action?: 'override' | 'collapsed-to-questioner' | 'collapsed-to-designer'
}

export interface ClarifyQuestionHandlerProps {
  taskId: string
  questionId: string
  /** RFC-128 P4 (Codex P2-2): restrict the designer-entry match to THIS round. Clarify
   *  question ids are agent-provided + round-local, so two rounds can reuse the same id;
   *  without this the handler could show/mutate a SIBLING round's designer entry. Optional
   *  for back-compat — omitted ⇒ match by (questionId, designer) across the task (legacy). */
  originNodeRunId?: string
}

export function ClarifyQuestionHandler({
  taskId,
  questionId,
  originNodeRunId,
}: ClarifyQuestionHandlerProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const entries = useQuery<TaskQuestionEntry[]>({
    queryKey: ['task-questions', taskId],
    queryFn: () => api.get<TaskQuestionEntry[]>(`/api/tasks/${taskId}/questions`),
  })
  const task = useQuery<{ workflowSnapshot?: WorkflowDefinition }>({
    queryKey: ['tasks', taskId, 'snapshot'],
    queryFn: () => api.get<{ workflowSnapshot?: WorkflowDefinition }>(`/api/tasks/${taskId}`),
  })
  // RFC-138: collapse 后条目被删除，invalidate 会让本控件对不上 entry 而消失——用本地
  // 状态把知会文案留在原位（不新造 chrome，复用 .muted）。
  const [collapsed, setCollapsed] = useState(false)
  const reassign = useMutation({
    mutationFn: (v: { id: string; targetNodeId: string }) =>
      api.post<ReassignResponse>(`/api/tasks/${taskId}/questions/${v.id}/reassign`, {
        targetNodeId: v.targetNodeId,
      }),
    onSuccess: (data) => {
      if (data?.action === 'collapsed-to-questioner') setCollapsed(true)
      void qc.invalidateQueries({ queryKey: ['task-questions', taskId] })
    },
  })

  // Only designer-domain (修订型) questions have a re-targetable handler.
  // Defensive against any response shape (e.g. a test fetch-mock that doesn't
  // serve this endpoint) — never throw inside the (fragile) clarify page.
  const entry = Array.isArray(entries.data)
    ? entries.data.find(
        (e) =>
          e.questionId === questionId &&
          e.roleKind === 'designer' &&
          (originNodeRunId === undefined || e.originNodeRunId === originNodeRunId),
      )
    : undefined
  if (!entry) {
    // RFC-138: 刚被本控件 collapse 掉的条目——留一行知会，替代凭空消失。
    if (collapsed) {
      return (
        <div className="clarify-handler muted" data-testid={`clarify-handler-${questionId}`}>
          {t('taskQuestions.collapsedToQuestioner')}
        </div>
      )
    }
    return null
  }

  // 用户 2026-07-02: 处理节点显示节点名（title → agentName → id 回退），与看板/节点表同一 oracle。
  const snapshot = task.data?.workflowSnapshot
  const snapNodes = snapshot?.nodes
  const nodes: WorkflowNode[] = Array.isArray(snapNodes) ? snapNodes : []
  const agentNodes = nodes
    .filter((n) => n.kind.startsWith('agent'))
    .map((n) => ({ value: n.id, label: resolveNodeNameFromSnapshot(snapshot, n.id) ?? n.id }))
  const editable = entry.phase !== 'done' && agentNodes.length > 0

  return (
    <div className="clarify-handler" data-testid={`clarify-handler-${questionId}`}>
      <span className="muted">{t('taskQuestions.target')}:</span>{' '}
      {editable ? (
        <Select
          value={entry.effectiveTargetNodeId ?? ''}
          ariaLabel={t('taskQuestions.reassign')}
          options={agentNodes}
          onChange={(v) => reassign.mutate({ id: entry.id, targetNodeId: v })}
        />
      ) : (
        <span>
          {entry.effectiveTargetNodeId !== null
            ? (resolveNodeNameFromSnapshot(snapshot, entry.effectiveTargetNodeId) ??
              entry.effectiveTargetNodeId)
            : t('taskQuestions.noTarget')}
        </span>
      )}
    </div>
  )
}
