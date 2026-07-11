// RFC-167 T4 — /dynamic-workflow-spaces/$name detail page. Edits the space's
// description + agent pool. The pool is a set of agent NAMES; each pool member
// renders the RFC-166 AgentCapabilityCard (compact) so the author sees what the
// orchestrator will have to work with. Dangling names (agent later deleted) are
// tolerated — they show a "not found" note, matching the soft-reference model.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, DynamicWorkflowSpace } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { AgentCapabilityCard } from '@/components/agent/AgentCapabilityCard'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { Field, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { addPoolAgent, removePoolAgentAt } from '@/lib/dynamic-workflow-space-form'
import { describeApiError } from '@/i18n'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/dynamic-workflow-spaces/$name',
  component: DynamicWorkflowSpaceDetailPage,
})

interface SpaceDraft {
  description: string
  agentPool: string[]
}

function spaceToDraft(s: DynamicWorkflowSpace): SpaceDraft {
  return { description: s.description, agentPool: s.agentPool }
}

function DynamicWorkflowSpaceDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const query = useQuery<DynamicWorkflowSpace>({
    queryKey: ['dynamic-workflow-spaces', name],
    queryFn: ({ signal }) =>
      api.get(`/api/dynamic-workflow-spaces/${encodeURIComponent(name)}`, undefined, signal),
  })
  const { draft, setDraft, loaded } = useDraftFromQuery(query.data, spaceToDraft)

  // Agent roster — powers the pool autocomplete + capability-card previews.
  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  const agentByName = new Map((agentsQ.data ?? []).map((a) => [a.name, a]))

  const [addName, setAddName] = useState('')

  const save = useMutation({
    mutationFn: () => {
      if (draft === undefined) return Promise.reject(new Error('draft not loaded'))
      return api.put<DynamicWorkflowSpace>(
        `/api/dynamic-workflow-spaces/${encodeURIComponent(name)}`,
        {
          description: draft.description,
          agentPool: draft.agentPool,
        },
      )
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['dynamic-workflow-spaces'] })
      qc.setQueryData(['dynamic-workflow-spaces', name], s)
      navigate({ to: '/dynamic-workflow-spaces' })
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/dynamic-workflow-spaces/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dynamic-workflow-spaces'] })
      navigate({ to: '/dynamic-workflow-spaces' })
    },
  })

  if (query.isLoading) return <div className="page muted">{t('dynamicWorkflowSpaces.loading')}</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeApiError(query.error)}</div>

  const pool = draft?.agentPool ?? []
  function addAgent(): void {
    if (draft === undefined) return
    setDraft({ ...draft, agentPool: addPoolAgent(draft.agentPool, addName) })
    setAddName('')
  }

  return (
    <div className="page">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/dynamic-workflow-spaces/${encodeURIComponent(name)}`,
          invalidateKey: ['dynamic-workflow-spaces'],
        }}
        save={{
          label: save.isPending ? t('common.saving') : t('common.save'),
          onClick: () => save.mutate(),
          disabled: save.isPending || !loaded,
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

      <FormSection title={t('dynamicWorkflowSpaces.sectionBasics')}>
        <Field label={t('dynamicWorkflowSpaces.fieldDescription')}>
          <TextArea
            value={draft?.description ?? ''}
            onChange={(v) => draft !== undefined && setDraft({ ...draft, description: v })}
            data-testid="dwspace-description"
          />
        </Field>
      </FormSection>

      <FormSection title={t('dynamicWorkflowSpaces.sectionPool')}>
        <p className="form-field__hint">{t('dynamicWorkflowSpaces.poolHint')}</p>
        <datalist id="dwspace-agent-names">
          {(agentsQ.data ?? []).map((a) => (
            <option key={a.name} value={a.name} />
          ))}
        </datalist>
        <div className="dwspace-pool__add">
          <TextInput
            value={addName}
            onChange={setAddName}
            list="dwspace-agent-names"
            placeholder={t('dynamicWorkflowSpaces.poolAddPlaceholder')}
            data-testid="dwspace-pool-add-input"
          />
          <button
            type="button"
            className="btn btn--sm"
            onClick={addAgent}
            disabled={addName.trim().length === 0}
            data-testid="dwspace-pool-add-button"
          >
            {t('dynamicWorkflowSpaces.poolAddButton')}
          </button>
        </div>

        {pool.length === 0 ? (
          <p className="form-field__hint" data-testid="dwspace-pool-empty">
            {t('dynamicWorkflowSpaces.poolEmpty')}
          </p>
        ) : (
          <ul className="dwspace-pool__list">
            {pool.map((agentName, idx) => {
              const agent = agentByName.get(agentName)
              return (
                <li key={`${agentName}-${idx}`} className="dwspace-pool__item">
                  <div className="dwspace-pool__item-head">
                    <span className="dwspace-pool__item-name">{agentName}</span>
                    <button
                      type="button"
                      className="btn btn--xs btn--danger"
                      onClick={() =>
                        draft !== undefined &&
                        setDraft({ ...draft, agentPool: removePoolAgentAt(draft.agentPool, idx) })
                      }
                      aria-label={t('common.removeAria', { label: agentName })}
                      data-testid={`dwspace-pool-remove-${agentName}`}
                    >
                      {t('dynamicWorkflowSpaces.poolRemove')}
                    </button>
                  </div>
                  {agent !== undefined ? (
                    <AgentCapabilityCard agent={agent} compact />
                  ) : (
                    <p className="form-field__hint dwspace-pool__missing">
                      {t('dynamicWorkflowSpaces.poolAgentMissing')}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </FormSection>
    </div>
  )
}
