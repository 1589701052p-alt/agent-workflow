// RFC-041 PR4 — read-only list of approved memories for a single
// (scopeType, scopeId) pair. Embedded in agent / workflow / repo detail
// pages as the "Memories" sub-tab. Global scope passes scopeId=null.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemoryScope, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { describeApiError } from '@/i18n'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export interface MemoryScopedListProps {
  scopeType: MemoryScope
  scopeId: string | null
  'data-testid'?: string
}

export function MemoryScopedList(props: MemoryScopedListProps) {
  const { t } = useTranslation()
  const query: Record<string, string> = { status: 'approved', scopeType: props.scopeType }
  if (props.scopeId !== null) query.scopeId = props.scopeId
  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'scoped', props.scopeType, props.scopeId ?? '__global__'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', query, signal),
  })

  if (list.isLoading) return <LoadingState size="compact" />
  if (list.error !== null && list.error !== undefined) {
    return <div className="error-box">{describeApiError(list.error)}</div>
  }
  const rows = list.data?.items ?? []
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('memory.empty')}
        data-testid={props['data-testid'] ?? 'memory-scoped-empty'}
      />
    )
  }

  return (
    <ul className="memory-scoped-list" data-testid={props['data-testid'] ?? 'memory-scoped-list'}>
      {rows.map((m) => (
        <MemoryRow key={m.id} memory={m} />
      ))}
    </ul>
  )
}
