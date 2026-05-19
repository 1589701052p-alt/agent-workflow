// RFC-041 PR4 — flat list of every approved memory.
// Used for the /memory/all sub-route. Per-row [Archive] / [Delete] for admins.
//
// Bug-fix (post-RFC-041): the original implementation hardcoded the query
// to status=approved and had no archived view, so once an admin clicked
// Archive (which fired without confirmation) the row vanished from every
// tab and there was no way to un-archive it from the UI. Two fixes:
//   1. Archive button now goes through window.confirm — matches Delete.
//   2. A status filter toggle (Approved / Archived) drives the query;
//      in the Archived view, Archive is replaced with Unarchive.
// Backend already exposes `?status=archived` listing + POST /unarchive.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { describeApiError } from '@/i18n'
import { sortByRecency } from '@/lib/memory'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

type View = 'approved' | 'archived'

export interface MemoryAllListProps {
  isAdmin: boolean
}

export function MemoryAllList({ isAdmin }: MemoryAllListProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [view, setView] = useState<View>('approved')

  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'all', view],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', { status: view }, signal),
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
  }
  const archive = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.post(`/api/memories/${encodeURIComponent(id)}/archive`),
    onSuccess: invalidate,
  })
  const unarchive = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.post(`/api/memories/${encodeURIComponent(id)}/unarchive`),
    onSuccess: invalidate,
  })
  const del = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api.delete(`/api/memories/${encodeURIComponent(id)}?confirm=true`),
    onSuccess: invalidate,
  })

  return (
    <div className="memory-all" data-testid="memory-all">
      <div role="tablist" className="tabs tabs--pills memory-all__filter">
        {(['approved', 'archived'] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={`tabs__tab ${view === v ? 'tabs__tab--active' : ''}`}
            onClick={() => setView(v)}
            data-testid={`memory-all-filter-${v}`}
          >
            {t(`memory.status.${v}`)}
          </button>
        ))}
      </div>

      {renderBody({
        list,
        view,
        isAdmin,
        archive,
        unarchive,
        del,
        t,
      })}
    </div>
  )
}

interface BodyArgs {
  list: ReturnType<typeof useQuery<ListResponse>>
  view: View
  isAdmin: boolean
  archive: ReturnType<typeof useMutation<unknown, ApiError, string>>
  unarchive: ReturnType<typeof useMutation<unknown, ApiError, string>>
  del: ReturnType<typeof useMutation<unknown, ApiError, string>>
  t: (key: string) => string
}

function renderBody({ list, view, isAdmin, archive, unarchive, del, t }: BodyArgs) {
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
              {view === 'approved' ? (
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => {
                    if (window.confirm(t('memory.confirmArchive'))) archive.mutate(m.id)
                  }}
                  disabled={!isAdmin || archive.isPending}
                  data-testid={`memory-all-${m.id}-archive`}
                >
                  {t('memory.action.archive')}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => unarchive.mutate(m.id)}
                  disabled={!isAdmin || unarchive.isPending}
                  data-testid={`memory-all-${m.id}-unarchive`}
                >
                  {t('memory.action.unarchive')}
                </button>
              )}
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
