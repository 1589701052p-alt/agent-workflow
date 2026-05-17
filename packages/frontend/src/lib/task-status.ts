// RFC-035 — single source of truth for TaskStatus → StatusChipKind mapping.
// Both <TaskStatusChip> and the homepage task-row import this so the same
// semantic color appears on /tasks list, /tasks/$id header, and the homepage
// "running" / "recently done" sections.

import type { TaskStatus } from '@agent-workflow/shared'
import type { StatusChipKind } from '@/components/StatusChip'

export const TASK_STATUS_KIND: Record<TaskStatus, StatusChipKind> = {
  pending: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
  interrupted: 'warn',
  awaiting_review: 'warn',
  awaiting_human: 'warn',
}

export function taskStatusToKind(status: TaskStatus): StatusChipKind {
  return TASK_STATUS_KIND[status]
}
