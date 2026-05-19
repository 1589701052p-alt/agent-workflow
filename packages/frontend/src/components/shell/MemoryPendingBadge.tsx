// RFC-041 PR4 follow-up — admin-only pending-candidate count badge.
//
// Rendered as the `renderBadge(item)` return value for the Memory sub-nav
// item inside NavGroup. The Link itself is owned by NavGroup; this
// component is purely the right-aligned numeric badge.
//
// Visibility rules:
//   - non-admin → returns null (no badge, no fetch fired)
//   - admin with 0 pending → returns null
//   - admin with ≥1 pending → returns a `.sidebar__badge.nav-item__badge`
// WS invalidation lives in `useMemoryWs`, which the /memory route mounts.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'

interface ListResponse {
  items: MemorySummary[]
}

export function MemoryPendingBadge() {
  const { t } = useTranslation()
  const isAdmin = usePermission('memory:approve')
  const pending = useQuery<ListResponse>({
    queryKey: ['memories', 'pending-count'],
    queryFn: ({ signal }) =>
      api.get<ListResponse>('/api/memories', { status: 'candidate' }, signal),
    enabled: isAdmin,
    refetchInterval: 60_000,
  })

  if (!isAdmin) return null
  const count = pending.data?.items.length ?? 0
  if (count === 0) return null
  const badgeText = count > 99 ? '99+' : String(count)
  return (
    <span
      className="sidebar__badge nav-item__badge"
      data-testid="nav-memory-badge"
      aria-label={t('nav.memoryBadge', { count })}
    >
      {badgeText}
    </span>
  )
}
