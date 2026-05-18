// RFC-036 — multi-entrance login screen.
//   1. username + password (primary)
//   2. enabled OIDC provider buttons (when configured)
//   3. legacy daemon-token fallback (collapsible)
// Shown when localStorage has no token, after a 401, or on first visit.

import { createRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { AUTH_DEFAULT_BASE_URL, getBaseUrl, setBaseUrl, setToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

interface AuthSearch {
  redirect?: string
}

interface OidcProvider {
  slug: string
  displayName: string
  iconUrl: string | null
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
  const [baseInput, setBaseInput] = useState(getBaseUrl())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [tokenOpen, setTokenOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState<OidcProvider[]>([])

  useEffect(() => {
    setBaseUrl(baseInput)
    void api
      .get<{ providers: OidcProvider[] }>('/api/auth/oidc/providers')
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]))
  }, [baseInput])

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    setBaseUrl(baseInput)
    try {
      const r = await api.post<{ sessionToken: string }>('/api/auth/login', {
        username,
        password,
      })
      setToken(r.sessionToken)
      navigate({ to: (redirect as '/agents' | undefined) ?? '/agents' })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError(t('auth.invalidCredentials'))
      } else {
        setError(describeApiError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleTokenSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    setBaseUrl(baseInput)
    setToken(tokenInput)
    try {
      await api.get('/api/whoami')
      navigate({ to: (redirect as '/agents' | undefined) ?? '/agents' })
    } catch (e) {
      setError(describeApiError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleOidcLogin(slug: string) {
    try {
      const r = await api.post<{ authorizeUrl: string }>(`/api/auth/oidc/${slug}/login/start`, {
        postLoginRedirect: redirect ?? '/',
      })
      window.location.href = r.authorizeUrl
    } catch (e) {
      setError(describeApiError(e))
    }
  }

  // Honor session-token-in-fragment redirect from OIDC callback.
  useEffect(() => {
    const m = window.location.hash.match(/^#aw_session=(.+)$/)
    if (m && m[1]) {
      setToken(decodeURIComponent(m[1]))
      window.location.hash = ''
      navigate({ to: '/agents' })
    }
  }, [navigate])

  return (
    <div className="auth-page">
      <h1>{t('auth.title')}</h1>
      <p className="auth-page__hint">{t('auth.subtitle', { defaultValue: t('auth.hint') })}</p>
      <form onSubmit={handlePasswordSubmit} className="auth-form">
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
          {t('auth.username', { defaultValue: 'Username' })}
          <input
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('auth.usernamePlaceholder', { defaultValue: 'alice' })}
            autoFocus
          />
        </label>
        <label>
          {t('auth.password', { defaultValue: 'Password' })}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('auth.passwordPlaceholder', { defaultValue: '••••••••' })}
          />
        </label>
        {error !== null && <div className="auth-form__error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? t('auth.verifying') : t('auth.signIn', { defaultValue: t('auth.connect') })}
        </button>
      </form>
      {providers.length > 0 && (
        <div className="auth-page__providers" data-testid="oidc-providers">
          <div className="auth-page__divider">{t('auth.or', { defaultValue: 'or' })}</div>
          {providers.map((p) => (
            <button
              key={p.slug}
              type="button"
              className="auth-page__provider-btn"
              onClick={() => handleOidcLogin(p.slug)}
            >
              {t('auth.loginWith', {
                name: p.displayName,
                defaultValue: `Login with ${p.displayName}`,
              })}
            </button>
          ))}
        </div>
      )}
      <details
        className="auth-page__token-fallback"
        open={tokenOpen}
        onToggle={(e) => setTokenOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>{t('auth.useDaemonToken', { defaultValue: 'Use daemon token' })}</summary>
        <form onSubmit={handleTokenSubmit} className="auth-form">
          <label>
            {t('auth.token')}
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('auth.tokenPlaceholder')}
            />
          </label>
          <button type="submit" disabled={busy || !tokenInput}>
            {busy ? t('auth.verifying') : t('auth.connect')}
          </button>
        </form>
      </details>
    </div>
  )
}
