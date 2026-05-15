// /reviews — RFC-005 PR-D T26.
//
// Global Reviews inbox. Lists pending review items + has filter chips to
// switch between pending / all / approved / rejected / iterated views.
// Grouping is by task (per RFC Q&A D3); within a task, items keep their
// natural order coming back from the backend (which orders by node id
// stability + version recency).

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/reviews',
  component: ReviewsListPage,
})

const FILTERS = ['pending', 'all', 'approved', 'rejected', 'iterated'] as const
type Filter = (typeof FILTERS)[number]

function ReviewsListPage() {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<Filter>('pending')
  const list = useQuery<ReviewSummary[]>({
    queryKey: ['reviews', 'list', filter],
    queryFn: ({ signal }) => api.get(`/api/reviews?status=${filter}`, undefined, signal),
    refetchInterval: 10000,
  })

  // Group by task.
  const groups = new Map<string, { name: string; items: ReviewSummary[] }>()
  for (const r of list.data ?? []) {
    const g = groups.get(r.taskId)
    if (g === undefined) {
      groups.set(r.taskId, { name: r.workflowName, items: [r] })
    } else {
      g.items.push(r)
    }
  }

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('reviews.title')}</h1>
        <p className="page__hint">{t('reviews.hint')}</p>
      </header>
      <div className="tabs">
        {FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            className={`tabs__tab ${filter === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setFilter(k)}
          >
            {t(`reviews.filter${k.charAt(0).toUpperCase()}${k.slice(1)}` as const)}
          </button>
        ))}
      </div>
      {list.isLoading && <div className="muted">{t('common.loading')}</div>}
      {list.error !== null && list.error !== undefined && (
        <div className="error-box">{(list.error as Error).message}</div>
      )}
      {list.data !== undefined && list.data.length === 0 && (
        <div className="muted">{t('reviews.emptyList')}</div>
      )}
      {Array.from(groups.entries()).map(([taskId, g]) => (
        <section key={taskId} className="reviews-group">
          <h2 className="reviews-group__title">
            <Link to="/tasks/$id" params={{ id: taskId }} className="link">
              {g.name}
            </Link>
            <code className="muted reviews-group__taskid"> · {taskId}</code>
          </h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('reviews.colNode')}</th>
                <th>{t('reviews.colStatus')}</th>
                <th>{t('reviews.colVersion')}</th>
                <th>{t('reviews.colCreated')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {g.items.map((r) => {
                const hasTitle = r.title !== '' && r.title !== r.reviewNodeId
                return (
                  <tr key={r.nodeRunId}>
                    <td>
                      {hasTitle ? (
                        <>
                          <div className="reviews-row__title">{r.title}</div>
                          <code className="muted reviews-row__nodeid">{r.reviewNodeId}</code>
                        </>
                      ) : (
                        <code>{r.reviewNodeId}</code>
                      )}
                      {r.description !== '' && (
                        <div className="muted reviews-row__desc">{r.description}</div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`status-chip status-chip--${
                          r.awaitingReview
                            ? 'amber'
                            : r.decision === 'approved'
                              ? 'green'
                              : r.decision === 'rejected'
                                ? 'red'
                                : r.decision === 'iterated'
                                  ? 'blue'
                                  : 'gray'
                        }`}
                      >
                        {r.awaitingReview ? t('reviews.statusAwaiting') : r.decision}
                      </span>
                    </td>
                    <td>v{r.currentVersionIndex}</td>
                    <td className="muted">{formatTimestamp(r.createdAt)}</td>
                    <td>
                      <Link
                        to="/reviews/$nodeRunId"
                        params={{ nodeRunId: r.nodeRunId }}
                        className="btn btn--sm"
                      >
                        {t('reviews.openButton')}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString()
}
