// Token entry screen — shown when localStorage has no token, or after a
// 401 from the API. The daemon prints the token on startup; user pastes here.

import { createRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
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
  const { t } = useTranslation()
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
      // /api/whoami is auth-gated; /health is public and would pass even with a bad token.
      await api.get('/api/whoami')
      navigate({ to: (redirect as '/agents' | undefined) ?? '/agents' })
    } catch (e) {
      setError(describeApiError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <h1>{t('auth.title')}</h1>
      <p className="auth-page__hint">
        {t('auth.hint')}
        <code>{t('auth.hintCmd')}</code>
        {t('auth.hintAfter')}
      </p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          {t('auth.daemonUrl')}
          <input
            type="url"
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            placeholder={AUTH_DEFAULT_BASE_URL}
            required
          />
        </label>
        <label>
          {t('auth.token')}
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={t('auth.tokenPlaceholder')}
            required
            autoFocus
          />
        </label>
        {error !== null && <div className="auth-form__error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? t('auth.verifying') : t('auth.connect')}
        </button>
      </form>
    </div>
  )
}
