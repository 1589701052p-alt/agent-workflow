// RFC-031 — /plugins/$id. Matches /agents/$name and /mcps/$name shape:
// title row with Save + Delete buttons, PluginFields body. Name is locked
// once persisted — renames go through POST /api/plugins/:id/rename (no
// UI hook yet; same v1 stance as the other resources).
//
// "Upgrade" / "Check for update" buttons live on the list page, not here:
// the detail page is the *edit* surface (spec / options / description /
// enabled), upgrade is a one-shot action that the operator usually triggers
// from the table row alongside delete.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Plugin, UpdatePlugin } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { LoadingState } from '@/components/LoadingState'
import { PluginFields } from '@/components/PluginFields'
import { describeApiError } from '@/i18n'
import { buildUpdatePayload, EMPTY_PLUGIN_FORM, pluginToForm } from '@/lib/plugin-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/plugins/$id',
  component: PluginDetailPage,
})

function PluginDetailPage() {
  const { t } = useTranslation()
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [errors, setErrors] = useState<Record<string, string>>({})

  const query = useQuery<Plugin>({
    queryKey: ['plugins', id],
    queryFn: ({ signal }) => api.get(`/api/plugins/${encodeURIComponent(id)}`, undefined, signal),
  })

  // RFC-151 PR-4 — hydrate-once draft (see useDraftFromQuery's stale-race
  // contract: save.onSuccess below eagerly setQueryData's the fresh row).
  const { draft: form, setDraft: setForm, loaded } = useDraftFromQuery(query.data, pluginToForm)

  const save = useMutation({
    mutationFn: (patch: UpdatePlugin): Promise<Plugin> =>
      api.put<Plugin>(`/api/plugins/${encodeURIComponent(id)}`, patch),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      qc.setQueryData(['plugins', id], p)
      navigate({ to: '/plugins' })
    },
  })

  // RFC-151 PR-1 — validate before mutate; an invalid form sets inline field
  // errors only (previously a thrown validation sentinel leaked into the
  // form-actions banner as a raw untranslated string). The save button is
  // disabled until `loaded`, so `query.data` and the draft are always
  // present here.
  function submitSave() {
    if (query.data === undefined || form === undefined) return
    const built = buildUpdatePayload(form, query.data)
    if (!built.ok) {
      setErrors(built.errors)
      save.reset()
      return
    }
    setErrors({})
    save.mutate(built.payload)
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/plugins/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plugins'] })
      navigate({ to: '/plugins' })
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

  const displayName = query.data?.name ?? id

  return (
    <div className="page">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/plugins/${encodeURIComponent(id)}`,
          invalidateKey: ['plugins'],
        }}
        save={{
          label: save.isPending ? t('plugins.saving') : t('plugins.saveButton'),
          onClick: submitSave,
          disabled: save.isPending || !loaded,
          testid: 'plugin-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        errors={[save.error, del.error]}
      >
        <div>
          <h1>{displayName}</h1>
          <p className="page__hint">{t('plugins.detailHint')}</p>
        </div>
      </DetailHeaderActions>

      <PluginFields
        value={form ?? EMPTY_PLUGIN_FORM}
        onChange={setForm}
        nameLocked
        errors={errors}
      />
    </div>
  )
}
