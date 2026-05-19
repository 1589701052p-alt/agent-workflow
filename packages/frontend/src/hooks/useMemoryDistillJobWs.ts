// RFC-041 PR4 — admin-only WS subscription for distill-job lifecycle.
//
// /ws/memory-distill-jobs is admin-only (backend WS upgrade enforces it).
// The hook is safe to mount unconditionally for non-admins because we
// short-circuit on `enabled=false` — callers gate it on
// usePermission('memory:approve').
//
// Events drive the Distill Jobs table; for `distill.done` we additionally
// invalidate the memory candidate queries so new candidates appear in the
// approval queue without a manual refresh.

import { useQueryClient } from '@tanstack/react-query'
import type { MemoryDistillJobWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'
import { MEMORY_QUERY_KEYS } from './useMemoryWs'

export interface UseMemoryDistillJobWsOpts {
  enabled?: boolean
}

export const DISTILL_JOB_QUERY_KEYS = {
  list: ['memory-distill-jobs', 'list'] as const,
  detail: (id: string) => ['memory-distill-jobs', 'detail', id] as const,
}

export function useMemoryDistillJobWs({ enabled = true }: UseMemoryDistillJobWsOpts = {}): void {
  const qc = useQueryClient()
  useWebSocket({
    path: '/ws/memory-distill-jobs',
    enabled,
    onMessage: (raw) => {
      if (typeof raw !== 'object' || raw === null) return
      const msg = raw as MemoryDistillJobWsMessage & { type?: string }
      if (typeof msg.type !== 'string' || !msg.type.startsWith('distill.')) return
      void qc.invalidateQueries({ queryKey: DISTILL_JOB_QUERY_KEYS.list })
      if ('jobId' in msg && typeof msg.jobId === 'string') {
        void qc.invalidateQueries({ queryKey: DISTILL_JOB_QUERY_KEYS.detail(msg.jobId) })
      }
      // distill.done means a fresh candidate row likely appeared.
      if (msg.type === 'distill.done') {
        void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.pendingCount })
        void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.candidates })
      }
    },
  })
}
