// Root route — shared layout + auth gate.
//
// If no token is present in localStorage, every route except /auth redirects
// to /auth so the user can paste the daemon token. The daemon prints it at
// startup.
//
// RFC-032 PR1: the previously-flat 10-item sidebar is now a 3-group layout
// (agents / workflows / tasks) with a Home top entry, a placeholder for the
// PR2 inbox button, and a footer row containing the language switch + a
// settings gear button. The legacy reviews/clarify sub-items still render
// inside the workflows group as a PR1 stop-gap until the inbox drawer ships
// in PR2.

import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyPendingCount, ReviewPendingCount } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { LanguageSwitch } from '@/components/LanguageSwitch'
import { NavGroup } from '@/components/shell/NavGroup'
import { SettingsGearButton } from '@/components/shell/SettingsGearButton'
import { useApplyLanguage } from '@/hooks/useLanguage'
import { useApplyTheme } from '@/hooks/useTheme'
import { NAV_GROUPS, resolveActiveNav } from '@/lib/nav'
import type { SubNavItem } from '@/lib/nav'
import { getToken, subscribeAuth } from '@/stores/auth'

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (location.pathname === '/auth') return
    if (getToken() === null) {
      throw redirect({ to: '/auth', search: { redirect: location.pathname } })
    }
  },
  component: RootComponent,
})

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

function RootComponent() {
  const token = useAuthToken()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { t } = useTranslation()
  useApplyTheme()
  useApplyLanguage()
  // RFC-005: Reviews nav badge — periodically poll the pending-count endpoint.
  // Disabled when not signed in to avoid 401 spam.
  const pending = useQuery<ReviewPendingCount>({
    queryKey: ['reviews', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/reviews/pending-count', undefined, signal),
    enabled: token !== null,
    refetchInterval: 15000,
  })
  const pendingCount = pending.data?.count ?? 0
  // RFC-023: same pattern for clarify pending sessions.
  const clarifyPending = useQuery<ClarifyPendingCount>({
    queryKey: ['clarify', 'pending-count'],
    queryFn: ({ signal }) => api.get('/api/clarify/pending-count', undefined, signal),
    enabled: token !== null,
    refetchInterval: 15000,
  })
  const clarifyPendingCount = clarifyPending.data?.count ?? 0

  if (pathname === '/auth' || token === null) {
    return (
      <div className="app-shell app-shell--bare">
        <Outlet />
      </div>
    )
  }

  const active = resolveActiveNav(pathname)
  const renderBadge = (item: SubNavItem) => {
    if (item.to === '/reviews' && pendingCount > 0) {
      return (
        <span className="sidebar__badge" aria-label={`${pendingCount} pending reviews`}>
          {pendingCount > 99 ? '99+' : pendingCount}
        </span>
      )
    }
    if (item.to === '/clarify' && clarifyPendingCount > 0) {
      return (
        <span
          className="sidebar__badge"
          data-testid="clarify-nav-badge"
          aria-label={t('clarify.nav.badgeTitle', { count: clarifyPendingCount })}
        >
          {clarifyPendingCount > 99 ? '99+' : clarifyPendingCount}
        </span>
      )
    }
    return null
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <svg
            className="sidebar__brand-icon"
            viewBox="0 0 64 64"
            width="52"
            height="52"
            aria-hidden="true"
          >
            <defs>
              <linearGradient
                id="aw-stream-a"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#10b981" />
                <stop offset="1" stopColor="#06b6d4" />
              </linearGradient>
              <linearGradient
                id="aw-stream-b"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#3b82f6" />
                <stop offset="1" stopColor="#a855f7" />
              </linearGradient>
              <linearGradient
                id="aw-stream-c"
                x1="0"
                y1="0"
                x2="64"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ec4899" />
                <stop offset="1" stopColor="#f97316" />
              </linearGradient>
            </defs>
            <path
              d="M 6 22 Q 22 12, 32 22 T 58 22"
              fill="none"
              stroke="url(#aw-stream-a)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
            <path
              d="M 6 32 Q 22 22, 32 32 T 58 32"
              fill="none"
              stroke="url(#aw-stream-b)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
            <path
              d="M 6 42 Q 22 32, 32 42 T 58 42"
              fill="none"
              stroke="url(#aw-stream-c)"
              strokeWidth="4"
              strokeLinecap="round"
              opacity="0.95"
            />
          </svg>
          <span>{t('nav.brand')}</span>
        </div>
        <nav className="sidebar__nav">
          <Link
            to="/"
            className={`nav-item nav-item--home${active.onHome ? ' nav-item--active' : ''}`}
            activeOptions={{ exact: true }}
            activeProps={{ className: 'nav-item nav-item--home nav-item--active' }}
          >
            <span className="nav-item__label">{t('nav.home')}</span>
          </Link>
          {NAV_GROUPS.map((group) => (
            <NavGroup key={group.key} group={group} active={active} renderBadge={renderBadge} />
          ))}
        </nav>
        <div className="sidebar__footer">
          <LanguageSwitch />
          <SettingsGearButton active={active.onSettings} />
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
