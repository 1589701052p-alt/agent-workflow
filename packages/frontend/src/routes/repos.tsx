// RFC-024 — Cached repos management page. Lists every persistent mirror the
// daemon has built for a `repoUrl`, surfaces last-fetched age + referencing
// task count, and exposes Refresh + Delete buttons. Delete on a row with
// references is confirmed via a modal that forwards `?force=1`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CachedRepo, ListCachedReposResponse } from '@agent-workflow/shared'
import { redactGitUrl } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Route as RootRoute } from './__root'

export const ReposRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/repos',
  component: ReposPage,
})

function ReposPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery<ListCachedReposResponse>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })

  const refresh = useMutation({
    mutationFn: (id: string) => api.post(`/api/cached-repos/${encodeURIComponent(id)}/refresh`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })
  const remove = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      api.delete(`/api/cached-repos/${encodeURIComponent(id)}${force ? '?force=1' : ''}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cached-repos'] }),
  })

  const [pendingDelete, setPendingDelete] = useState<CachedRepo | null>(null)

  const items = list.data?.items ?? []

  return (
    <div className="page repos-page">
      <header className="page__header">
        <h1>{t('repos.title')}</h1>
        <p className="page__hint">{t('repos.hint')}</p>
      </header>

      {list.isLoading && <div className="muted">{t('repos.loading')}</div>}
      {list.error !== null && list.error !== undefined && (
        <div className="error-box">{describeError(list.error)}</div>
      )}
      {!list.isLoading && items.length === 0 && (
        <div className="repos-empty">{t('repos.empty')}</div>
      )}

      {items.length > 0 && (
        <table className="repos-table" data-testid="repos-table">
          <thead>
            <tr>
              <th>{t('repos.colUrl')}</th>
              <th>{t('repos.colLocalPath')}</th>
              <th>{t('repos.colLastFetched')}</th>
              <th>{t('repos.colRefs')}</th>
              <th>{t('repos.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} data-testid={`repos-row-${item.id}`}>
                <td className="repos-table__url">{item.urlRedacted}</td>
                <td className="repos-table__url">{item.localPath}</td>
                <td>
                  <time dateTime={item.lastFetchedAt}>{formatTimestamp(item.lastFetchedAt)}</time>
                </td>
                <td>{item.referencingTaskCount}</td>
                <td>
                  <div className="repos-table__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={refresh.isPending}
                      onClick={() => refresh.mutate(item.id)}
                    >
                      {t('repos.refresh')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      onClick={() =>
                        item.referencingTaskCount > 0
                          ? setPendingDelete(item)
                          : remove.mutate({ id: item.id })
                      }
                    >
                      {t('repos.delete')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {refresh.error !== null && refresh.error !== undefined && (
        <div className="error-box">{describeError(refresh.error)}</div>
      )}
      {remove.error !== null && remove.error !== undefined && (
        <div className="error-box">{describeError(remove.error)}</div>
      )}

      {pendingDelete !== null && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          data-testid="repos-delete-confirm"
        >
          <div className="modal">
            <h2>{t('repos.deleteConfirmTitle')}</h2>
            <p>
              {t('repos.deleteConfirmBody', {
                url: redactGitUrl(pendingDelete.url),
                count: pendingDelete.referencingTaskCount,
              })}
            </p>
            <div className="modal__actions">
              <button type="button" className="btn btn--sm" onClick={() => setPendingDelete(null)}>
                {t('repos.cancel')}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                data-testid="repos-delete-confirm-action"
                onClick={() => {
                  remove.mutate({ id: pendingDelete.id, force: true })
                  setPendingDelete(null)
                }}
              >
                {t('repos.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
