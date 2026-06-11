// RFC-099 — shared multi-select user picker (launcher collaborators, ACL
// member lists, task members panel). RFC-036 planned this component but the
// UI never shipped; this is the canonical implementation.
//
// Search hits GET /api/users/search (users:search — available to every
// logged-in user, public fields only) with a 200 ms debounce; results render
// in a plain list below the field; selected users render as removable chips
// (same .chip primitives as ChipsInput).

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'

interface UserPickerProps {
  value: UserPublic[]
  onChange: (next: UserPublic[]) => void
  /** Hide these ids from results (e.g. the resource owner). */
  excludeIds?: string[]
  disabled?: boolean
  placeholder?: string
  /** Single-select mode (owner transfer): picking replaces the selection. */
  single?: boolean
  testidPrefix?: string
}

export function UserPicker({
  value,
  onChange,
  excludeIds,
  disabled,
  placeholder,
  single,
  testidPrefix,
}: UserPickerProps) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input.trim()), 200)
    return () => clearTimeout(handle)
  }, [input])

  // Close the result list on outside click.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  const search = useQuery<UserPublic[]>({
    queryKey: ['users', 'search', debounced],
    queryFn: ({ signal }) =>
      api.get('/api/users/search', { q: debounced || undefined, limit: 20 }, signal),
    enabled: open && !disabled,
    staleTime: 30_000,
  })

  const selectedIds = new Set(value.map((u) => u.id))
  const hidden = new Set(excludeIds ?? [])
  const results = (search.data ?? []).filter((u) => !selectedIds.has(u.id) && !hidden.has(u.id))

  function add(user: UserPublic) {
    onChange(single ? [user] : [...value, user])
    setInput('')
    if (single) setOpen(false)
  }

  function remove(id: string) {
    onChange(value.filter((u) => u.id !== id))
  }

  return (
    <div className="user-picker" ref={rootRef}>
      <div className="chips-input__row">
        {value.map((u) => (
          <span key={u.id} className="chip">
            {u.displayName}
            <button
              type="button"
              className="chip__remove"
              aria-label={t('userPicker.remove', { name: u.displayName })}
              disabled={disabled}
              data-testid={testidPrefix ? `${testidPrefix}-remove-${u.username}` : undefined}
              onClick={() => remove(u.id)}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="chips-input__field"
          value={input}
          placeholder={placeholder ?? t('userPicker.placeholder')}
          disabled={disabled}
          data-testid={testidPrefix ? `${testidPrefix}-input` : undefined}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
        />
      </div>
      {open && !disabled && (
        <ul className="user-picker__results" role="listbox">
          {results.length === 0 ? (
            <li className="user-picker__empty">
              {search.isLoading ? t('common.loading') : t('userPicker.noResults')}
            </li>
          ) : (
            results.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="user-picker__option"
                  data-testid={testidPrefix ? `${testidPrefix}-option-${u.username}` : undefined}
                  onClick={() => add(u)}
                >
                  <span className="user-picker__name">{u.displayName}</span>
                  <span className="user-picker__username">@{u.username}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
