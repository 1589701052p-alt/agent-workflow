// RFC-041 PR4 — WS subscription for the platform memory stream.
//
// /ws/memories carries every memory.* event (candidate.created /
// candidate.promoted / archived / unarchived / superseded / deleted).
// This hook invalidates the canonical react-query keys so the approval
// queue, all-approved tab, by-scope browser, and the inbox pending-count
// badge stay live without manual refetches.
//
// The hook is intentionally permission-agnostic — every logged-in user may
// subscribe; the backend WS upgrade enforces the broader admin gate on
// /ws/memory-distill-jobs but the /ws/memories channel is broadcast to all
// logged-in clients (regular users still see "Memories" sub-tabs).

import { useQueryClient } from '@tanstack/react-query'
import type { MemoryWsMessage } from '@agent-workflow/shared'
import { useWebSocket } from './useWebSocket'

export interface UseMemoryWsOpts {
  /** When false the connection is torn down. Default true. */
  enabled?: boolean
}

export const MEMORY_QUERY_KEYS = {
  pendingCount: ['memories', 'pending-count'] as const,
  candidates: ['memories', 'candidates'] as const,
  all: ['memories', 'all'] as const,
  detail: (id: string) => ['memories', 'detail', id] as const,
  scoped: (scopeType: string, scopeId: string | null) =>
    ['memories', 'scoped', scopeType, scopeId] as const,
}

export function useMemoryWs({ enabled = true }: UseMemoryWsOpts = {}): void {
  const qc = useQueryClient()
  useWebSocket({
    path: '/ws/memories',
    enabled,
    onMessage: (raw) => {
      // Treat as MemoryWsMessage; defensive check on `type` so a future
      // server-side rename doesn't crash this hook's invalidation pass.
      if (typeof raw !== 'object' || raw === null) return
      const msg = raw as MemoryWsMessage & { type?: string }
      if (typeof msg.type !== 'string' || !msg.type.startsWith('memory.')) return
      // Invalidate the broad surface — react-query coalesces refetches so
      // multiple invalidates in a single message are cheap.
      void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.pendingCount })
      void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.candidates })
      void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.all })
      void qc.invalidateQueries({ queryKey: ['memories', 'scoped'] })
      // Detail invalidation when the message carries a single id.
      const maybeId =
        msg.type === 'memory.candidate.created'
          ? msg.memory.id
          : 'memoryId' in msg
            ? msg.memoryId
            : null
      if (typeof maybeId === 'string') {
        void qc.invalidateQueries({ queryKey: MEMORY_QUERY_KEYS.detail(maybeId) })
      }
    },
  })
}
