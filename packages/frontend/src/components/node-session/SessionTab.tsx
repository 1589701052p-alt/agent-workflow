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
  const groups = useMemo(() => groupAttemptsByInlineSession(attempts), [attempts])
  return (
    <div className="session-attempts">
      <span className="session-attempts__label">{t('nodeDrawer.promptAttemptLabel')}</span>
      <div
        role="radiogroup"
        aria-label={t('nodeDrawer.promptAttemptLabel')}
        className="session-attempts__group"
      >
        {groups.map((g) => {
          // Inline groups bundle N attempts under one chip; clicking it
          // hands the LATEST attempt's id to the parent so the backend
          // /session route can unify all rounds via opencodeSessionId.
          const latest = g.attempts[g.attempts.length - 1]!
          const active = g.attempts.some((a) => a.id === pickedId)
          const inline = g.attempts.length > 1
          return (
            <button
              key={inline ? `inline:${g.sessionId}` : latest.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onPick(latest.id)}
              className={`session-attempts__item ${active ? 'is-active' : ''} ${inline ? 'is-inline' : ''}`}
              title={
                inline
                  ? `inline · ${g.attempts.length} rounds`
                  : attemptTooltip(latest, t, isFanoutParent(latest))
              }
            >
              <span className={`session-attempts__dot status-dot--${toneFor(latest.status)}`} />
              <span className="session-attempts__iter">
                {inline
                  ? t('nodeDrawer.inlineRoundsLabel', {
                      n: g.attempts.length,
                      defaultValue: 'inline · {{n}} rounds',
                    })
                  : iterLabel(latest, t)}
              </span>
              {!inline && latest.shardKey !== null && latest.shardKey !== '' && (
                <span className="session-attempts__shard">{latest.shardKey}</span>
              )}
              {!inline && isFanoutParent(latest) && (
                <span className="session-attempts__parent">parent</span>
              )}
              {latest.startedAt !== null && (
                <span className="session-attempts__time">
                  {new Date(latest.startedAt).toLocaleTimeString()}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface AttemptGroup {
  /** opencode session id when grouped; for legacy/isolated attempts uses the run id as a unique placeholder. */
  sessionId: string
  attempts: NodeRun[]
}

/**
 * Walk attempts (already sorted by sortNodeRunsForPromptHistory) and
 * fuse consecutive entries that share a non-null opencodeSessionId
 * into one chip. Legacy attempts (opencodeSessionId === null) stay as
 * 1-attempt groups so the picker behaves like the pre-merge version
 * for non-inline workflows.
 *
 * Exported for direct unit testing.
 */
export function groupAttemptsByInlineSession(attempts: NodeRun[]): AttemptGroup[] {
  const out: AttemptGroup[] = []
  for (const a of attempts) {
    const sid = a.opencodeSessionId
    if (sid !== null && sid !== '') {
      const last = out[out.length - 1]
      if (last !== undefined && last.sessionId === sid) {
        last.attempts.push(a)
        continue
      }
      out.push({ sessionId: sid, attempts: [a] })
    } else {
      // Singleton — use the run id as the bucket key so duplicate
      // legacy attempts never collide.
      out.push({ sessionId: a.id, attempts: [a] })
    }
  }
  return out
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
