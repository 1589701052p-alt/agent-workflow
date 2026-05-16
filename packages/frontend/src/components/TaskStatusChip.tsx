// Tiny status pill used in task list rows + detail header. Colors map to
// the task status enum from shared schemas.

import type { TaskStatus } from '@agent-workflow/shared'

const TONES: Record<TaskStatus, string> = {
  pending: 'gray',
  running: 'blue',
  done: 'green',
  failed: 'red',
  canceled: 'gray',
  interrupted: 'amber',
  awaiting_review: 'amber',
  awaiting_human: 'amber',
}

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return <span className={`status-chip status-chip--${TONES[status]}`}>{status}</span>
}
