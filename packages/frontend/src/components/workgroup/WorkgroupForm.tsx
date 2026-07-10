// RFC-164 PR-1 — workgroup form shared by /workgroups/new and
// /workgroups/$name (same create/edit parity contract as McpFields).
// Four sections: basics / mode / members / collaboration switches.
//
// free_collab forces the three collaboration switches to read as ON
// (disabled controls + notice) WITHOUT mutating the stored values — the
// shared resolveWorkgroupSwitches defines fc as all-on regardless of
// storage, so flipping back to leader_worker restores the user's choices.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Agent, UserPublic, WorkgroupMode } from '@agent-workflow/shared'
import { WORKGROUP_MAX_ROUNDS_LIMIT, WORKGROUP_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { Segmented } from '@/components/Segmented'
import { WorkgroupMemberEditor } from '@/components/workgroup/WorkgroupMemberEditor'
import type { WorkgroupFormState } from '@/lib/workgroup-form'

export interface WorkgroupFormProps {
  value: WorkgroupFormState
  onChange: (next: WorkgroupFormState) => void
  /** Edit mode locks the name field — renames go through the header dialog. */
  nameLocked?: boolean
  /** Raw i18n error keys from the payload builder. */
  errors: Record<string, string>
}

export function WorkgroupForm({ value, onChange, nameLocked, errors }: WorkgroupFormProps) {
  const { t } = useTranslation()
  const set = <K extends keyof WorkgroupFormState>(k: K, v: WorkgroupFormState[K]): void => {
    onChange({ ...value, [k]: v })
  }

  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  // users:search is the every-user endpoint (GET /api/users needs the admin
  // users:read permission — a non-admin creating a workgroup would 403).
  const usersQ = useQuery<UserPublic[]>({
    queryKey: ['users', 'search-all'],
    queryFn: ({ signal }) => api.get('/api/users/search', { limit: 100 }, signal),
    staleTime: 30_000,
  })

  const fc = value.mode === 'free_collab'

  return (
    <div className="workgroup-form">
      <FormSection title={t('workgroups.sectionBasics')}>
        <Field
          label={t('workgroups.fieldName')}
          required
          hint={t('workgroups.fieldNameHint')}
          error={errors.name !== undefined ? t(errors.name) : undefined}
        >
          <TextInput
            value={value.name}
            onChange={(v) => set('name', v)}
            placeholder="review-squad"
            disabled={nameLocked === true}
            required
            pattern={WORKGROUP_NAME_RE.source}
            maxLength={128}
            data-testid="workgroup-field-name"
          />
        </Field>

        <Field label={t('workgroups.fieldDescription')}>
          <TextInput
            value={value.description}
            onChange={(v) => set('description', v)}
            maxLength={4096}
            data-testid="workgroup-field-description"
          />
        </Field>

        <Field
          label={t('workgroups.fieldInstructions')}
          hint={t('workgroups.fieldInstructionsHint')}
        >
          <TextArea
            value={value.instructions}
            onChange={(v) => set('instructions', v)}
            rows={6}
            monospace
            maxLength={65536}
            data-testid="workgroup-field-instructions"
          />
        </Field>
      </FormSection>

      <FormSection title={t('workgroups.sectionMode')}>
        {/* `group` — Segmented is a composite control; the default <label>
            wrapper would hijack each option's accessible name. */}
        <Field
          label={t('workgroups.fieldMode')}
          group
          hint={fc ? t('workgroups.modeHintFreeCollab') : t('workgroups.modeHintLeaderWorker')}
        >
          <Segmented<WorkgroupMode>
            value={value.mode}
            onChange={(v) => set('mode', v)}
            ariaLabel={t('workgroups.fieldMode')}
            testidPrefix="workgroup-mode"
            options={[
              { value: 'leader_worker', label: t('workgroups.modeLeaderWorker') },
              { value: 'free_collab', label: t('workgroups.modeFreeCollab') },
            ]}
          />
        </Field>
      </FormSection>

      <FormSection title={t('workgroups.sectionMembers')}>
        {errors.members !== undefined && (
          <span className="form-field__error" role="alert">
            {t(errors.members)}
          </span>
        )}
        {errors.leader !== undefined && (
          <span className="form-field__error" role="alert">
            {t(errors.leader)}
          </span>
        )}
        <WorkgroupMemberEditor
          members={value.members}
          mode={value.mode}
          leaderKey={value.leaderKey}
          onChange={(next) =>
            onChange({ ...value, members: next.members, leaderKey: next.leaderKey })
          }
          agentNames={(agentsQ.data ?? []).map((a) => a.name)}
          users={usersQ.data ?? []}
          errors={errors}
        />
      </FormSection>

      <FormSection title={t('workgroups.sectionSwitches')}>
        {fc && (
          <p className="form-field__hint" data-testid="workgroup-fc-switches-notice">
            {t('workgroups.fcSwitchesNotice')}
          </p>
        )}
        <Switch
          checked={fc ? true : value.switches.shareOutputs}
          disabled={fc}
          onChange={(v) => set('switches', { ...value.switches, shareOutputs: v })}
          label={t('workgroups.fieldShareOutputs')}
          hint={t('workgroups.fieldShareOutputsHint')}
        />
        <Switch
          checked={fc ? true : value.switches.directMessages}
          disabled={fc}
          onChange={(v) => set('switches', { ...value.switches, directMessages: v })}
          label={t('workgroups.fieldDirectMessages')}
          hint={t('workgroups.fieldDirectMessagesHint')}
        />
        <Switch
          checked={fc ? true : value.switches.blackboard}
          disabled={fc}
          onChange={(v) => set('switches', { ...value.switches, blackboard: v })}
          label={t('workgroups.fieldBlackboard')}
          hint={t('workgroups.fieldBlackboardHint')}
        />

        <Field
          label={t('workgroups.fieldMaxRounds')}
          hint={t('workgroups.fieldMaxRoundsHint')}
          error={errors.maxRounds !== undefined ? t(errors.maxRounds) : undefined}
        >
          <NumberInput
            value={value.maxRounds}
            onChange={(v) => set('maxRounds', v)}
            min={1}
            max={WORKGROUP_MAX_ROUNDS_LIMIT}
            step={1}
            placeholder="20"
            data-testid="workgroup-field-max-rounds"
          />
        </Field>

        <Switch
          checked={value.completionGate}
          onChange={(v) => set('completionGate', v)}
          label={t('workgroups.fieldCompletionGate')}
          hint={t('workgroups.fieldCompletionGateHint')}
        />
      </FormSection>
    </div>
  )
}
