// RFC-036 — user self-service page (/account). Available to admin + user
// (account:self permission). Lets the actor change their password, view
// active sessions, manage PATs, and review linked identities.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { ACTOR_QUERY_KEY, useActor, type MeResponse } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/account',
  component: AccountPage,
})

function AccountPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useActor()
  if (isLoading) return <div className="page">Loading…</div>
  if (!data) {
    return (
      <div className="page">
        <h1>{t('account.title', { defaultValue: 'My account' })}</h1>
        <p>Please sign in.</p>
      </div>
    )
  }
  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('account.title', { defaultValue: 'My account' })}</h1>
        <p className="page__hint">
          {t('account.subtitle', { defaultValue: 'Manage your password, sessions, and tokens.' })}
        </p>
      </header>
      <ProfileSection me={data} />
      <PasswordSection />
      <PatSection />
      <IdentitiesSection />
      <SessionsSection />
    </div>
  )
}

function ProfileSection({ me }: { me: MeResponse }) {
  const { t } = useTranslation()
  return (
    <section className="card">
      <h2>{t('account.profile', { defaultValue: 'Profile' })}</h2>
      <dl>
        <dt>{t('account.username', { defaultValue: 'Username' })}</dt>
        <dd>{me.user.username}</dd>
        <dt>{t('account.displayName', { defaultValue: 'Display name' })}</dt>
        <dd>{me.user.displayName}</dd>
        <dt>{t('account.role', { defaultValue: 'Role' })}</dt>
        <dd>{me.user.role}</dd>
        <dt>{t('account.status', { defaultValue: 'Status' })}</dt>
        <dd>{me.user.status}</dd>
        <dt>{t('account.source', { defaultValue: 'Authenticated via' })}</dt>
        <dd>{me.source}</dd>
      </dl>
    </section>
  )
}

function PasswordSection() {
  const { t } = useTranslation()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const m = useMutation({
    mutationFn: () =>
      api.post('/api/auth/change-password', { oldPassword: oldPw, newPassword: newPw }),
    onSuccess: () => {
      setOldPw('')
      setNewPw('')
      setMsg({
        kind: 'ok',
        text: t('account.passwordChanged', { defaultValue: 'Password changed.' }),
      })
    },
    onError: (e: unknown) =>
      setMsg({
        kind: 'err',
        text: e instanceof ApiError ? e.message : ((e as Error).message ?? 'failed'),
      }),
  })
  return (
    <section className="card">
      <h2>{t('account.password', { defaultValue: 'Change password' })}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="auth-form"
      >
        <label>
          {t('account.oldPassword', { defaultValue: 'Current password' })}
          <input
            type="password"
            autoComplete="current-password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            required
          />
        </label>
        <label>
          {t('account.newPassword', { defaultValue: 'New password' })}
          <input
            type="password"
            autoComplete="new-password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            required
            minLength={8}
          />
        </label>
        <button type="submit" disabled={m.isPending}>
          {m.isPending ? '…' : t('account.update', { defaultValue: 'Update' })}
        </button>
        {msg && (
          <div className={msg.kind === 'ok' ? 'auth-form__ok' : 'auth-form__error'}>{msg.text}</div>
        )}
      </form>
    </section>
  )
}

function PatSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const { data } = useQuery<
    Array<{
      id: string
      name: string
      scopes: string[]
      createdAt: number
      lastUsedAt: number | null
      revokedAt: number | null
    }>
  >({
    queryKey: ['pats'],
    queryFn: () => api.get('/api/auth/pats'),
  })
  const create = useMutation({
    mutationFn: () =>
      api.post<{ token: string }>('/api/auth/pats', {
        name,
        scopes: ['tasks:launch', 'tasks:read:own', 'agents:read'],
      }),
    onSuccess: (r) => {
      setShown(r.token)
      setName('')
      void qc.invalidateQueries({ queryKey: ['pats'] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/pats/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pats'] }),
  })
  return (
    <section className="card">
      <h2>{t('account.pats', { defaultValue: 'Personal Access Tokens' })}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
        className="auth-form"
      >
        <label>
          {t('account.patName', { defaultValue: 'Name' })}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <button type="submit" disabled={!name || create.isPending}>
          {t('account.generate', { defaultValue: 'Generate' })}
        </button>
        {shown && (
          <div className="auth-form__ok" data-testid="new-pat-secret">
            <strong>{t('account.patShownOnce', { defaultValue: 'Token (copy now):' })}</strong>
            <code>{shown}</code>
          </div>
        )}
      </form>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('account.patNameCol', { defaultValue: 'Name' })}</th>
            <th>{t('account.patScopes', { defaultValue: 'Scopes' })}</th>
            <th>{t('account.patStatus', { defaultValue: 'Status' })}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.scopes.join(', ')}</td>
              <td>{p.revokedAt ? 'revoked' : 'active'}</td>
              <td>
                {!p.revokedAt && (
                  <button onClick={() => revoke.mutate(p.id)} className="btn btn--ghost btn--xs">
                    {t('account.revoke', { defaultValue: 'Revoke' })}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function SessionsSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<Array<{ id: string; userAgent: string | null; lastUsedAt: number }>>({
    queryKey: ['sessions'],
    queryFn: () => api.get('/api/auth/sessions'),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/auth/sessions/${id}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ACTOR_QUERY_KEY })
    },
  })
  return (
    <section className="card">
      <h2>{t('account.sessions', { defaultValue: 'Sessions' })}</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('account.sessionId', { defaultValue: 'Session' })}</th>
            <th>{t('account.userAgent', { defaultValue: 'User agent' })}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((s) => (
            <tr key={s.id}>
              <td>
                <code>{s.id.slice(0, 8)}…</code>
              </td>
              <td>{s.userAgent ?? '—'}</td>
              <td>
                <button onClick={() => revoke.mutate(s.id)} className="btn btn--ghost btn--xs">
                  {t('account.revoke', { defaultValue: 'Revoke' })}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function IdentitiesSection() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data } = useQuery<
    Array<{
      id: string
      providerSlug: string
      providerDisplayName?: string
      subject: string
      email: string | null
    }>
  >({
    queryKey: ['identities'],
    queryFn: () => api.get('/api/auth/identities'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/auth/identities/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['identities'] }),
  })
  return (
    <section className="card">
      <h2>{t('account.linkedIdentities', { defaultValue: 'Linked identities' })}</h2>
      {(data ?? []).length === 0 ? (
        <p>{t('account.noIdentities', { defaultValue: 'No linked identities yet.' })}</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('account.provider', { defaultValue: 'Provider' })}</th>
              <th>{t('account.subject', { defaultValue: 'Subject' })}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.map((i) => (
              <tr key={i.id}>
                <td>{i.providerDisplayName ?? i.providerSlug}</td>
                <td>
                  <code>{i.subject}</code>
                </td>
                <td>
                  <button onClick={() => remove.mutate(i.id)} className="btn btn--ghost btn--xs">
                    {t('account.unlink', { defaultValue: 'Unlink' })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
