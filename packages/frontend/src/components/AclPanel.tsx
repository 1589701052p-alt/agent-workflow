// RFC-099 — shared "权限" panel for the five ACL'd resource detail pages
// (agents / skills / mcps / plugins / workflows).
//
// Shows owner + visibility + member list to every viewer (D16); owner and
// admins additionally edit visibility / members and transfer ownership
// (D9). Hidden entirely under the daemon token (single-user mode — D19).
//
// Save model: explicit 保存 button per panel (matches the surrounding detail
// pages, which are explicit-save too); owner transfer confirms via Dialog.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ResourceAcl, ResourceVisibility, UserPublic } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'
import { useActor } from '@/hooks/useActor'
import { Dialog } from './Dialog'
import { UserPicker } from './UserPicker'

interface AclPanelProps {
  /** e.g. '/api/agents/my-agent' — the panel appends '/acl'. */
  resourceBaseUrl: string
  /** Query key segment to invalidate the parent resource on changes. */
  invalidateKey: readonly unknown[]
}

export function AclPanel({ resourceBaseUrl, invalidateKey }: AclPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actor = useActor()
  const aclUrl = `${resourceBaseUrl}/acl`

  const query = useQuery<ResourceAcl>({
    queryKey: ['acl', aclUrl],
    queryFn: ({ signal }) => api.get(aclUrl, undefined, signal),
    // Single-user daemon mode (D19): no humans, no panel, no fetch.
    enabled: actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon',
  })

  const [visibility, setVisibility] = useState<ResourceVisibility>('public')
  const [members, setMembers] = useState<UserPublic[]>([])
  const [dirty, setDirty] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTo, setTransferTo] = useState<UserPublic[]>([])

  useEffect(() => {
    if (query.data !== undefined && !dirty) {
      setVisibility(query.data.visibility)
      setMembers(query.data.users)
    }
  }, [query.data, dirty])

  const save = useMutation({
    mutationFn: (body: {
      visibility?: ResourceVisibility
      userIds?: string[]
      ownerUserId?: string
    }) => api.put<ResourceAcl>(aclUrl, body),
    onSuccess: (next) => {
      qc.setQueryData(['acl', aclUrl], next)
      setDirty(false)
      setTransferOpen(false)
      setTransferTo([])
      void qc.invalidateQueries({ queryKey: invalidateKey })
    },
  })

  if (actor.data === null || actor.data === undefined || actor.data.source === 'daemon') {
    return null
  }
  if (query.isLoading) return null
  if (query.error !== null && query.error !== undefined) return null
  const acl = query.data
  if (acl === undefined) return null

  const canManage = acl.canManage

  return (
    <section className="page__section acl-panel" data-testid="acl-panel">
      <h2 className="acl-panel__title">{t('acl.title')}</h2>

      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.owner')}</span>
        <span className="acl-panel__value">
          {acl.owner !== null ? (
            <span className="chip chip--tight">
              {acl.owner.displayName}
              <span className="user-picker__username">@{acl.owner.username}</span>
            </span>
          ) : (
            <span className="muted">{t('acl.systemOwner')}</span>
          )}
          {canManage && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setTransferOpen(true)}
              data-testid="acl-transfer-owner"
            >
              {t('acl.transferOwner')}
            </button>
          )}
        </span>
      </div>

      <div className="acl-panel__row">
        <span className="acl-panel__label">{t('acl.visibility')}</span>
        {canManage ? (
          <div className="segmented" role="group" aria-label={t('acl.visibility')}>
            {(['public', 'private'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`segmented__option${visibility === v ? ' segmented__option--active' : ''}`}
                data-testid={`acl-visibility-${v}`}
                onClick={() => {
                  setVisibility(v)
                  setDirty(true)
                }}
              >
                {t(`acl.visibilityValue.${v}`)}
              </button>
            ))}
          </div>
        ) : (
          <span className="acl-panel__value">{t(`acl.visibilityValue.${acl.visibility}`)}</span>
        )}
      </div>

      <div className="acl-panel__row acl-panel__row--members">
        <span className="acl-panel__label">{t('acl.members')}</span>
        {canManage ? (
          <UserPicker
            value={members}
            onChange={(next) => {
              setMembers(next)
              setDirty(true)
            }}
            excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
            testidPrefix="acl-members"
          />
        ) : members.length === 0 ? (
          <span className="muted">{t('acl.noMembers')}</span>
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

      {visibility === 'private' && <p className="page__hint">{t('acl.privateHint')}</p>}

      {canManage && (
        <div className="acl-panel__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!dirty || save.isPending}
            data-testid="acl-save"
            onClick={() => save.mutate({ visibility, userIds: members.map((u) => u.id) })}
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
              data-testid="acl-transfer-confirm"
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
        <p className="page__hint">{t('acl.transferHint')}</p>
        <UserPicker
          value={transferTo}
          onChange={setTransferTo}
          single
          excludeIds={acl.ownerUserId !== null ? [acl.ownerUserId] : []}
          testidPrefix="acl-transfer"
        />
      </Dialog>
    </section>
  )
}
