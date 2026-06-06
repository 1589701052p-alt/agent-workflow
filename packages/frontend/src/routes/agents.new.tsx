// Agent create page. POST /api/agents → redirect to detail.
//
// RFC-002: on mount, snapshot the current Runtime defaults from /api/config
// into the draft *once*. Subsequent Settings changes (in another tab, via WS,
// etc.) do not overwrite the in-progress draft — once the snapshot has fired,
// applyDefaults never runs again, and even within the snapshot it only fills
// fields that the user hasn't touched.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Config, CreateAgent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AgentForm, emptyAgent } from '@/components/AgentForm'
import { AgentImportDialog } from '@/components/AgentImportDialog'
import { describeApiError } from '@/i18n'
import { mergeAgentImport } from '@/lib/agent-import-merge'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents/new',
  component: AgentCreatePage,
})

/**
 * Copy Runtime defaults from `cfg` onto `draft` for fields the user hasn't
 * touched yet (i.e. still `undefined`). Pure, exported for unit tests.
 */
export function applyDefaults(draft: CreateAgent, cfg: Config): CreateAgent {
  const next: CreateAgent = { ...draft }
  if (draft.model === undefined && cfg.defaultModel) next.model = cfg.defaultModel
  if (draft.variant === undefined && cfg.defaultVariant) next.variant = cfg.defaultVariant
  if (draft.temperature === undefined && cfg.defaultTemperature !== undefined)
    next.temperature = cfg.defaultTemperature
  if (draft.steps === undefined && cfg.defaultSteps !== undefined) next.steps = cfg.defaultSteps
  if (draft.maxSteps === undefined && cfg.defaultMaxSteps !== undefined)
    next.maxSteps = cfg.defaultMaxSteps
  return next
}

function AgentCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(emptyAgent)
  const [importOpen, setImportOpen] = useState(false)

  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const snapshottedRef = useRef(false)
  useEffect(() => {
    if (snapshottedRef.current) return
    if (!config.data) return
    snapshottedRef.current = true
    setDraft((prev) => applyDefaults(prev, config.data as Config))
  }, [config.data])

  const create = useMutation({
    mutationFn: () => api.post<Agent>('/api/agents', draft),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] })
      navigate({ to: '/agents' })
    },
  })

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('agents.newTitle')}</h1>
        <p className="page__hint">{t('agents.newHint')}</p>
      </header>
      <div className="agent-new-toolbar">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="agent-import-open"
          onClick={() => setImportOpen(true)}
        >
          {t('agentForm.importButton')}
        </button>
      </div>
      <AgentForm value={draft} onChange={setDraft} />
      <AgentImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        currentValue={draft}
        onApply={(res) => setDraft((prev) => mergeAgentImport(prev, res))}
      />
      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={create.isPending || draft.name === ''}
          onClick={() => create.mutate()}
        >
          {create.isPending ? t('common.creating') : t('agents.createButton')}
        </button>
        {create.error !== null && create.error !== undefined && (
          <span className="form-actions__error">{describeApiError(create.error)}</span>
        )}
      </div>
    </div>
  )
}
