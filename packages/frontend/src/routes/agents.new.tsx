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
 * Pre-select the configured default runtime on a fresh draft (if the user
 * hasn't picked one yet). RFC-113: model/variant/temperature/steps live on the
 * RUNTIME now, not the agent — so the only Runtime default an agent draft seeds
 * is which runtime it points at. Pure, exported for unit tests.
 */
export function applyDefaults(draft: CreateAgent, cfg: Config): CreateAgent {
  const next: CreateAgent = { ...draft }
  if (draft.runtime === undefined && cfg.defaultRuntime) next.runtime = cfg.defaultRuntime
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
