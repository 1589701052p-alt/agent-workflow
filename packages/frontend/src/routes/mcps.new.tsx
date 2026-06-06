// RFC-028 — /mcps/new. Matches /agents/new and /skills/new shape: page +
// page__header + McpFields + single primary action in form-actions. No
// cancel button (sidebar / browser back navigate away).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { McpFields } from '@/components/McpFields'
import { describeApiError } from '@/i18n'
import { buildCreatePayload, EMPTY_LOCAL_FORM, type McpFormState } from '@/lib/mcp-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps/new',
  component: McpCreatePage,
})

function McpCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [form, setForm] = useState<McpFormState>(EMPTY_LOCAL_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const create = useMutation({
    mutationFn: async (): Promise<Mcp> => {
      const built = buildCreatePayload(form)
      if (!built.ok) {
        setErrors(built.errors)
        // Internal validation sentinel: surfaced as inline field errors via
        // setErrors, never shown in the form-actions error banner.
        throw new Error('form-invalid')
      }
      setErrors({})
      return api.post<Mcp>('/api/mcps', built.payload)
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['mcps'] })
      navigate({ to: '/mcps/$name', params: { name: m.name } })
    },
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('mcps.newTitle')}</h1>
        <p className="page__hint">{t('mcps.newHint')}</p>
      </header>

      <McpFields value={form} onChange={setForm} errors={errors} />

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || form.name === ''}
          onClick={() => create.mutate()}
          data-testid="mcp-save-button"
        >
          {create.isPending ? t('common.creating') : t('mcps.createButton')}
        </button>
        {create.error !== null &&
          create.error !== undefined &&
          !(create.error instanceof Error && create.error.message === 'form-invalid') && (
            <span className="form-actions__error">{describeApiError(create.error)}</span>
          )}
      </div>
    </div>
  )
}
