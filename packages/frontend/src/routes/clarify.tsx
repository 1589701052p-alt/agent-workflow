// /clarify — RFC-023 PR-C T22.
//
// Global Clarify inbox. Three-way segmented filter (awaiting / answered / all),
// grouped by task. Each row links to /clarify/$nodeRunId for the detail
// page. Polling every 10s mirrors the Reviews inbox so the badge count and
// the list stay rough-time-in-sync without a WS dep here.
//
// Layout mirrors /reviews: same `.page__hint`, accessible `.tabs` tab bar,
// per-task `.reviews-group` section with a `.data-table` body and a
// per-row "Open" button + status chip. The two inbox pages stay visually
// uniform so users don't context-switch between them.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyInboxEntry, ClarifySessionStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/clarify',
  component: ClarifyListPage,
})

const FILTERS: ReadonlyArray<'awaiting' | 'answered' | 'all'> = ['awaiting', 'answered', 'all']
type FilterKey = (typeof FILTERS)[number]

function filterToStatus(f: FilterKey): ClarifySessionStatus | 'all' {
  if (f === 'awaiting') return 'awaiting_human'
  if (f === 'answered') return 'answered'
  return 'all'
}

/** RFC-056: render one inbox row branching on kind. Self-clarify keeps the
 *  RFC-023 row shape verbatim (chips, source agent arrow, shard key);
 *  cross-clarify renders the questioner → designer relationship with the
 *  same visual chrome. The `kind` chip differentiates them on the left.
 *
 *  Older payloads (before the backend started tagging) lack the `kind`
 *  discriminator entirely; we treat those as self for back-compat. */
function renderRow(entry: ClarifyInboxEntry, t: (key: string) => string): React.ReactElement {
  const kind: 'self' | 'cross' = entry.kind ?? 'self'
  const kindChipLabel =
    kind === 'cross' ? t('clarify.list.chip.cross') : t('clarify.list.chip.self')
  // Both chips use the same neutral chip class; text label + per-row
  // data-kind attr give the visual + DOM differentiation.
  const kindChipClass = 'chip chip--tight'

  if (kind === 'self') {
    // Alias the narrowed entry back to `s` so the existing source-text
    // regression tests (which assert literal `s.status === 'awaiting_human'`)
    // still match.
    const s = entry as Extract<ClarifyInboxEntry, { kind: 'self' }>
    const clarifyTitle =
      typeof s.clarifyNodeTitle === 'string' && s.clarifyNodeTitle.length > 0
        ? s.clarifyNodeTitle
        : null
    const sourceTitle =
      typeof s.sourceAgentNodeTitle === 'string' && s.sourceAgentNodeTitle.length > 0
        ? s.sourceAgentNodeTitle
        : null
    const hasClarifyTitle = clarifyTitle !== null && clarifyTitle !== s.clarifyNodeId
    return (
      <tr key={s.id} data-status={s.status} data-kind="self" data-testid={`clarify-row-${s.id}`}>
        <td>
          <span className={kindChipClass} data-testid={`clarify-row-kind-${s.id}`}>
            {kindChipLabel}
          </span>{' '}
          {hasClarifyTitle ? (
            <>
              <div className="reviews-row__title">{clarifyTitle}</div>
              <code className="chip chip--tight reviews-row__nodeid">{s.clarifyNodeId}</code>
            </>
          ) : (
            <code className="chip chip--tight">{s.clarifyNodeId}</code>
          )}
          <code className="chip chip--tight reviews-row__nodeid">
            ← {sourceTitle ?? s.sourceAgentNodeId}
            {s.sourceShardKey !== null && (
              <span data-testid="clarify-row-shard"> · {s.sourceShardKey}</span>
            )}
          </code>
        </td>
        <td>
          <span
            className={`status-chip status-chip--${
              s.status === 'awaiting_human' ? 'amber' : 'green'
            }`}
          >
            {s.status === 'awaiting_human'
              ? t('clarify.list.statusAwaiting')
              : t('clarify.list.statusAnswered')}
          </span>
        </td>
        <td>{s.iterationIndex}</td>
        <td>{s.questionCount}</td>
        <td className="muted">{new Date(s.createdAt).toLocaleString()}</td>
        <td>
          <Link
            to="/clarify/$nodeRunId"
            params={{ nodeRunId: s.clarifyNodeRunId }}
            className="btn btn--sm"
          >
            {t('clarify.list.openButton')}
          </Link>
        </td>
      </tr>
    )
  }
  // RFC-056 cross-clarify row.
  const cross = entry as Extract<ClarifyInboxEntry, { kind: 'cross' }>
  return (
    <tr
      key={cross.id}
      data-status={cross.status}
      data-kind="cross"
      data-testid={`clarify-row-${cross.id}`}
    >
      <td>
        <span className={kindChipClass} data-testid={`clarify-row-kind-${cross.id}`}>
          {kindChipLabel}
        </span>{' '}
        <code className="chip chip--tight">{cross.crossClarifyNodeId}</code>
        <code className="chip chip--tight reviews-row__nodeid">
          ← {cross.sourceQuestionerNodeId}
          {cross.targetDesignerNodeId !== null && (
            <span data-testid="clarify-row-designer"> → {cross.targetDesignerNodeId}</span>
          )}
        </code>
      </td>
      <td>
        <span
          className={`status-chip status-chip--${
            cross.status === 'awaiting_human'
              ? 'amber'
              : cross.status === 'abandoned'
                ? 'red'
                : 'green'
          }`}
        >
          {cross.status === 'awaiting_human'
            ? t('clarify.list.statusAwaiting')
            : cross.status === 'abandoned'
              ? t('crossClarify.abandonedChip')
              : t('clarify.list.statusAnswered')}
        </span>
      </td>
      <td>{cross.iteration}</td>
      <td>{cross.questionCount}</td>
      <td className="muted">{new Date(cross.createdAt).toLocaleString()}</td>
      <td>
        <Link
          to="/clarify/$nodeRunId"
          params={{ nodeRunId: cross.crossClarifyNodeRunId }}
          className="btn btn--sm"
        >
          {t('clarify.list.openButton')}
        </Link>
      </td>
    </tr>
  )
}

export function ClarifyListPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<FilterKey>('awaiting')

  const list = useQuery<ClarifyInboxEntry[]>({
    queryKey: ['clarify', 'list', filter],
    queryFn: ({ signal }) => {
      const q = new URLSearchParams()
      q.set('status', filterToStatus(filter))
      return api.get<ClarifyInboxEntry[]>(`/api/clarify?${q.toString()}`, undefined, signal)
    },
    refetchInterval: 10000,
  })

  // Group rows by task for a section-by-task layout.
  const groups = new Map<string, ClarifyInboxEntry[]>()
  for (const r of list.data ?? []) {
    const g = groups.get(r.taskId)
    if (g === undefined) groups.set(r.taskId, [r])
    else g.push(r)
  }

  return (
    <div className="page" data-testid="clarify-list-page">
      <header className="page__header">
        <h1>{t('clarify.list.title')}</h1>
        <p className="page__hint">{t('clarify.list.hint')}</p>
      </header>
      <div className="tabs" role="tablist">
        {FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            className={`tabs__tab ${filter === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setFilter(k)}
            data-testid={`clarify-filter-${k}`}
          >
            {t(`clarify.list.filter.${k}`)}
          </button>
        ))}
      </div>
      {list.isLoading && <div className="muted">{t('common.loading')}</div>}
      {list.error !== null && list.error !== undefined && (
        <div className="error-box">{(list.error as Error).message}</div>
      )}
      {list.data !== undefined && list.data.length === 0 && (
        <div className="muted" data-testid="clarify-list-empty">
          {t('clarify.list.empty')}
        </div>
      )}
      {Array.from(groups.entries()).map(([taskId, items]) => (
        <section key={taskId} className="reviews-group" data-testid={`clarify-group-${taskId}`}>
          <h2 className="reviews-group__title">
            <Link to="/tasks/$id" params={{ id: taskId }} className="link">
              {/* RFC-037: prefer the user-supplied task name; fall back to
                  the ULID when no rows carry one. RFC-056 cross-clarify
                  summaries also expose taskName, so the union type still
                  resolves uniformly here. */}
              {items[0]?.taskName && items[0].taskName.length > 0 ? items[0].taskName : taskId}
            </Link>
            <code className="reviews-group__id muted" title={taskId}>
              {taskId.slice(-10)}
            </code>
          </h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('clarify.list.colNode')}</th>
                <th>{t('reviews.colStatus')}</th>
                <th>{t('clarify.list.colIteration')}</th>
                <th>{t('clarify.list.colQuestions')}</th>
                <th>{t('clarify.list.colTime')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>{items.map((s) => renderRow(s, t))}</tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
