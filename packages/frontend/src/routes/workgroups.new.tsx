// RFC-164 PR-1 — /workgroups/new. Matches /mcps/new shape: page +
// page__header + shared <WorkgroupForm> + single primary action in
// form-actions. Validation runs live: an invalid draft disables Create and
// shows inline field errors (RFC-164 acceptance: 违规禁用保存 + 行内错误提示).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateWorkgroup, Workgroup } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'
import { describeApiError } from '@/i18n'
import {
  buildCreateWorkgroupPayload,
  newWorkgroupForm,
  type WorkgroupFormState,
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/new',
  component: WorkgroupCreatePage,
})

function WorkgroupCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<WorkgroupFormState>(newWorkgroupForm)

  const create = useMutation({
    mutationFn: (payload: CreateWorkgroup): Promise<Workgroup> =>
      api.post<Workgroup>('/api/workgroups', payload),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })

  // Live pre-validation: the builder runs on every render; while invalid the
  // primary action is disabled and the field errors render inline, so the
  // mutation never sees an invalid payload (409/422 from the API are real
  // conflicts and surface in the form-actions banner below).
  const built = buildCreateWorkgroupPayload(form)

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('workgroups.newTitle')}</h1>
      </header>

      <WorkgroupForm value={form} onChange={setForm} errors={built.ok ? {} : built.errors} />

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || !built.ok}
          onClick={() => {
            if (built.ok) create.mutate(built.payload)
          }}
          data-testid="workgroup-save-button"
        >
          {create.isPending ? t('common.creating') : t('workgroups.createButton')}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeApiError(create.error)}</span>
        )}
      </div>
    </div>
  )
}
