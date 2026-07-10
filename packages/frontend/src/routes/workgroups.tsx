// RFC-164 PR-1 — /workgroups list page. Mirrors /mcps and /workflows shape:
// header row with title + primary "New" button, data-table, no inline editor.
// Creation is a QUICK-CREATE dialog (name + description only — everything
// else has backend defaults); members/config are managed on the detail page.
// Delete confirms through the shared <Dialog> (per RFC-164 proposal, instead
// of the two-click ConfirmButton the older lists use).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workgroup } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { ResourceNameCell } from '@/components/ResourceNameCell'
import {
  buildQuickCreatePayload,
  workgroupLeaderDisplayName,
  type QuickCreateWorkgroupBody,
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups',
  component: WorkgroupsPage,
})

function WorkgroupsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
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

  // Quick create — name + description only; navigate to the detail page
  // (where members and the rest of the config are managed) on success.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const createTriggerRef = useRef<HTMLButtonElement | null>(null)
  const create = useMutation({
    mutationFn: (body: QuickCreateWorkgroupBody): Promise<Workgroup> =>
      api.post<Workgroup>('/api/workgroups', body),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      setCreateOpen(false)
      navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })
  const builtCreate = buildQuickCreatePayload({
    name: createName,
    description: createDescription,
  })

  function openCreate(): void {
    setCreateName('')
    setCreateDescription('')
    create.reset()
    setCreateOpen(true)
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('workgroups.title')}</h1>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          ref={createTriggerRef}
          onClick={openCreate}
          data-testid="workgroup-new-button"
        >
          {t('workgroups.newButton')}
        </button>
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

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('workgroups.newTitle')}
        size="sm"
        triggerRef={createTriggerRef}
        data-testid="workgroup-create-dialog"
        footer={
          <>
            {create.error !== null && create.error !== undefined && (
              <span className="form-actions__error">{describeApiError(create.error)}</span>
            )}
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={create.isPending || !builtCreate.ok}
              onClick={() => {
                if (builtCreate.ok) create.mutate(builtCreate.payload)
              }}
              data-testid="workgroup-create-confirm"
            >
              {create.isPending ? t('common.creating') : t('workgroups.createButton')}
            </button>
          </>
        }
      >
        <Field
          label={t('workgroups.fieldName')}
          required
          hint={t('workgroups.fieldNameHint')}
          // Required-ness is conveyed by the disabled Create button; only a
          // malformed (non-empty) name earns an inline error.
          error={
            createName !== '' && !builtCreate.ok && builtCreate.errors.name !== undefined
              ? t(builtCreate.errors.name)
              : undefined
          }
        >
          <TextInput
            value={createName}
            onChange={setCreateName}
            maxLength={128}
            data-testid="workgroup-create-name"
          />
        </Field>
        <Field label={t('workgroups.fieldDescription')}>
          <TextInput
            value={createDescription}
            onChange={setCreateDescription}
            maxLength={4096}
            data-testid="workgroup-create-description"
          />
        </Field>
      </Dialog>
    </div>
  )
}
