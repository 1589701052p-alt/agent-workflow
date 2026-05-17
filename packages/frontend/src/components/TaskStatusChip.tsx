// Tiny status pill used in task list rows + detail header. Internally renders
// the unified <StatusChip>; the TaskStatus → kind map lives in
// lib/task-status.ts so the homepage task-row picks up the exact same map.

import { useTranslation } from 'react-i18next'
import type { TaskStatus } from '@agent-workflow/shared'
import { StatusChip } from './StatusChip'
import { TASK_STATUS_KIND } from '@/lib/task-status'

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  const { t } = useTranslation()
  return <StatusChip kind={TASK_STATUS_KIND[status]}>{t(`tasks.status.${status}`)}</StatusChip>
}
