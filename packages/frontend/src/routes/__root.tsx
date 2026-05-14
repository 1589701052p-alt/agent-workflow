// Root route — shared layout + auth gate.
//
// If no token is present in localStorage, every route except /auth redirects
// to /auth so the user can paste the daemon token. The daemon prints it at
// startup.

import { Link, Outlet, createRootRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import { getToken, subscribeAuth } from '@/stores/auth'

const NAV: { to: string; label: string }[] = [
  { to: '/agents', label: 'Agents' },
  { to: '/skills', label: 'Skills' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/tasks', label: 'Tasks' },
  { to: '/settings', label: 'Settings' },
]

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

  if (pathname === '/auth' || token === null) {
    return (
      <div className="app-shell app-shell--bare">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">Agent Workflow</div>
        <nav className="sidebar__nav">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="sidebar__link"
              activeProps={{ className: 'sidebar__link sidebar__link--active' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
