// RFC-028 — /mcps list + inline create/edit page.
//
// One route for v1: the list and a slide-down editor share state so users can
// jump between rows without a route change. Two transports (local stdio,
// remote http/sse) share most of the form; the `type` radio switches the
// body region between command/env and url/headers/oauth.
//
// Notable design rules locked here (see OPENCODE_CONFIG.md):
//   - No `cwd` field for local. opencode has none — stdio child cwd = worktree.
//   - env / headers values are *not* logged anywhere; the spawn log only
//     records mcp names.
//   - OAuth UX (browser redirect) is NOT done in this page. Users run
//     `opencode mcp auth <name>` once on the host; tokens live under
//     ~/.opencode/auth/ and every opencode subprocess re-uses them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { buildCreatePayload, EMPTY_LOCAL_FORM, kvToLines, type McpFormState } from '@/lib/mcp-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps',
  component: McpsPage,
})

function McpsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const list = useQuery<Mcp[]>({
    queryKey: ['mcps'],
    queryFn: ({ signal }) => api.get('/api/mcps', undefined, signal),
  })

  const [editing, setEditing] = useState<Mcp | 'new' | null>(null)

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcps'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('mcps.title')}</h1>
          <p className="page__hint">{t('mcps.hint')}</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setEditing('new')}
          data-testid="mcps-new-button"
        >
          {t('mcps.newButton')}
        </button>
      </header>

      {list.isLoading && <div className="muted">{t('common.loading')}</div>}
      {list.error !== null && list.error !== undefined && <ErrorBanner error={list.error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!list.isLoading && list.data !== undefined && list.data.length === 0 && (
        <div className="muted">{t('mcps.emptyList')}</div>
      )}

      {list.data !== undefined && list.data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('mcps.colName')}</th>
              <th>{t('mcps.colType')}</th>
              <th>{t('mcps.colDescription')}</th>
              <th>{t('mcps.colEnabled')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((m) => (
              <tr key={m.id}>
                <td className="data-table__nowrap">
                  <button type="button" className="data-table__link" onClick={() => setEditing(m)}>
                    {m.name}
                  </button>
                </td>
                <td>
                  <span className="chip chip--tight">
                    {m.type === 'local' ? t('mcps.typeLocal') : t('mcps.typeRemote')}
                  </span>
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={m.description || undefined}
                >
                  {m.description || t('common.emDash')}
                </td>
                <td>{m.enabled ? t('common.yes') : t('common.no')}</td>
                <td className="data-table__actions">
                  <button type="button" className="btn btn--sm" onClick={() => setEditing(m)}>
                    {t('common.open')}
                  </button>
                  <ConfirmButton
                    label={t('mcps.deleteButton')}
                    onConfirm={() => del.mutateAsync(m.name)}
                    danger
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing !== null && (
        <McpEditor
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['mcps'] })
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

interface McpEditorProps {
  existing: Mcp | null
  onClose: () => void
  onSaved: () => void
}

function McpEditor({ existing, onClose, onSaved }: McpEditorProps) {
  const { t } = useTranslation()
  const initial = useMemo<McpFormState>(() => {
    if (existing === null) return EMPTY_LOCAL_FORM
    if (existing.type === 'local') {
      return {
        name: existing.name,
        description: existing.description,
        type: 'local',
        enabled: existing.enabled,
        command: existing.config.command.join(' '),
        envText: kvToLines(existing.config.env),
        url: '',
        headersText: '',
        oauthMode: 'auto',
        timeoutMsText: existing.config.timeoutMs?.toString() ?? '',
      }
    }
    return {
      name: existing.name,
      description: existing.description,
      type: 'remote',
      enabled: existing.enabled,
      command: '',
      envText: '',
      url: existing.config.url,
      headersText: kvToLines(existing.config.headers),
      oauthMode: existing.config.oauth === false ? 'disabled' : 'auto',
      timeoutMsText: existing.config.timeoutMs?.toString() ?? '',
    }
  }, [existing])
  const [form, setForm] = useState<McpFormState>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const isEdit = existing !== null
  const save = useMutation({
    mutationFn: async () => {
      const built = buildCreatePayload(form)
      if (!built.ok) {
        setErrors(built.errors)
        throw new Error('form-invalid')
      }
      setErrors({})
      if (isEdit && existing) {
        // PUT cannot change name; rename takes a separate endpoint that we
        // intentionally don't expose here for v1 (name changes ripple into
        // every consuming agent — UI for that comes later).
        const { name: _name, ...patch } = built.payload
        return api.put<Mcp>(`/api/mcps/${encodeURIComponent(existing.name)}`, patch)
      }
      return api.post<Mcp>('/api/mcps', built.payload)
    },
    onSuccess: onSaved,
  })

  const set = <K extends keyof McpFormState>(k: K, v: McpFormState[K]): void => {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  return (
    <div className="mcp-editor" data-testid="mcp-editor">
      <header className="mcp-editor__header">
        <h2>
          {isEdit ? t('mcps.formEditTitle', { name: existing?.name ?? '' }) : t('mcps.formTitle')}
        </h2>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          {t('mcps.cancelButton')}
        </button>
      </header>
      <p className="form-hint">{t('mcps.toolNamingHint')}</p>

      <div className="form-grid">
        <label className="form-row">
          <span className="form-row__label">{t('mcps.fieldName')}</span>
          <input
            className="form-input"
            value={form.name}
            disabled={isEdit}
            onChange={(e) => set('name', e.target.value)}
            placeholder="postgres-prod"
            data-testid="mcp-field-name"
          />
          <span className="form-hint">{t('mcps.fieldNameHint')}</span>
          {errors.name && <span className="form-error">{errors.name}</span>}
        </label>

        <label className="form-row">
          <span className="form-row__label">{t('mcps.fieldDescription')}</span>
          <input
            className="form-input"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>

        <label className="form-row">
          <span className="form-row__label">{t('mcps.fieldType')}</span>
          <div role="radiogroup" aria-label={t('mcps.fieldType')} className="chip-row">
            <label className="chip">
              <input
                type="radio"
                checked={form.type === 'local'}
                disabled={isEdit}
                onChange={() => set('type', 'local')}
              />
              {t('mcps.typeLocal')}
            </label>
            <label className="chip">
              <input
                type="radio"
                checked={form.type === 'remote'}
                disabled={isEdit}
                onChange={() => set('type', 'remote')}
              />
              {t('mcps.typeRemote')}
            </label>
          </div>
        </label>

        <label className="form-row">
          <span className="form-row__label">{t('mcps.fieldEnabled')}</span>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <span className="form-hint">{t('mcps.fieldEnabledHint')}</span>
        </label>

        {form.type === 'local' && (
          <>
            <label className="form-row">
              <span className="form-row__label">{t('mcps.fieldCommand')}</span>
              <input
                className="form-input"
                value={form.command}
                onChange={(e) => set('command', e.target.value)}
                placeholder="uvx postgres-mcp"
                data-testid="mcp-field-command"
              />
              <span className="form-hint">{t('mcps.fieldCommandHint')}</span>
              {errors.command && <span className="form-error">{errors.command}</span>}
            </label>
            <label className="form-row">
              <span className="form-row__label">{t('mcps.fieldEnv')}</span>
              <textarea
                className="form-input form-input--textarea"
                rows={4}
                value={form.envText}
                onChange={(e) => set('envText', e.target.value)}
                placeholder={'PG_URL=postgresql://localhost/x\nLOG_LEVEL=info'}
              />
              <span className="form-hint">{t('mcps.fieldEnvHint')}</span>
            </label>
            <p className="form-hint mcp-editor__cwd-hint">{t('mcps.cwdHint')}</p>
          </>
        )}

        {form.type === 'remote' && (
          <>
            <label className="form-row">
              <span className="form-row__label">{t('mcps.fieldUrl')}</span>
              <input
                className="form-input"
                value={form.url}
                onChange={(e) => set('url', e.target.value)}
                placeholder="https://mcp.example.com/sse"
                data-testid="mcp-field-url"
              />
              <span className="form-hint">{t('mcps.fieldUrlHint')}</span>
              {errors.url && <span className="form-error">{errors.url}</span>}
            </label>
            <label className="form-row">
              <span className="form-row__label">{t('mcps.fieldHeaders')}</span>
              <textarea
                className="form-input form-input--textarea"
                rows={3}
                value={form.headersText}
                onChange={(e) => set('headersText', e.target.value)}
                placeholder={'Authorization=Bearer xxx\nX-Trace-Id=abc'}
              />
              <span className="form-hint">{t('mcps.fieldHeadersHint')}</span>
            </label>
            <label className="form-row">
              <span className="form-row__label">{t('mcps.fieldOauth')}</span>
              <div role="radiogroup" aria-label={t('mcps.fieldOauth')} className="chip-row">
                <label className="chip">
                  <input
                    type="radio"
                    checked={form.oauthMode === 'auto'}
                    onChange={() => set('oauthMode', 'auto')}
                  />
                  auto
                </label>
                <label className="chip">
                  <input
                    type="radio"
                    checked={form.oauthMode === 'disabled'}
                    onChange={() => set('oauthMode', 'disabled')}
                  />
                  false
                </label>
              </div>
              <span className="form-hint">{t('mcps.fieldOauthHint')}</span>
            </label>
            <p className="form-hint">{t('mcps.oauthCliHint')}</p>
          </>
        )}

        <label className="form-row">
          <span className="form-row__label">{t('mcps.fieldTimeoutMs')}</span>
          <input
            className="form-input"
            value={form.timeoutMsText}
            onChange={(e) => set('timeoutMsText', e.target.value)}
            inputMode="numeric"
            placeholder="30000"
          />
          {errors.timeoutMs && <span className="form-error">{errors.timeoutMs}</span>}
        </label>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          data-testid="mcp-save-button"
        >
          {save.isPending ? t('common.saving') : t('mcps.saveButton')}
        </button>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          {t('mcps.cancelButton')}
        </button>
        {save.error !== null && save.error !== undefined && (
          <span className="form-actions__error">{describeError(save.error)}</span>
        )}
      </div>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
