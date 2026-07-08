// RFC-032 PR3: shared row primitive for the Running + Recently-finished
// homepage sections.
//
// Rendered as a button so keyboard users can tab into it; routes to
// `/tasks/$id` on click.
//
// RFC-035: the inline `task-row__status*` span is replaced with the unified
// <StatusChip>. The TaskStatus → kind map lives in lib/task-status.ts so
// /tasks list + /tasks/$id header + homepage row use the exact same map.
//
// RFC-150 PR-1 (flag-audit §4.6 W0 补做): the row label reads the same
// `tasks.status.*` i18n family as <TaskStatusChip> — the parallel
// `home.taskRow.status*` key family (a second source of truth for the same
// enum, with drifted wording) is deleted.

import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { TaskSummary } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'
import { TASK_STATUS_KIND } from '@/lib/task-status'
import { formatRelativeTime } from '@/lib/homepage'

interface TaskRowProps {
  task: TaskSummary
  /** Provide a stable ms value so the row's relative time stays stable across renders within the same tick. */
  nowMs: number
}

export function TaskRow({ task, nowMs }: TaskRowProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ts = task.finishedAt ?? task.startedAt
  const rel = formatRelativeTime(nowMs, ts)
  const statusLabel = t(`tasks.status.${task.status}`)
  return (
    <button
      type="button"
      className={`task-row task-row--${task.status}`}
      data-testid={`task-row-${task.id}`}
      onClick={() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void navigate({ to: '/tasks/$id', params: { id: task.id } } as any)
      }}
    >
      <span className="task-row__id" title={task.id}>
        {task.id}
      </span>
      <span className="task-row__name">{task.workflowName ?? '—'}</span>
      <StatusChip
        kind={TASK_STATUS_KIND[task.status]}
        size="sm"
        className="task-row__status"
        data-testid={`task-row-status-${task.id}`}
      >
        {statusLabel}
      </StatusChip>
      <span className="task-row__time muted">{t(`home.taskRow.${rel.key}`, rel.opts)}</span>
    </button>
  )
}
