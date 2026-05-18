// RFC-036 — three-tab login screen:
//   - Password (default)
//   - OIDC provider (shown when /api/auth/oidc/providers returns ≥1 entry)
//   - Daemon token (admin / break-glass fallback)
// Shown when localStorage has no token, after a 401, or on first visit. The
// daemon URL field is no longer surfaced — the SPA always talks to its own
// origin (vite proxy in dev, same-host bundle in prod); remote setups can
// still override BASE_URL_KEY via localStorage for now.

import { createRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { setToken } from '@/stores/auth'
import { Route as RootRoute } from './__root'

interface AuthSearch {
  redirect?: string
}

interface OidcProvider {
  slug: string
  displayName: string
  iconUrl: string | null
}

type AuthTab = 'password' | 'oidc' | 'token'

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
  const [providers, setProviders] = useState<OidcProvider[]>([])
  const [tab, setTab] = useState<AuthTab>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Fetch enabled providers once on mount; show the OIDC tab only when the
  // list is non-empty.
  useEffect(() => {
    void api
      .get<{ providers: OidcProvider[] }>('/api/auth/oidc/providers')
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]))
  }, [])

  // Honor session-token-in-fragment redirect from OIDC callback.
  useEffect(() => {
    const m = window.location.hash.match(/^#aw_session=(.+)$/)
    if (m && m[1]) {
      setToken(decodeURIComponent(m[1]))
      window.location.hash = ''
      navigate({ to: '/agents' })
    }
  }, [navigate])

  // When switching tabs, drop any per-tab error so the user gets a clean
  // form. We deliberately keep input values so accidental tab clicks don't
  // wipe what they typed.
  function switchTab(next: AuthTab) {
    setTab(next)
    setError(null)
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
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
    setError(null)
    try {
      const r = await api.post<{ authorizeUrl: string }>(`/api/auth/oidc/${slug}/login/start`, {
        postLoginRedirect: redirect ?? '/',
      })
      window.location.href = r.authorizeUrl
    } catch (e) {
      setError(describeApiError(e))
    }
  }

  const tabs: Array<{ key: AuthTab; label: string }> = [
    { key: 'password', label: t('auth.tabPassword', { defaultValue: 'Password' }) },
  ]
  if (providers.length > 0) {
    tabs.push({ key: 'oidc', label: t('auth.tabOidc', { defaultValue: 'Identity provider' }) })
  }
  tabs.push({ key: 'token', label: t('auth.tabToken', { defaultValue: 'Daemon token' }) })

  return (
    <div className="auth-page">
      <h1>{t('auth.title')}</h1>
      <p className="auth-page__hint">{t('auth.subtitle', { defaultValue: t('auth.hint') })}</p>
      <div className="auth-tabs" role="tablist" aria-label={t('auth.title')}>
        {tabs.map((it) => (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={tab === it.key}
            className={`auth-tabs__tab ${tab === it.key ? 'auth-tabs__tab--active' : ''}`}
            onClick={() => switchTab(it.key)}
          >
            {it.label}
          </button>
        ))}
      </div>

      {tab === 'password' && (
        <form
          onSubmit={handlePasswordSubmit}
          className="auth-form"
          role="tabpanel"
          data-testid="auth-tabpanel-password"
        >
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
      )}

      {tab === 'oidc' && (
        <div className="auth-page__providers" data-testid="auth-tabpanel-oidc" role="tabpanel">
          <p className="auth-page__provider-hint">
            {t('auth.oidcHint', { defaultValue: 'Sign in with an external identity provider.' })}
          </p>
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
          {error !== null && <div className="auth-form__error">{error}</div>}
        </div>
      )}

      {tab === 'token' && (
        <form
          onSubmit={handleTokenSubmit}
          className="auth-form"
          role="tabpanel"
          data-testid="auth-tabpanel-token"
        >
          <p className="auth-form__hint">
            {t('auth.tokenHint', {
              defaultValue:
                'Use the 64-char hex token printed when the daemon started. Admin / break-glass only.',
            })}
          </p>
          <label>
            {t('auth.token')}
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={t('auth.tokenPlaceholder')}
              autoFocus
            />
          </label>
          {error !== null && <div className="auth-form__error">{error}</div>}
          <button type="submit" disabled={busy || !tokenInput}>
            {busy ? t('auth.verifying') : t('auth.connect')}
          </button>
        </form>
      )}
    </div>
  )
}
