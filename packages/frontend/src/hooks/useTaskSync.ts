// Subscribe to /ws/tasks/{taskId} for the detail page. Invalidates the
// task / node-runs / diff queries on relevant events. The diff query is
// only invalidated on task.status or task.done because per-event diff
// recomputes would be expensive; tracked separately for future tuning.

import { useQueryClient } from '@tanstack/react-query'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export function useTaskSync(taskId: string | null): void {
  const qc = useQueryClient()
  useWebSocket({
    path: taskId === null ? '' : `/ws/tasks/${encodeURIComponent(taskId)}`,
    enabled: taskId !== null,
    onMessage: (raw) => {
      if (taskId === null) return
      const msg = raw as TaskWsMessage
      if (msg.type === 'task.status' || msg.type === 'task.done') {
        void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'diff'] })
        // Also re-fetch node-runs/outputs on terminal transitions: the
        // per-node status/output events may interleave with task.done in
        // either order (or drop on slower runners), so without this the
        // panel can stay stuck on "pending…" after the task heading shows
        // "done". Caught by the macOS Playwright e2e at main.spec.ts:243.
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
      if (msg.type === 'node.status') {
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
      if (msg.type === 'node.event' || msg.type === 'node.output') {
        // Future: render directly on a node-events feed instead of going
        // through react-query. For now we just keep the node-runs row's
        // token usage etc. up to date.
        void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
      }
    },
  })
}
