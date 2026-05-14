import { createRoute, useNavigate } from '@tanstack/react-router'
import { clearToken, getBaseUrl, getToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/settings',
  component: SettingsPage,
})

function SettingsPage() {
  const navigate = useNavigate()
  const token = getToken()
  const baseUrl = getBaseUrl()

  function handleSignOut() {
    clearToken()
    navigate({ to: '/auth' })
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      <p>Config editor lands in P-2-16. For now: connection info.</p>
      <dl className="settings-grid">
        <dt>Daemon URL</dt>
        <dd>{baseUrl}</dd>
        <dt>Token</dt>
        <dd>{token === null ? <em>none</em> : <code>{maskToken(token)}</code>}</dd>
      </dl>
      <button type="button" onClick={handleSignOut} className="btn btn--danger">
        Sign out / re-enter token
      </button>
    </div>
  )
}

function maskToken(t: string): string {
  if (t.length <= 8) return '••••'
  return `${t.slice(0, 4)}…${t.slice(-4)} (${t.length} chars)`
}
