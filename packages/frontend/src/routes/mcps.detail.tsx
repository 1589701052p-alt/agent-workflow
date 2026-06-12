// RFC-028 — /mcps/$name. Matches /agents/$name shape: title row with Save +
// Delete buttons, McpFields body. Name + type are locked once persisted —
// MCP type cannot change in place (backend rejects with mcp-type-immutable).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AclDialogButton } from '@/components/AclPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { describeApiError } from '@/i18n'
import { McpFields } from '@/components/McpFields'
import { McpInventoryPanel } from '@/components/mcps/McpInventoryPanel'
import { buildCreatePayload, EMPTY_LOCAL_FORM, mcpToForm, type McpFormState } from '@/lib/mcp-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps/$name',
  component: McpDetailPage,
})

function McpDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [loaded, setLoaded] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const query = useQuery<Mcp>({
    queryKey: ['mcps', name],
    queryFn: ({ signal }) => api.get(`/api/mcps/${encodeURIComponent(name)}`, undefined, signal),
  })

  useEffect(() => {
    if (!loaded && query.data !== undefined) {
      setForm(mcpToForm(query.data))
      setLoaded(true)
    }
  }, [loaded, query.data])

  const save = useMutation({
    mutationFn: async (): Promise<Mcp> => {
      const built = buildCreatePayload(form)
      if (!built.ok) {
        setErrors(built.errors)
        throw new Error('form-invalid')
      }
      setErrors({})
      // Strip `name` — PUT cannot change it; rename has its own endpoint.
      const { name: _drop, ...patch } = built.payload
      return api.put<Mcp>(`/api/mcps/${encodeURIComponent(name)}`, patch)
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      qc.setQueryData(['mcps', name], m)
      navigate({ to: '/mcps' })
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      navigate({ to: '/mcps' })
    },
  })

  if (query.isLoading) return <div className="page muted">{t('common.loading')}</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeApiError(query.error)}</div>

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{name}</h1>
          <p className="page__hint">{t('mcps.detailHint')}</p>
        </div>
        <div className="page__actions">
          <AclDialogButton
            resourceBaseUrl={`/api/mcps/${encodeURIComponent(name)}`}
            invalidateKey={['mcps']}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || !loaded}
            onClick={() => save.mutate()}
            data-testid="mcp-save-button"
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </button>
          <ConfirmButton
            label={t('common.delete')}
            onConfirm={() => del.mutateAsync()}
            danger
            disabled={del.isPending}
          />
        </div>
      </header>

      {(save.error !== null && save.error !== undefined) ||
      (del.error !== null && del.error !== undefined) ? (
        <div className="form-actions">
          {save.error !== null && save.error !== undefined && (
            <span className="form-actions__error">{describeApiError(save.error)}</span>
          )}
          {del.error !== null && del.error !== undefined && (
            <span className="form-actions__error">{describeApiError(del.error)}</span>
          )}
        </div>
      ) : null}

      {/* RFC-030 — primary view: interface inventory (tools + inputSchema +
        resources + prompts + capabilities). Sits ABOVE the edit form because
        the most common visit reason from /mcps "查看完整接口" is "what does
        this MCP expose?", not "let me edit the config." */}
      <McpInventoryPanel mcpName={name} />

      <McpFields value={form} onChange={setForm} nameLocked errors={errors} />
    </div>
  )
}
