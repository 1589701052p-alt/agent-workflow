// RFC-164 PR-1 — /workgroups/$name. Matches /mcps/$name shape: shared
// <DetailHeaderActions> header (ACL + Save + Delete), shared <WorkgroupForm>
// body with the name field locked. Renames go through the header's Rename
// button + <Dialog> (POST /api/workgroups/:name/rename — PUT cannot change
// the name).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateWorkgroup, Workgroup } from '@agent-workflow/shared'
import { WORKGROUP_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { describeApiError } from '@/i18n'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'
import { buildUpdateWorkgroupPayload, workgroupToForm } from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/$name',
  component: WorkgroupDetailPage,
})

function WorkgroupDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const query = useQuery<Workgroup>({
    queryKey: ['workgroups', name],
    queryFn: ({ signal }) =>
      api.get(`/api/workgroups/${encodeURIComponent(name)}`, undefined, signal),
  })

  // RFC-151 PR-4 — hydrate-once draft (stale-race contract: save.onSuccess
  // eagerly setQueryData's the fresh row).
  const { draft: form, setDraft: setForm, loaded } = useDraftFromQuery(query.data, workgroupToForm)

  const save = useMutation({
    mutationFn: (payload: UpdateWorkgroup): Promise<Workgroup> =>
      api.put<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}`, payload),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', name], w)
      navigate({ to: '/workgroups' })
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/workgroups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      navigate({ to: '/workgroups' })
    },
  })

  // Rename dialog state. POST …/rename, then move to the new detail URL.
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const rename = useMutation({
    mutationFn: (nn: string): Promise<Workgroup> =>
      api.post<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}/rename`, { newName: nn }),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      setRenameOpen(false)
      navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })
  const renameValid = newName.length > 0 && newName.length <= 128 && WORKGROUP_NAME_RE.test(newName)

  // Live pre-validation — same contract as /workgroups/new.
  const built = form !== undefined ? buildUpdateWorkgroupPayload(form) : undefined

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
          resourceBaseUrl: `/api/workgroups/${encodeURIComponent(name)}`,
          invalidateKey: ['workgroups'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: () => {
            if (built !== undefined && built.ok) save.mutate(built.payload)
          },
          disabled: save.isPending || !loaded || built === undefined || !built.ok,
          testid: 'workgroup-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        extra={
          <button
            type="button"
            className="btn"
            ref={renameTriggerRef}
            onClick={() => {
              setNewName(name)
              setRenameOpen(true)
            }}
            data-testid="workgroup-rename-button"
          >
            {t('workgroups.renameButton')}
          </button>
        }
        errors={[save.error, del.error, rename.error]}
      >
        <div>
          <h1>{name}</h1>
        </div>
      </DetailHeaderActions>

      {form !== undefined && (
        <WorkgroupForm
          value={form}
          onChange={(next) => setForm(next)}
          nameLocked
          errors={built !== undefined && !built.ok ? built.errors : {}}
        />
      )}

      <Dialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('workgroups.renameTitle')}
        size="sm"
        triggerRef={renameTriggerRef}
        data-testid="workgroup-rename-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRenameOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={rename.isPending || !renameValid || newName === name}
              onClick={() => rename.mutate(newName)}
              data-testid="workgroup-rename-confirm"
            >
              {rename.isPending ? t('common.saving') : t('common.save')}
            </button>
          </>
        }
      >
        <Field label={t('workgroups.renameField')} required hint={t('workgroups.fieldNameHint')}>
          <TextInput
            value={newName}
            onChange={setNewName}
            pattern={WORKGROUP_NAME_RE.source}
            maxLength={128}
            data-testid="workgroup-rename-input"
          />
        </Field>
      </Dialog>
    </div>
  )
}
