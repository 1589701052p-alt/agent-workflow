// RFC-041 PR4 — top-level Memory nav link with admin pending-count badge.
//
// Always rendered for logged-in users; the right-side badge appears only
// when the actor has `memory:approve` (admins) AND there is at least one
// candidate awaiting review. WS invalidation (useMemoryWs) keeps the count
// live without polling beyond the initial fetch.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { usePermission } from '@/hooks/useActor'

interface ListResponse {
  items: MemorySummary[]
}

export function MemoryNavLink() {
  const { t } = useTranslation()
  const isAdmin = usePermission('memory:approve')
  const pending = useQuery<ListResponse>({
    queryKey: ['memories', 'pending-count'],
    queryFn: ({ signal }) =>
      api.get<ListResponse>('/api/memories', { status: 'candidate' }, signal),
    enabled: isAdmin,
    refetchInterval: 60_000,
  })

  const count = isAdmin ? (pending.data?.items.length ?? 0) : 0
  const showBadge = isAdmin && count > 0
  const badgeText = count > 99 ? '99+' : String(count)

  return (
    <Link
      to="/memory"
      className="nav-item nav-item--memory"
      activeProps={{ className: 'nav-item nav-item--memory nav-item--active' }}
      data-testid="nav-memory-link"
    >
      <span className="nav-item__label">{t('nav.memory')}</span>
      {showBadge && (
        <span
          className="sidebar__badge nav-item__badge"
          data-testid="nav-memory-badge"
          aria-label={t('nav.memoryBadge', { count })}
        >
          {badgeText}
        </span>
      )}
    </Link>
  )
}
