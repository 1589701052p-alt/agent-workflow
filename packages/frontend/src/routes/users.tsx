// RFC-036 — admin users list. Hidden behind usePermission('users:read');
// non-admin actors see a NoPermissionEmpty placeholder.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/api/client'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

interface UserRow {
  id: string
  username: string
  email: string | null
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled' | 'invited'
  lastLoginAt: number | null
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/users',
  component: UsersPage,
})

function UsersPage() {
  const { t } = useTranslation()
  const allowed = usePermission('users:read')
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading, error } = useQuery<UserRow[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/api/users'),
    enabled: allowed,
  })
  const create = useMutation({
    mutationFn: (body: {
      username: string
      displayName: string
      role: 'admin' | 'user'
      password?: string
    }) => api.post('/api/users', body),
    onSuccess: () => {
      setShowCreate(false)
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })
  const disable = useMutation({
    mutationFn: (id: string) => api.delete(`/api/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  if (!allowed) {
    return (
      <div className="page">
        <h1>{t('users.title', { defaultValue: 'Users' })}</h1>
        <NoPermission />
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('users.title', { defaultValue: 'Users' })}</h1>
          <p className="page__hint">
            {t('users.hint', { defaultValue: 'Manage users — only admins land here.' })}
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setShowCreate(true)}>
          {t('users.new', { defaultValue: 'New user' })}
        </button>
      </header>
      {isLoading && <div>Loading…</div>}
      {error && <div className="auth-form__error">{(error as Error).message}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('users.username', { defaultValue: 'Username' })}</th>
            <th>{t('users.displayName', { defaultValue: 'Display name' })}</th>
            <th>{t('users.role', { defaultValue: 'Role' })}</th>
            <th>{t('users.status', { defaultValue: 'Status' })}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                <code>{u.username}</code>
              </td>
              <td>{u.displayName}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td>
                {u.id !== '__system__' && u.status === 'active' && (
                  <button
                    className="btn btn--ghost btn--xs btn--danger"
                    onClick={() => disable.mutate(u.id)}
                  >
                    {t('users.disable', { defaultValue: 'Disable' })}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showCreate && (
        <CreateUserDialog
          onCancel={() => setShowCreate(false)}
          onSubmit={(b) => create.mutate(b)}
          busy={create.isPending}
          error={create.error instanceof ApiError ? create.error.message : null}
        />
      )}
    </div>
  )
}

function CreateUserDialog(props: {
  onCancel: () => void
  onSubmit: (b: {
    username: string
    displayName: string
    role: 'admin' | 'user'
    password?: string
  }) => void
  busy: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const [password, setPassword] = useState('')
  return (
    <div className="dialog__overlay" role="dialog" aria-modal="true">
      <div className="dialog">
        <h2>{t('users.create.title', { defaultValue: 'New user' })}</h2>
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault()
            const body: Parameters<typeof props.onSubmit>[0] = { username, displayName, role }
            if (password) body.password = password
            props.onSubmit(body)
          }}
        >
          <label>
            {t('users.username', { defaultValue: 'Username' })}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              pattern="[a-z0-9][a-z0-9_-]{0,63}"
              required
            />
          </label>
          <label>
            {t('users.displayName', { defaultValue: 'Display name' })}
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
          <label>
            {t('users.role', { defaultValue: 'Role' })}
            <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label>
            {t('users.password', {
              defaultValue: 'Password (leave blank for invite-only)',
            })}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
            />
          </label>
          {props.error && <div className="auth-form__error">{props.error}</div>}
          <div className="dialog__actions">
            <button type="button" onClick={props.onCancel}>
              {t('users.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button type="submit" className="btn btn--primary" disabled={props.busy}>
              {t('users.create.submit', { defaultValue: 'Create' })}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function NoPermission() {
  const { t } = useTranslation()
  return (
    <div className="empty-state" data-testid="no-permission">
      <h2>{t('users.noPermission.title', { defaultValue: 'Admin permission required' })}</h2>
      <p>
        {t('users.noPermission.body', {
          defaultValue: 'This page is only available to administrators.',
        })}
      </p>
    </div>
  )
}
