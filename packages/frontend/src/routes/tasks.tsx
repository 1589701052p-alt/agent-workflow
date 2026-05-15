// Tasks list page — status filter chips + table linking into the detail page.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { TaskStatus, TaskSummary } from '@agent-workflow/shared'
import { TASK_STATUS } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { useTasksSync } from '@/hooks/useTasksSync'
import { Route as RootRoute } from './__root'

interface TasksSearch {
  status?: TaskStatus
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks',
  component: TasksPage,
  validateSearch: (raw: Record<string, unknown>): TasksSearch => {
    const status = raw.status
    if (typeof status === 'string' && (TASK_STATUS as readonly string[]).includes(status)) {
      return { status: status as TaskStatus }
    }
    return {}
  },
})

function TasksPage() {
  const { t } = useTranslation()
  const search = Route.useSearch() as TasksSearch
  const status = search.status

  useTasksSync()
  const { data, isLoading, error } = useQuery<TaskSummary[]>({
    queryKey: ['tasks', { status }],
    queryFn: ({ signal }) =>
      api.get('/api/tasks', status === undefined ? undefined : { status }, signal),
    refetchInterval: 15_000, // Fallback for cases where WS is unavailable.
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('tasks.title')}</h1>
          <p className="page__hint">{t('tasks.hint')}</p>
        </div>
      </header>

      <div className="status-filter">
        <Link
          to="/tasks"
          search={{}}
          className={`chip ${status === undefined ? 'chip--active' : ''}`}
        >
          {t('tasks.filterAll')}
        </Link>
        {TASK_STATUS.map((s) => (
          <Link
            key={s}
            to="/tasks"
            search={{ status: s }}
            className={`chip ${status === s ? 'chip--active' : ''}`}
          >
            {s}
          </Link>
        ))}
      </div>

      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">{t('tasks.emptyList')}</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('tasks.colId')}</th>
              <th>{t('tasks.colStatus')}</th>
              <th>{t('tasks.colStarted')}</th>
              <th>{t('tasks.colRepo')}</th>
              <th>{t('tasks.colError')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link
                    to="/tasks/$id"
                    params={{ id: row.id }}
                    className="data-table__link data-table__id"
                  >
                    <code>{row.id.slice(-10)}</code>
                  </Link>
                </td>
                <td>
                  <TaskStatusChip status={row.status} />
                </td>
                <td className="data-table__muted">
                  <RelativeTime ts={row.startedAt} />
                </td>
                <td className="data-table__muted">
                  <code>{row.repoPath}</code>
                </td>
                <td className="data-table__muted">{row.errorSummary ?? t('common.emDash')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useTranslation()
  let msg = t('common.unknownError')
  if (error instanceof ApiError) msg = `${error.code}: ${error.message}`
  else if (error instanceof Error) msg = error.message
  return <div className="error-box">⚠ {msg}</div>
}

function RelativeTime({ ts }: { ts: number }) {
  const { t } = useTranslation()
  return <span>{formatRelative(ts, t)}</span>
}

export function formatRelative(ts: number, t: TFunction): string {
  const diff = Date.now() - ts
  const s = Math.round(diff / 1000)
  if (s < 60) return t('tasks.secondsAgo', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('tasks.minutesAgo', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('tasks.hoursAgo', { n: h })
  return new Date(ts).toLocaleDateString()
}
