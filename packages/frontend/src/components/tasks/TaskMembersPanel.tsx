// RFC-099 (D10) — task members panel, hosted in a Dialog behind the
// TaskMembersDialogButton header button (uniform with AclDialogButton on the
// resource pages). Shows owner + task users to every member; owner/admin add
// & remove users and transfer ownership. Task users hold the same
// operational rights as the owner (D13) — this panel is the only owner-gated
// surface besides task deletion.
//
// Like AclPanel, the panel renders without its own title/border chrome (the
// Dialog provides both) and ends in a footer action row; a successful save
// closes the dialog.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskMembers, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { useActor } from '@/hooks/useActor'
import { Dialog } from '../Dialog'
import { UserPicker } from '../UserPicker'

interface TaskMembersPanelProps {
  taskId: string
  /** Called after a successful save — the hosting dialog closes itself. */
  onSaved?: () => void
  /** Called by the 取消/关闭 footer button. */
  onCancel?: () => void
}

/**
 * Uniform top-right entry point for task members: header button → Dialog →
 * panel. Hidden under the daemon token (single-user mode).
 */
export function TaskMembersDialogButton({ taskId }: { taskId: string }) {
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
        className="btn"
        data-testid="task-members-dialog-button"
        onClick={() => setOpen(true)}
      >
        {t('members.title')}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('members.title')} size="md">
        <TaskMembersPanel
          taskId={taskId}
          onSaved={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  )
}

export function TaskMembersPanel({ taskId, onSaved, onCancel }: TaskMembersPanelProps) {
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
    onSuccess: (next, body) => {
      qc.setQueryData(['tasks', taskId, 'members'], next)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      if (body.ownerUserId === undefined) onSaved?.()
    },
  })

  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
    return null
  }
  if (query.isLoading || query.error !== null || query.data === undefined) return null
  const data = query.data

  return (
    <div className="acl-panel" data-testid="task-members-panel">
      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.owner')}</span>
        <span className="acl-panel__value">
          {data.owner !== null ? (
            <span className="chip">
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
              <span key={u.id} className="chip">
                {u.displayName}
              </span>
            ))}
          </span>
        )}
      </div>

      <p className="acl-panel__hint page__hint">{t('members.hint')}</p>

      {save.error !== null && save.error !== undefined && (
        <p className="form-actions__error">{describeApiError(save.error)}</p>
      )}

      <div className="acl-panel__footer">
        <button type="button" className="btn" onClick={() => onCancel?.()}>
          {data.canManage ? t('common.cancel') : t('common.close')}
        </button>
        {data.canManage && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={!dirty || save.isPending}
            data-testid="members-save"
            onClick={() => save.mutate({ userIds: members.map((u) => u.id) })}
          >
            {save.isPending ? t('common.saving') : t('acl.save')}
          </button>
        )}
      </div>

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
    </div>
  )
}
