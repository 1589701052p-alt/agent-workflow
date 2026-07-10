// RFC-164 PR-1 — /workgroups list page. Mirrors /mcps and /workflows shape:
// header row with title + primary "New" Link, data-table, no inline editor.
// Create + edit live on separate routes (`/workgroups/new`, `/workgroups/$name`).
// Delete confirms through the shared <Dialog> (per RFC-164 proposal, instead
// of the two-click ConfirmButton the older lists use).

import { Link, createRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workgroup } from '@agent-workflow/shared'
import { useResourceList } from '@/hooks/useResourceList'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ResourceNameCell } from '@/components/ResourceNameCell'
import { workgroupLeaderDisplayName } from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups',
  component: WorkgroupsPage,
})

function WorkgroupsPage() {
  const { t } = useTranslation()
  // RFC-151 PR-3 — shared list shell: query + delete mutation + owner lookup.
  const { data, isLoading, error, del, owners } = useResourceList<Workgroup>({
    queryKey: ['workgroups'],
    endpoint: '/api/workgroups',
    deleteBy: 'name',
  })

  const [pendingDelete, setPendingDelete] = useState<Workgroup | null>(null)

  async function confirmDelete(): Promise<void> {
    if (pendingDelete === null) return
    try {
      await del.mutateAsync(pendingDelete)
    } catch {
      // Surfaced via the del.error <ErrorBanner> above the table.
    } finally {
      setPendingDelete(null)
    }
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('workgroups.title')}</h1>
        </div>
        <Link to="/workgroups/new" className="btn btn--primary">
          {t('workgroups.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="workgroups-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('workgroups.emptyList')} data-testid="workgroups-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('workgroups.colName')}</th>
              <th>{t('workgroups.colMode')}</th>
              <th>{t('workgroups.colMembers')}</th>
              <th>{t('workgroups.colLeader')}</th>
              <th>{t('workgroups.colDescription')}</th>
              <th>{t('workgroups.colUpdated')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id} data-testid={`workgroup-row-${w.name}`}>
                <ResourceNameCell
                  to="/workgroups/$name"
                  params={{ name: w.name }}
                  name={w.name}
                  visibility={w.visibility}
                  ownerUserId={w.ownerUserId}
                  owners={owners}
                />
                <td className="data-table__nowrap">
                  <span className="chip chip--tight">
                    {w.mode === 'leader_worker'
                      ? t('workgroups.modeLeaderWorker')
                      : t('workgroups.modeFreeCollab')}
                  </span>
                </td>
                <td className="data-table__nowrap">{w.members.length}</td>
                <td className="data-table__nowrap">
                  {workgroupLeaderDisplayName(w) ?? t('common.emDash')}
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={w.description || undefined}
                >
                  {w.description || t('common.emDash')}
                </td>
                <td className="data-table__nowrap data-table__muted">
                  {new Date(w.updatedAt).toLocaleString()}
                </td>
                <td className="data-table__actions">
                  <Link to="/workgroups/$name" params={{ name: w.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => setPendingDelete(w)}
                    disabled={del.isPending}
                    data-testid={`workgroup-delete-${w.name}`}
                  >
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('workgroups.deleteTitle')}
        size="sm"
        data-testid="workgroup-delete-dialog"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPendingDelete(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void confirmDelete()}
              disabled={del.isPending}
              data-testid="workgroup-delete-confirm"
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p>{t('workgroups.deleteBody', { name: pendingDelete?.name ?? '' })}</p>
      </Dialog>
    </div>
  )
}
