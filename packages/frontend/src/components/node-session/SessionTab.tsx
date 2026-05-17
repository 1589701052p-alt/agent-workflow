// RFC-027: the new first tab inside NodeDetailDrawer. Replaces the
// PromptTab as the default view while keeping PromptTab around as a
// safety fallback (see RFC-027 plan T5). Reuses RFC-011's attempts
// switcher so retries / fan-out / clarify iteration history stays
// reachable from the Session view.

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  isFanoutParentRun,
  isPromptCapableKind,
  sortNodeRunsForPromptHistory,
} from '@/lib/node-prompt'
import { displayNoderunStatusKey } from '@/lib/noderun-status'
import { ConversationFlow } from './ConversationFlow'
import { RuntimeInventorySection } from '@/components/inventory/RuntimeInventorySection'

interface Props {
  taskId: string
  runs: NodeRun[]
  nodeId: string | null
  selectedRunId: string
  workflowNodeKind: string | null
}

export function SessionTab({ taskId, runs, nodeId, selectedRunId, workflowNodeKind }: Props) {
  const { t } = useTranslation()

  const attempts = useMemo(
    () =>
      nodeId === null ? [] : sortNodeRunsForPromptHistory(runs.filter((r) => r.nodeId === nodeId)),
    [runs, nodeId],
  )

  const [pickedId, setPickedId] = useState<string>(selectedRunId)
  useEffect(() => {
    setPickedId(selectedRunId)
  }, [selectedRunId])

  if (!isPromptCapableKind(workflowNodeKind)) {
    return <div className="muted">{t('nodeDrawer.sessionNotApplicable')}</div>
  }
  if (attempts.length === 0) {
    return <div className="muted">{t('nodeDrawer.sessionPending')}</div>
  }

  const picked = attempts.find((a) => a.id === pickedId) ?? attempts[attempts.length - 1]!
  const fanoutParent = isFanoutParentRun(picked, attempts)

  return (
    <div className="session-history">
      <AttemptPicker
        attempts={attempts}
        pickedId={picked.id}
        onPick={setPickedId}
        isFanoutParent={(a) => isFanoutParentRun(a, attempts)}
      />
      {fanoutParent ? (
        <div className="muted">{t('nodeDrawer.sessionFanoutParent')}</div>
      ) : (
        <>
          {/* RFC-029: runtime inventory section sits between the attempts
              switcher and the conversation flow so users can confirm "what
              opencode actually loaded" before scanning the dialog. */}
          <RuntimeInventorySection
            taskId={taskId}
            nodeRunId={picked.id}
            workflowNodeKind={workflowNodeKind}
          />
          <SessionBody taskId={taskId} nodeRunId={picked.id} />
        </>
      )}
    </div>
  )
}

/**
 * Chip-row picker replacing the ugly native <select> RFC-027 originally
 * inherited from RFC-011's PromptTab. Each attempt is a button with its
 * iteration / retry / clarify label + a status chip + a timestamp; the
 * active attempt gets a solid accent background. Renders as a single
 * horizontally-scrollable row when there are many attempts.
 *
 * ARIA: radiogroup + radio buttons so screen readers + tests can
 * interact via roles instead of relying on a combobox.
 */
function AttemptPicker({
  attempts,
  pickedId,
  onPick,
  isFanoutParent,
}: {
  attempts: NodeRun[]
  pickedId: string
  onPick: (id: string) => void
  isFanoutParent: (a: NodeRun) => boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="session-attempts">
      <span className="session-attempts__label">{t('nodeDrawer.promptAttemptLabel')}</span>
      <div
        role="radiogroup"
        aria-label={t('nodeDrawer.promptAttemptLabel')}
        className="session-attempts__group"
      >
        {attempts.map((a) => {
          const active = a.id === pickedId
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onPick(a.id)}
              className={`session-attempts__item ${active ? 'is-active' : ''}`}
              title={attemptTooltip(a, t, isFanoutParent(a))}
            >
              <span className={`session-attempts__dot status-dot--${toneFor(a.status)}`} />
              <span className="session-attempts__iter">{iterLabel(a, t)}</span>
              {a.shardKey !== null && a.shardKey !== '' && (
                <span className="session-attempts__shard">{a.shardKey}</span>
              )}
              {isFanoutParent(a) && <span className="session-attempts__parent">parent</span>}
              {a.startedAt !== null && (
                <span className="session-attempts__time">
                  {new Date(a.startedAt).toLocaleTimeString()}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function iterLabel(a: NodeRun, t: TFunction): string {
  if (a.clarifyIteration > 0) return t('nodeDrawer.iterClarify', { n: a.clarifyIteration })
  if (a.reviewIteration > 0) return t('nodeDrawer.iterReview', { n: a.reviewIteration })
  if (a.iteration > 0) return t('nodeDrawer.iterLoop', { n: a.iteration })
  if (a.retryIndex > 0) return t('nodeDrawer.iterRetry', { n: a.retryIndex })
  return t('nodeDrawer.iterInitial')
}

function attemptTooltip(a: NodeRun, t: TFunction, fanoutParent: boolean): string {
  const parts: string[] = [iterLabel(a, t), t(displayNoderunStatusKey(a))]
  if (a.shardKey !== null && a.shardKey !== '') parts.push(`shard=${a.shardKey}`)
  if (fanoutParent) parts.push('fan-out parent')
  if (a.startedAt !== null) parts.push(new Date(a.startedAt).toLocaleString())
  return parts.join(' · ')
}

function toneFor(status: NodeRun['status']): string {
  switch (status) {
    case 'done':
      return 'green'
    case 'running':
      return 'blue'
    case 'failed':
    case 'exhausted':
      return 'red'
    case 'awaiting_review':
    case 'awaiting_human':
      return 'amber'
    default:
      return 'gray'
  }
}

function SessionBody({ taskId, nodeRunId }: { taskId: string; nodeRunId: string }) {
  const { t } = useTranslation()
  const query = useQuery<SessionViewResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'session'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/session`,
        undefined,
        signal,
      ),
  })
  if (query.isLoading) return <div className="muted">{t('common.loading')}</div>
  if (query.error !== null && query.error !== undefined) {
    return <div className="error-box">{t('session.loadError')}</div>
  }
  if (query.data === undefined) return null
  return <ConversationFlow tree={query.data.tree} />
}
