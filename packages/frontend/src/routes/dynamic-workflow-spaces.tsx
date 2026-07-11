// RFC-167 T4 — /dynamic-workflow-spaces list page. Mirrors /workgroups shape:
// header + primary "New" button, data-table, quick-create dialog (name +
// description only — the agent pool is managed on the detail page). Delete
// confirms through the shared <Dialog>.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DynamicWorkflowSpace } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { ResourceNameCell } from '@/components/ResourceNameCell'
import {
  buildQuickCreateSpacePayload,
  type QuickCreateSpaceBody,
} from '@/lib/dynamic-workflow-space-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/dynamic-workflow-spaces',
  component: DynamicWorkflowSpacesPage,
})

function DynamicWorkflowSpacesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data, isLoading, error, del, owners } = useResourceList<DynamicWorkflowSpace>({
    queryKey: ['dynamic-workflow-spaces'],
    endpoint: '/api/dynamic-workflow-spaces',
    deleteBy: 'name',
  })

  const [pendingDelete, setPendingDelete] = useState<DynamicWorkflowSpace | null>(null)
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

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const createTriggerRef = useRef<HTMLButtonElement | null>(null)
  const createOpenRef = useRef(false)
  function setCreateOpenTracked(open: boolean): void {
    createOpenRef.current = open
    setCreateOpen(open)
  }
  const create = useMutation({
    mutationFn: (body: QuickCreateSpaceBody): Promise<DynamicWorkflowSpace> =>
      api.post<DynamicWorkflowSpace>('/api/dynamic-workflow-spaces', body),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['dynamic-workflow-spaces'] })
      qc.setQueryData(['dynamic-workflow-spaces', s.name], s)
      if (!createOpenRef.current) return
      setCreateOpenTracked(false)
      navigate({ to: '/dynamic-workflow-spaces/$name', params: { name: s.name } })
    },
  })
  const built = buildQuickCreateSpacePayload({ name: createName, description: createDescription })

  function openCreate(): void {
    setCreateName('')
    setCreateDescription('')
    create.reset()
    setCreateOpenTracked(true)
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('dynamicWorkflowSpaces.title')}</h1>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          ref={createTriggerRef}
          onClick={openCreate}
          data-testid="dwspace-new-button"
        >
          {t('dynamicWorkflowSpaces.newButton')}
        </button>
      </header>

      {isLoading && <LoadingState data-testid="dwspaces-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('dynamicWorkflowSpaces.emptyList')} data-testid="dwspaces-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('dynamicWorkflowSpaces.colName')}</th>
              <th>{t('dynamicWorkflowSpaces.colPool')}</th>
              <th>{t('dynamicWorkflowSpaces.colDescription')}</th>
              <th>{t('dynamicWorkflowSpaces.colUpdated')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id} data-testid={`dwspace-row-${s.name}`}>
                <ResourceNameCell
                  to="/dynamic-workflow-spaces/$name"
                  params={{ name: s.name }}
                  name={s.name}
                  visibility={s.visibility}
                  ownerUserId={s.ownerUserId}
                  owners={owners}
                />
                <td className="data-table__nowrap">{s.agentPool.length}</td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={s.description || undefined}
                >
                  {s.description || t('common.emDash')}
                </td>
                <td className="data-table__nowrap data-table__muted">
                  {new Date(s.updatedAt).toLocaleString()}
                </td>
                <td className="data-table__actions">
                  <Link
                    to="/dynamic-workflow-spaces/$name"
                    params={{ name: s.name }}
                    className="btn btn--sm"
                  >
                    {t('common.open')}
                  </Link>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => setPendingDelete(s)}
                    disabled={del.isPending}
                    data-testid={`dwspace-delete-${s.name}`}
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
        title={t('dynamicWorkflowSpaces.deleteTitle')}
        size="sm"
        data-testid="dwspace-delete-dialog"
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
              data-testid="dwspace-delete-confirm"
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p>{t('dynamicWorkflowSpaces.deleteBody', { name: pendingDelete?.name ?? '' })}</p>
      </Dialog>

      <QuickCreateDialog
        open={createOpen}
        onClose={() => setCreateOpenTracked(false)}
        title={t('dynamicWorkflowSpaces.newTitle')}
        createLabel={t('dynamicWorkflowSpaces.createButton')}
        nameLabel={t('dynamicWorkflowSpaces.fieldName')}
        nameHint={t('dynamicWorkflowSpaces.fieldNameHint')}
        descriptionLabel={t('dynamicWorkflowSpaces.fieldDescription')}
        name={createName}
        onNameChange={setCreateName}
        description={createDescription}
        onDescriptionChange={setCreateDescription}
        nameError={
          createName !== '' && !built.ok && built.errors.name !== undefined
            ? t(built.errors.name)
            : undefined
        }
        canCreate={built.ok}
        pending={create.isPending}
        submitError={
          create.error !== null && create.error !== undefined
            ? describeApiError(create.error)
            : undefined
        }
        onCreate={() => {
          if (built.ok) create.mutate(built.payload)
        }}
        triggerRef={createTriggerRef}
        testidPrefix="dwspace"
        descriptionMaxLength={4096}
      />
    </div>
  )
}
