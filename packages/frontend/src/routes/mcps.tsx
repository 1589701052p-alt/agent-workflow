// RFC-028 — /mcps list page. Mirrors /agents and /skills shape exactly:
// header row with title + primary "New" Link, table, no inline editor. The
// create + edit pages are separate routes (`/mcps/new`, `/mcps/$name`).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/mcps',
  component: McpsPage,
})

function McpsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Mcp[]>({
    queryKey: ['mcps'],
    queryFn: ({ signal }) => api.get('/api/mcps', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/mcps/${encodeURIComponent(name)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcps'] }),
  })

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('mcps.title')}</h1>
          <p className="page__hint">{t('mcps.hint')}</p>
        </div>
        <Link to="/mcps/new" className="btn btn--primary">
          {t('mcps.newButton')}
        </Link>
      </header>

      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">{t('mcps.emptyList')}</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('mcps.colName')}</th>
              <th>{t('mcps.colType')}</th>
              <th>{t('mcps.colDescription')}</th>
              <th>{t('mcps.colEnabled')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((m) => (
              <tr key={m.id}>
                <td className="data-table__nowrap">
                  <Link to="/mcps/$name" params={{ name: m.name }} className="data-table__link">
                    {m.name}
                  </Link>
                </td>
                <td className="data-table__nowrap">
                  <span className="chip chip--tight">
                    {m.type === 'local' ? t('mcps.typeLocal') : t('mcps.typeRemote')}
                  </span>
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={m.description || undefined}
                >
                  {m.description || t('common.emDash')}
                </td>
                <td>{m.enabled ? t('common.yes') : t('common.no')}</td>
                <td className="data-table__actions">
                  <Link to="/mcps/$name" params={{ name: m.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('mcps.deleteButton')}
                    onConfirm={() => del.mutateAsync(m.name)}
                    danger
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
