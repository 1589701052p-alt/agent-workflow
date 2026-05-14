// Token entry screen — shown when localStorage has no token, or after a
// 401 from the API. The daemon prints the token on startup; user pastes here.

import { createRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { api, ApiError } from '@/api/client'
import { AUTH_DEFAULT_BASE_URL, getBaseUrl, setBaseUrl, setToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

interface AuthSearch {
  redirect?: string
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/auth',
  validateSearch: (raw: Record<string, unknown>): AuthSearch => {
    const out: AuthSearch = {}
    if (typeof raw.redirect === 'string') out.redirect = raw.redirect
    return out
  },
  component: AuthPage,
})

function AuthPage() {
  const navigate = useNavigate()
  const { redirect } = useSearch({ from: Route.id }) as AuthSearch
  const [tokenInput, setTokenInput] = useState('')
  const [baseInput, setBaseInput] = useState(getBaseUrl())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    setBaseUrl(baseInput)
    setToken(tokenInput)
    try {
      await api.get('/api/health')
      navigate({ to: (redirect as '/agents' | undefined) ?? '/agents' })
    } catch (e) {
      if (e instanceof ApiError) {
        setError(`${e.code}: ${e.message}`)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <h1>Connect to daemon</h1>
      <p className="auth-page__hint">
        Run <code>agent-workflow start</code>; copy the token it prints on stdout and paste below.
      </p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          Daemon URL
          <input
            type="url"
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            placeholder={AUTH_DEFAULT_BASE_URL}
            required
          />
        </label>
        <label>
          Token
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="64-char hex"
            required
            autoFocus
          />
        </label>
        {error !== null && <div className="auth-form__error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Verifying…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
