// RFC-099 (D10) — task members panel on the task detail page. Shows owner +
// task users to every member; owner/admin add & remove users and transfer
// ownership. Task users hold the same operational rights as the owner (D13)
// — this panel is the only owner-gated surface besides task deletion.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskMembers, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { useActor } from '@/hooks/useActor'
import { Dialog } from '../Dialog'
import { UserPicker } from '../UserPicker'

/**
 * RFC-099 — uniform top-right entry point for task members, mirroring
 * AclDialogButton on the resource pages: a header button opening the panel
 * in a Dialog. Hidden under the daemon token (single-user mode).
 */
export function TaskMembersDialogButton({ taskId }: TaskMembersPanelProps) {
  const { t } = useTranslation()
  const actor = useActor()
  const [open, setOpen] = useState(false)
  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
    return null
  }
  return (
    <>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="task-members-dialog-button"
        onClick={() => setOpen(true)}
      >
        {t('members.title')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('members.title')} size="md">
        <TaskMembersPanel taskId={taskId} />
      </Dialog>
    </>
  )
}

interface TaskMembersPanelProps {
  taskId: string
}

export function TaskMembersPanel({ taskId }: TaskMembersPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  const url = `/api/tasks/${encodeURIComponent(taskId)}/members`

  const query = useQuery<TaskMembers>({
    queryKey: ['tasks', taskId, 'members'],
    queryFn: ({ signal }) => api.get(url, undefined, signal),
    enabled: actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon',
  })

  const [members, setMembers] = useState<UserPublic[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])

  useEffect(() => {
    if (query.data !== undefined && !dirty) setMembers(query.data.users)
  }, [query.data, dirty])

  const save = useMutation({
    mutationFn: (body: { userIds?: string[]; ownerUserId?: string }) =>
      api.put<TaskMembers>(url, body),
    onSuccess: (next) => {
      qc.setQueryData(['tasks', taskId, 'members'], next)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
    return null
  }
  if (query.isLoading || query.error !== null || query.data === undefined) return null
  const data = query.data

  return (
    <section className="page__section acl-panel" data-testid="task-members-panel">
      <h2 className="acl-panel__title">{t('members.title')}</h2>

      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.owner')}</span>
        <span className="acl-panel__value">
          {data.owner !== null ? (
            <span className="chip chip--tight">
              {data.owner.displayName}
              <span className="user-picker__username">@{data.owner.username}</span>
            </span>
          ) : (
            <span className="muted">{t('acl.systemOwner')}</span>
          )}
          {data.canManage && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setTransferOpen(true)}
              data-testid="members-transfer-owner"
            >
              {t('acl.transferOwner')}
            </button>
          )}
        </span>
      </div>

      <div className="acl-panel__row acl-panel__row--members">
        <span className="acl-panel__label">{t('members.users')}</span>
        {data.canManage ? (
          <UserPicker
            value={members}
            onChange={(next) => {
              setMembers(next)
              setDirty(true)
            }}
            excludeIds={data.ownerUserId !== null ? [data.ownerUserId] : []}
            testidPrefix="members-users"
          />
        ) : members.length === 0 ? (
          <span className="muted">{t('members.noUsers')}</span>
        ) : (
          <span className="acl-panel__value">
            {members.map((u) => (
              <span key={u.id} className="chip chip--tight">
                {u.displayName}
              </span>
            ))}
          </span>
        )}
      </div>

      <p className="page__hint">{t('members.hint')}</p>

      {data.canManage && (
        <div className="acl-panel__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!dirty || save.isPending}
            data-testid="members-save"
            onClick={() => save.mutate({ userIds: members.map((u) => u.id) })}
          >
            {save.isPending ? t('common.saving') : t('acl.save')}
          </button>
          {save.error !== null && save.error !== undefined && (
            <span className="form-actions__error">{describeApiError(save.error)}</span>
          )}
        </div>
      )}

      <Dialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title={t('acl.transferTitle')}
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setTransferOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={transferTo.length === 0 || save.isPending}
              data-testid="members-transfer-confirm"
              onClick={() => {
                const target = transferTo[0]
                if (target !== undefined) save.mutate({ ownerUserId: target.id })
              }}
            >
              {t('acl.transferConfirm')}
            </button>
          </>
        }
      >
        <p className="page__hint">{t('members.transferHint')}</p>
        <UserPicker
          value={transferTo}
          onChange={setTransferTo}
          single
          excludeIds={data.ownerUserId !== null ? [data.ownerUserId] : []}
          testidPrefix="members-transfer"
        />
      </Dialog>
    </section>
  )
}
