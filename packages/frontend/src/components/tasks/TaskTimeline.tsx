// RFC-W002 - task「评论区」interaction timeline. Read-only chronological feed
// aggregating human input / node outputs / clarify Q&A / review decisions for
// one task. Pure display: data comes from GET /api/tasks/:id/interaction-feed
// (the pure `buildInteractionFeed` in @agent-workflow/shared). Live-updates via
// useTaskSync's WS invalidation of the ['task-timeline', taskId] query key.
//
// Reuses public primitives only (Card / EmptyState / LoadingState / ErrorBanner
// / Prose markdown renderer) - no bespoke chrome, per CLAUDE.md Frontend UI
// consistency. Jumps are delegated to the parent via `onJump` so this component
// stays free of routing / tab-state concerns (and stays unit-testable).

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  InteractionFeedResult,
  InteractionItem,
  InteractionJumpTarget,
  InteractionKind,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Prose } from '@/components/prose/Prose'

export interface TaskTimelineProps {
  taskId: string
  /** Parent handles session/clarify/review jumps (tab switch vs route nav). */
  onJump: (target: InteractionJumpTarget) => void
}

type Filter = 'all' | 'human_input' | 'node_output' | 'clarify' | 'review'

const FILTERS: readonly Filter[] = ['all', 'human_input', 'node_output', 'clarify', 'review']

function matchesFilter(kind: InteractionKind, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'clarify') return kind === 'clarify_question' || kind === 'clarify_answer'
  if (f === 'review') return kind === 'review_decision'
  return kind === f
}

function filterLabel(t: (key: string) => string, f: Filter): string {
  switch (f) {
    case 'all':
      return t('taskTimeline.filterAll')
    case 'human_input':
      return t('taskTimeline.filterHumanInput')
    case 'node_output':
      return t('taskTimeline.filterNodeOutput')
    case 'clarify':
      return t('taskTimeline.filterClarify')
    case 'review':
      return t('taskTimeline.filterReview')
  }
}

function kindLabel(t: (key: string) => string, kind: InteractionKind): string {
  switch (kind) {
    case 'human_input':
      return t('taskTimeline.kindHumanInput')
    case 'node_output':
      return t('taskTimeline.kindNodeOutput')
    case 'clarify_question':
      return t('taskTimeline.kindClarifyQuestion')
    case 'clarify_answer':
      return t('taskTimeline.kindClarifyAnswer')
    case 'review_decision':
      return t('taskTimeline.kindReviewDecision')
  }
}

export function TaskTimeline({ taskId, onJump }: TaskTimelineProps): ReactElement {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<Filter>('all')

  const query = useQuery<InteractionFeedResult>({
    queryKey: ['task-timeline', taskId],
    queryFn: ({ signal }) =>
      api.get<InteractionFeedResult>(
        `/api/tasks/${encodeURIComponent(taskId)}/interaction-feed`,
        undefined,
        signal,
      ),
  })

  const items = useMemo(() => {
    const all = query.data?.items ?? []
    return all.filter((i) => matchesFilter(i.kind, filter))
  }, [query.data, filter])

  return (
    <section className="task-timeline" data-testid="task-timeline">
      <header className="task-timeline__header">
        <h2 className="task-timeline__title">{t('taskTimeline.title')}</h2>
        <div className="task-timeline__filters" role="group" aria-label={t('taskTimeline.title')}>
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f}
              className={`btn btn--sm${filter === f ? ' btn--primary' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              data-testid={`task-timeline-filter-${f}`}
            >
              {filterLabel(t, f)}
            </button>
          ))}
        </div>
      </header>

      {query.isLoading ? (
        <LoadingState size="compact" />
      ) : query.error !== null && query.error !== undefined ? (
        <ErrorBanner error={query.error} />
      ) : items.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('taskTimeline.empty')}
          data-testid="task-timeline-empty"
        />
      ) : (
        <>
          {query.data?.truncated === true && (
            <div className="info-box info-box--muted" data-testid="task-timeline-truncated">
              {t('taskTimeline.truncated', { n: query.data?.items.length ?? 0 })}
            </div>
          )}
          <ul className="task-timeline__list" data-testid="task-timeline-list">
            {items.map((item) => (
              <TimelineCard key={item.id} item={item} onJump={onJump} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function TimelineCard({
  item,
  onJump,
}: {
  item: InteractionItem
  onJump: (target: InteractionJumpTarget) => void
}): ReactElement {
  const { t } = useTranslation()
  // Sanitize the id for the testid - item ids contain ':' which testing-library's
  // exact testid match treats as a CSS pseudo-class boundary if unescaped.
  const testId = item.id.replace(/:/g, '-')
  return (
    <li className="task-timeline__item" data-testid={`task-timeline-item-${testId}`}>
      <Card
        header={<CardHeader item={item} />}
        footer={
          item.jumpTarget ? <JumpFooter item={item} onJump={onJump} testId={testId} /> : undefined
        }
      >
        <CardBody item={item} />
      </Card>
    </li>
  )
}

function CardHeader({ item }: { item: InteractionItem }): ReactElement {
  const { t } = useTranslation()
  const actor =
    item.kind === 'human_input' || item.kind === 'clarify_answer'
      ? t('taskTimeline.actorHuman')
      : (item.nodeName ?? item.nodeId ?? '')
  return (
    <div className="task-timeline__card-header">
      <span className="task-timeline__kind">{kindLabel(t, item.kind)}</span>
      {actor.length > 0 && <span className="task-timeline__actor">{actor}</span>}
      <time className="task-timeline__time muted" dateTime={new Date(item.ts).toISOString()}>
        {new Date(item.ts).toLocaleString()}
      </time>
    </div>
  )
}

function JumpFooter({
  item,
  onJump,
  testId,
}: {
  item: InteractionItem
  onJump: (target: InteractionJumpTarget) => void
  testId: string
}): ReactElement {
  const { t } = useTranslation()
  const target = item.jumpTarget!
  const label =
    target.kind === 'session'
      ? t('taskTimeline.jumpSession')
      : target.kind === 'clarify'
        ? t('taskTimeline.jumpClarify')
        : t('taskTimeline.jumpReview')
  return (
    <button
      type="button"
      className="btn btn--sm btn--primary"
      onClick={() => onJump(target)}
      data-testid={`task-timeline-jump-${testId}`}
    >
      {label}
    </button>
  )
}

function CardBody({ item }: { item: InteractionItem }): ReactElement {
  const { t } = useTranslation()
  switch (item.kind) {
    case 'human_input':
      return <HumanInputBody inputs={item.inputs ?? {}} />
    case 'node_output':
      return <NodeOutputBody outputs={item.outputs ?? []} />
    case 'clarify_question':
      return <ClarifyQuestionBody questions={item.questions ?? []} />
    case 'clarify_answer':
      return (
        <ClarifyAnswerBody
          questions={item.questions ?? []}
          answers={item.answers ?? []}
          unansweredHint={t('taskTimeline.unansweredHint')}
        />
      )
    case 'review_decision':
      return <ReviewBody review={item.review} noReason={t('taskTimeline.noReason')} />
  }
}

function HumanInputBody({ inputs }: { inputs: Record<string, string> }): ReactElement {
  const entries = Object.entries(inputs)
  if (entries.length === 0) return <span className="muted">—</span>
  return (
    <dl className="task-timeline__inputs">
      {entries.map(([k, v]) => (
        <div key={k} className="task-timeline__input-row">
          <dt className="task-timeline__input-key muted">{k}</dt>
          <dd className="task-timeline__input-val">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function NodeOutputBody({
  outputs,
}: {
  outputs: Array<{ portName: string; content: string; kind: string | null }>
}): ReactElement {
  return (
    <div className="task-timeline__outputs">
      {outputs.map((o) => (
        <div key={o.portName} className="task-timeline__output-port">
          <h4 className="task-timeline__port-name muted">{o.portName}</h4>
          <Prose body={o.content} />
        </div>
      ))}
    </div>
  )
}

function ClarifyQuestionBody({
  questions,
}: {
  questions: Array<{
    id: string
    title: string
    kind: string
    options: Array<{ label: string; description: string; recommended: boolean }>
  }>
}): ReactElement {
  return (
    <ol className="task-timeline__questions">
      {questions.map((q, idx) => (
        <li key={q.id} className="task-timeline__question">
          <div className="task-timeline__question-title">
            Q{idx + 1}: {q.title}
          </div>
          <ul className="task-timeline__options">
            {q.options.map((opt, i) => (
              <li key={i} className="task-timeline__option">
                <span className="task-timeline__option-label">
                  {opt.label}
                  {opt.recommended && (
                    <span className="task-timeline__rec-badge" data-testid={`rec-${q.id}-${i}`}>
                      ★
                    </span>
                  )}
                </span>
                {opt.description.length > 0 && (
                  <span className="task-timeline__option-desc muted"> — {opt.description}</span>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  )
}

function ClarifyAnswerBody({
  questions,
  answers,
  unansweredHint,
}: {
  questions: Array<{ id: string; title: string }>
  answers: Array<{ questionId: string; selectedOptionLabels: string[]; customText: string }>
  unansweredHint: string
}): ReactElement {
  const byId = new Map(answers.map((a) => [a.questionId, a]))
  return (
    <ol className="task-timeline__answers">
      {questions.map((q, idx) => {
        const a = byId.get(q.id)
        const labels = a?.selectedOptionLabels ?? []
        const custom = (a?.customText ?? '').trim()
        return (
          <li key={q.id} className="task-timeline__answer">
            <div className="task-timeline__question-title">
              Q{idx + 1}: {q.title}
            </div>
            {a === undefined ? (
              <div className="task-timeline__answer-text muted">{unansweredHint}</div>
            ) : labels.length === 0 && custom.length === 0 ? (
              <div className="task-timeline__answer-text muted">{unansweredHint}</div>
            ) : (
              <div className="task-timeline__answer-text">
                {labels.length > 0 && (
                  <span className="task-timeline__answer-labels">{labels.join(' / ')}</span>
                )}
                {custom.length > 0 && (
                  <span className="task-timeline__answer-custom"> — {custom}</span>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function ReviewBody({
  review,
  noReason,
}: {
  review:
    | {
        decision: string
        reason: string | null
        comments: Array<{ selectedText: string | null; commentText: string; author: string | null }>
      }
    | undefined
  noReason: string
}): ReactElement {
  if (review === undefined) return <span className="muted">—</span>
  return (
    <div className="task-timeline__review">
      <div className="task-timeline__review-reason">
        {review.reason !== null && review.reason.length > 0 ? (
          <Prose body={review.reason} />
        ) : (
          <span className="muted">{noReason}</span>
        )}
      </div>
      {review.comments.length > 0 && (
        <ul className="task-timeline__review-comments">
          {review.comments.map((c, i) => (
            <li key={i} className="task-timeline__review-comment">
              {c.selectedText !== null && c.selectedText.length > 0 && (
                <blockquote className="task-timeline__review-quote">{c.selectedText}</blockquote>
              )}
              <div className="task-timeline__review-comment-text">{c.commentText}</div>
              {c.author !== null && (
                <div className="task-timeline__review-author muted">— {c.author}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
