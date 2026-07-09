// RFC-159 — scheduled-task detail: config + last outcome + run history + actions.
import type { ScheduledTask, TaskSummary } from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { DetailLayout } from '@/components/DetailLayout'
import { LoadingState } from '@/components/LoadingState'
import { StatusChip } from '@/components/StatusChip'
import { describeApiError } from '@/i18n'
import { scheduleSummary } from '@/lib/schedule-view'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/scheduled/$id',
  component: ScheduledDetailPage,
})

function ScheduledDetailPage() {
  const { id } = Route.useParams()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'

  const detailQ = useQuery<ScheduledTask, ApiError>({
    queryKey: ['scheduled-tasks', 'detail', id],
    queryFn: ({ signal }) =>
      api.get(`/api/scheduled-tasks/${encodeURIComponent(id)}`, undefined, signal),
    refetchInterval: 30_000,
  })
  const historyQ = useQuery<TaskSummary[]>({
    queryKey: ['scheduled-tasks', 'history', id],
    queryFn: ({ signal }) => api.get('/api/tasks', { scheduledTaskId: id }, signal),
    refetchInterval: 30_000,
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
  const toggle = useMutation<ScheduledTask, ApiError, boolean>({
    mutationFn: (enabled) => api.put(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: invalidate,
  })
  const del = useMutation<void, ApiError>({
    mutationFn: () => api.delete(`/api/scheduled-tasks/${encodeURIComponent(id)}`),
    onSuccess: () => {
      invalidate()
      void navigate({ to: '/scheduled' })
    },
  })

  if (detailQ.isLoading) return <LoadingState />
  if (detailQ.error !== null && detailQ.error !== undefined) {
    return (
      <div className="page">
        <div className="error-box">{describeApiError(detailQ.error)}</div>
      </div>
    )
  }
  const s = detailQ.data
  if (s === undefined) return null

  const main = (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{s.name}</h1>
          <p className="muted">{scheduleSummary(s.scheduleSpec, lang)}</p>
        </div>
      </header>

      <section className="page__section">
        <dl className="detail-grid">
          <dt>{t('scheduled.fieldEnabled')}</dt>
          <dd>{s.enabled ? t('scheduled.enabledYes') : t('scheduled.enabledNo')}</dd>
          <dt>{t('scheduled.colNext')}</dt>
          <dd>{s.enabled && s.nextRunAt != null ? new Date(s.nextRunAt).toLocaleString() : '—'}</dd>
          <dt>{t('scheduled.colStatus')}</dt>
          <dd>
            {s.lastStatus == null ? (
              <span className="muted">{t('scheduled.lastNever')}</span>
            ) : (
              <StatusChip kind={s.lastStatus === 'failed' ? 'danger' : 'success'}>
                {t(`scheduled.last_${s.lastStatus}`)}
              </StatusChip>
            )}
            {s.lastError != null && s.lastError !== '' && (
              <span className="muted"> — {s.lastError}</span>
            )}
          </dd>
        </dl>
        {!s.enabled && s.consecutiveFailures > 0 && (
          <div className="error-box" data-testid="scheduled-auto-disabled">
            {t('scheduled.autoDisabled')}
          </div>
        )}
      </section>

      <section className="page__section">
        <h2>{t('scheduled.runHistory')}</h2>
        {historyQ.data === undefined || historyQ.data.length === 0 ? (
          <p className="muted">{t('scheduled.noRuns')}</p>
        ) : (
          <table className="data-table" data-testid="scheduled-history">
            <tbody>
              {historyQ.data.map((task) => (
                <tr key={task.id}>
                  <td>
                    <Link to="/tasks/$id" params={{ id: task.id }}>
                      {task.name}
                    </Link>
                  </td>
                  <td>
                    <StatusChip
                      kind={
                        task.status === 'failed'
                          ? 'danger'
                          : task.status === 'done'
                            ? 'success'
                            : 'info'
                      }
                    >
                      {task.status}
                    </StatusChip>
                  </td>
                  <td>{new Date(task.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )

  const aside = (
    <div className="detail-actions">
      <button
        type="button"
        className="btn btn--sm"
        disabled={toggle.isPending}
        onClick={() => toggle.mutate(!s.enabled)}
        data-testid="scheduled-toggle"
      >
        {s.enabled ? t('scheduled.disable') : t('scheduled.enable')}
      </button>
      <ConfirmButton
        label={t('scheduled.delete')}
        confirmLabel={t('scheduled.deleteConfirm')}
        onConfirm={() => del.mutateAsync()}
        variant="danger"
        disabled={del.isPending}
        size="sm"
      />
    </div>
  )

  return <DetailLayout main={main} aside={aside} data-testid="scheduled-detail" />
}
