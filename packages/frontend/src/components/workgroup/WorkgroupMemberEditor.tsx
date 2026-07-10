// RFC-164 PR-1 — workgroup member row editor.
//
// Row = type <Select> (agent/human) + reference control + displayName +
// roleDesc + leader radio (leader_worker mode, agent rows only) + remove.
//   - agent reference: shared <TextInput> backed by a <datalist> of known
//     agent names — dangling names are LEGAL (launch-time validation owns
//     existence, same contract as workflow agentName), so a closed <Select>
//     cannot host this field.
//   - human reference: shared <Select> over platform users (value=userId;
//     the id itself is never rendered — RFC-099 prompt-isolation keeps ids
//     out of every agent-facing surface, aliases only).
// Leader selection anchors to the LOCAL row key (lib/workgroup-form), so
// renaming a member never silently moves the leader flag. Rows whose type
// flips away from 'agent' drop the flag (only agent members may lead).

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { Select } from '@/components/Select'
import { TextInput } from '@/components/Form'
import {
  deriveMemberAlias,
  emptyAgentRow,
  emptyHumanRow,
  type WorkgroupMemberRowState,
} from '@/lib/workgroup-form'

/** One atomic member-editor change: members and the leader flag always move
 *  together, so a type-flip that clears the leader is ONE parent onChange
 *  (two sequential calls would each spread the same stale form value and the
 *  second would overwrite the first — locked by workgroup-form.test.tsx). */
export interface WorkgroupMembersChange {
  members: WorkgroupMemberRowState[]
  leaderKey: string | null
}

export interface WorkgroupMemberEditorProps {
  members: WorkgroupMemberRowState[]
  mode: 'leader_worker' | 'free_collab'
  leaderKey: string | null
  onChange: (next: WorkgroupMembersChange) => void
  /** Known agent names (GET /api/agents) — datalist suggestions only. */
  agentNames: string[]
  /** Pickable platform users for human rows. */
  users: UserPublic[]
  /** Raw i18n error keys from the payload builder (`member-{i}-…`). */
  errors: Record<string, string>
}

export function WorkgroupMemberEditor(props: WorkgroupMemberEditorProps) {
  const { t } = useTranslation()
  const datalistId = useId()
  const leaderGroup = useId()
  const showLeader = props.mode === 'leader_worker'

  function patchRow(idx: number, patch: Partial<WorkgroupMemberRowState>): void {
    props.onChange({
      members: props.members.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
      leaderKey: props.leaderKey,
    })
  }

  function setType(idx: number, memberType: 'agent' | 'human'): void {
    const row = props.members[idx]
    if (row === undefined || row.memberType === memberType) return
    props.onChange({
      // Reference fields don't survive a type flip; alias + roleDesc do.
      members: props.members.map((m, i) =>
        i === idx ? { ...m, memberType, agentName: '', userId: '' } : m,
      ),
      // Only agent members may lead (shared schema `leader must be an agent`).
      leaderKey: memberType === 'human' && props.leaderKey === row.key ? null : props.leaderKey,
    })
  }

  function setUser(idx: number, userId: string): void {
    const row = props.members[idx]
    if (row === undefined) return
    const nextUser = props.users.find((u) => u.id === userId)
    const prevUser = props.users.find((u) => u.id === row.userId)
    // Prefill the alias when the row has none yet, or when it still equals
    // the previous pick's auto-derived alias (i.e. the user never edited it).
    const untouched =
      row.displayName === '' ||
      (prevUser !== undefined && row.displayName === deriveMemberAlias(prevUser))
    patchRow(idx, {
      userId,
      ...(untouched && nextUser !== undefined ? { displayName: deriveMemberAlias(nextUser) } : {}),
    })
  }

  function addRow(row: WorkgroupMemberRowState): void {
    props.onChange({ members: [...props.members, row], leaderKey: props.leaderKey })
  }

  function removeRow(idx: number): void {
    const row = props.members[idx]
    props.onChange({
      members: props.members.filter((_, i) => i !== idx),
      leaderKey: row !== undefined && props.leaderKey === row.key ? null : props.leaderKey,
    })
  }

  function rowError(
    idx: number,
    field: 'agentName' | 'userId' | 'displayName',
  ): string | undefined {
    return props.errors[`member-${idx}-${field}`]
  }

  return (
    <div className="workgroup-members">
      <datalist id={datalistId}>
        {props.agentNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {props.members.length > 0 && (
        <div className="workgroup-members__head" aria-hidden="true">
          <span>{t('workgroups.memberColType')}</span>
          <span>{t('workgroups.memberColRef')}</span>
          <span>{t('workgroups.memberColDisplayName')}</span>
          <span>{t('workgroups.memberColRole')}</span>
          <span>{showLeader ? t('workgroups.memberColLeader') : ''}</span>
          <span />
        </div>
      )}

      <ul className="workgroup-members__list">
        {props.members.map((m, idx) => {
          const errs = (['agentName', 'userId', 'displayName'] as const)
            .map((f) => rowError(idx, f))
            .filter((e): e is string => e !== undefined)
          return (
            <li key={m.key} className="workgroup-member" data-testid={`workgroup-member-${idx}`}>
              <div className="workgroup-member__row">
                <Select<'agent' | 'human'>
                  value={m.memberType}
                  onChange={(v) => setType(idx, v)}
                  ariaLabel={t('workgroups.memberTypeAria', { index: idx + 1 })}
                  options={[
                    { value: 'agent', label: t('workgroups.memberTypeAgent') },
                    { value: 'human', label: t('workgroups.memberTypeHuman') },
                  ]}
                  data-testid={`workgroup-member-type-${idx}`}
                />
                {m.memberType === 'agent' ? (
                  <TextInput
                    value={m.agentName}
                    onChange={(v) => patchRow(idx, { agentName: v })}
                    placeholder={t('workgroups.memberAgentPlaceholder')}
                    list={datalistId}
                    data-testid={`workgroup-member-agent-${idx}`}
                  />
                ) : (
                  <Select<string>
                    value={m.userId}
                    onChange={(v) => setUser(idx, v)}
                    ariaLabel={t('workgroups.memberUserAria', { index: idx + 1 })}
                    placeholder={t('workgroups.memberUserPlaceholder')}
                    options={props.users.map((u) => ({
                      value: u.id,
                      label: u.displayName,
                      description: `@${u.username}`,
                    }))}
                    data-testid={`workgroup-member-user-${idx}`}
                  />
                )}
                <TextInput
                  value={m.displayName}
                  onChange={(v) => patchRow(idx, { displayName: v })}
                  placeholder={t('workgroups.memberDisplayNamePlaceholder')}
                  maxLength={64}
                  data-testid={`workgroup-member-displayname-${idx}`}
                />
                <TextInput
                  value={m.roleDesc}
                  onChange={(v) => patchRow(idx, { roleDesc: v })}
                  placeholder={t('workgroups.memberRolePlaceholder')}
                  maxLength={2048}
                  data-testid={`workgroup-member-role-${idx}`}
                />
                {showLeader && m.memberType === 'agent' ? (
                  <label className="workgroup-member__leader">
                    <input
                      type="radio"
                      name={leaderGroup}
                      checked={props.leaderKey === m.key}
                      onChange={() => props.onChange({ members: props.members, leaderKey: m.key })}
                      aria-label={t('workgroups.leaderRadioAria', {
                        name: m.displayName || String(idx + 1),
                      })}
                      data-testid={`workgroup-member-leader-${idx}`}
                    />
                    <span>{t('workgroups.memberColLeader')}</span>
                  </label>
                ) : (
                  <span className="workgroup-member__leader workgroup-member__leader--none" />
                )}
                <button
                  type="button"
                  className="chip__remove workgroup-member__remove"
                  onClick={() => removeRow(idx)}
                  aria-label={t('common.removeAria', {
                    label: m.displayName || t('workgroups.memberFallbackLabel', { index: idx + 1 }),
                  })}
                  data-testid={`workgroup-member-remove-${idx}`}
                >
                  ×
                </button>
              </div>
              {errs.length > 0 && (
                <div className="workgroup-member__errors">
                  {errs.map((e) => (
                    <span key={e} className="form-field__error" role="alert">
                      {t(e)}
                    </span>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="workgroup-members__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => addRow(emptyAgentRow())}
          data-testid="workgroup-add-agent-member"
        >
          {t('workgroups.addAgentMember')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => addRow(emptyHumanRow())}
          data-testid="workgroup-add-human-member"
        >
          {t('workgroups.addHumanMember')}
        </button>
      </div>
    </div>
  )
}
