// RFC-041 PR4 — flat list of every approved memory.
// Used for the /memory/all sub-route. Per-row [Archive] / [Delete] for admins.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { describeApiError } from '@/i18n'
import { sortByRecency } from '@/lib/memory'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export interface MemoryAllListProps {
  isAdmin: boolean
}

export function MemoryAllList({ isAdmin }: MemoryAllListProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'all'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', { status: 'approved' }, signal),
  })

  const archive = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.post(`/api/memories/${encodeURIComponent(id)}/archive`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
    },
  })
  const del = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.delete(`/api/memories/${encodeURIComponent(id)}?confirm=true`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
    },
  })

  if (list.isLoading) return <LoadingState />
  if (list.error !== null && list.error !== undefined) {
    return <div className="error-box">{describeApiError(list.error)}</div>
  }
  const rows = sortByRecency(list.data?.items ?? [])
  if (rows.length === 0) {
    return <EmptyState title={t('memory.empty')} />
  }

  return (
    <ul className="memory-all-list" data-testid="memory-all-list">
      {rows.map((m) => (
        <MemoryRow
          key={m.id}
          memory={m}
          actions={
            <>
              <button
                type="button"
                className="btn btn--xs"
                onClick={() => archive.mutate(m.id)}
                disabled={!isAdmin || archive.isPending}
                data-testid={`memory-all-${m.id}-archive`}
              >
                {t('memory.action.archive')}
              </button>
              <button
                type="button"
                className="btn btn--xs btn--danger"
                onClick={() => {
                  if (window.confirm(t('memory.confirmDelete'))) del.mutate(m.id)
                }}
                disabled={!isAdmin || del.isPending}
                data-testid={`memory-all-${m.id}-delete`}
              >
                {t('memory.action.delete')}
              </button>
            </>
          }
        />
      ))}
    </ul>
  )
}
