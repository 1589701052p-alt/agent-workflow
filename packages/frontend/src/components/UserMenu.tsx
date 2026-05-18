// RFC-036 — sidebar footer user dropdown. Admin sees 4 items
// (account / users / settings / logout); regular user sees 2 (account / logout).

import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { useActor, usePermission } from '@/hooks/useActor'
import { clearToken } from '@/stores/auth'

export function UserMenu() {
  const { data, isLoading } = useActor()
  const { t } = useTranslation()
  const isAdmin = usePermission('users:read')
  const canSettings = usePermission('settings:read')
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function logout() {
    try {
      await api.post('/api/auth/logout', {})
    } catch {
      /* ignore */
    }
    clearToken()
    setOpen(false)
    navigate({ to: '/auth' })
  }

  if (isLoading || !data) return null

  return (
    <div className="user-menu" ref={ref}>
      <button
        className="user-menu__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="user-menu__avatar" aria-hidden>
          {(data.user.displayName ?? data.user.username).slice(0, 1).toUpperCase()}
        </span>
        <span className="user-menu__name">{data.user.username}</span>
      </button>
      {open && (
        <div className="user-menu__dropdown" role="menu">
          <div className="user-menu__header">
            <strong>{data.user.displayName}</strong>
            <span className="user-menu__role">{data.user.role}</span>
          </div>
          <Link
            to="/account"
            className="user-menu__item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            {t('userMenu.account', { defaultValue: 'My account' })}
          </Link>
          {isAdmin && (
            <Link
              to="/users"
              className="user-menu__item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {t('userMenu.users', { defaultValue: 'Manage users' })}
            </Link>
          )}
          {canSettings && (
            <Link
              to="/settings"
              className="user-menu__item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {t('userMenu.settings', { defaultValue: 'Settings' })}
            </Link>
          )}
          <button className="user-menu__item user-menu__item--danger" onClick={logout}>
            {t('userMenu.logout', { defaultValue: 'Sign out' })}
          </button>
        </div>
      )}
    </div>
  )
}
