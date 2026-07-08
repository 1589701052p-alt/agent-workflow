// RFC-028 — /mcps/$name. Matches /agents/$name shape: title row with Save +
// Delete buttons, McpFields body. Name + type are locked once persisted —
// MCP type cannot change in place (backend rejects with mcp-type-immutable).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateMcp, Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { describeApiError } from '@/i18n'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { LoadingState } from '@/components/LoadingState'
import { McpFields } from '@/components/McpFields'
import { McpInventoryPanel } from '@/components/mcps/McpInventoryPanel'
import { buildCreatePayload, EMPTY_LOCAL_FORM, mcpToForm } from '@/lib/mcp-form'
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
  const [errors, setErrors] = useState<Record<string, string>>({})

  const query = useQuery<Mcp>({
    queryKey: ['mcps', name],
    queryFn: ({ signal }) => api.get(`/api/mcps/${encodeURIComponent(name)}`, undefined, signal),
  })

  // RFC-151 PR-4 — hydrate-once draft (see useDraftFromQuery's stale-race
  // contract: save.onSuccess below eagerly setQueryData's the fresh row).
  const { draft: form, setDraft: setForm, loaded } = useDraftFromQuery(query.data, mcpToForm)

  const save = useMutation({
    mutationFn: (payload: CreateMcp): Promise<Mcp> => {
      // Strip `name` — PUT cannot change it; rename has its own endpoint.
      const { name: _drop, ...patch } = payload
      return api.put<Mcp>(`/api/mcps/${encodeURIComponent(name)}`, patch)
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      qc.setQueryData(['mcps', name], m)
      navigate({ to: '/mcps' })
    },
  })

  // RFC-151 PR-1 — validate before mutate; an invalid form sets inline field
  // errors only (previously a thrown validation sentinel leaked into the
  // form-actions banner as a raw untranslated string). The save button is
  // disabled until `loaded`, so the draft is always seeded here.
  function submitSave() {
    if (form === undefined) return
    const built = buildCreatePayload(form)
    if (!built.ok) {
      setErrors(built.errors)
      save.reset()
      return
    }
    setErrors({})
    save.mutate(built.payload)
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      navigate({ to: '/mcps' })
    },
  })

  if (query.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeApiError(query.error)}</div>

  return (
    <div className="page">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/mcps/${encodeURIComponent(name)}`,
          invalidateKey: ['mcps'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: submitSave,
          disabled: save.isPending || !loaded,
          testid: 'mcp-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        errors={[save.error, del.error]}
      >
        <div>
          <h1>{name}</h1>
        </div>
      </DetailHeaderActions>

      {/* RFC-030 — primary view: interface inventory (tools + inputSchema +
        resources + prompts + capabilities). Sits ABOVE the edit form because
        the most common visit reason from /mcps "查看完整接口" is "what does
        this MCP expose?", not "let me edit the config." */}
      <McpInventoryPanel mcpName={name} />

      <McpFields value={form ?? EMPTY_LOCAL_FORM} onChange={setForm} nameLocked errors={errors} />
    </div>
  )
}
