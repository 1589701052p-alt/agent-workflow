// Shared quick-create dialog for resource list pages (workflows + workgroups,
// the RFC-164 pattern): the dialog collects name + description ONLY — every
// other field lives on the detail page / editor. Extracted 2026-07-10 (用户
// 拍板) after the second inline copy appeared; both pages must render
// pixel-identically, so the chrome lives here and the parents keep the draft
// state, builder validation and create mutation.
//
// Naming rules are unified across both resources (slug charset, ≤128 — see
// shared WORKFLOW_NAME_RE = WORKGROUP_NAME_RE), which is why the name input's
// maxLength and required flag are baked in rather than configurable.

import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'

export interface QuickCreateDialogProps {
  open: boolean
  onClose: () => void
  title: string
  /** Confirm button label（「创建工作流」/「创建工作组」）. */
  createLabel: string
  nameLabel: string
  /** Rule hint under the name label — identical copy for every resource. */
  nameHint: string
  descriptionLabel: string
  name: string
  onNameChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  /** Translated inline error for a malformed (non-empty) name. */
  nameError?: string
  /** Parent builder's verdict — gates the confirm button. */
  canCreate: boolean
  pending: boolean
  /** Translated error from the create mutation, shown in the footer. */
  submitError?: string
  onCreate: () => void
  triggerRef?: RefObject<HTMLButtonElement | null>
  /** data-testid prefix: `<prefix>-create-{dialog,name,description,confirm}`. */
  testidPrefix: string
  /** Optional cap for the description input (e.g. workgroups' schema max). */
  descriptionMaxLength?: number
}

export function QuickCreateDialog({
  open,
  onClose,
  title,
  createLabel,
  nameLabel,
  nameHint,
  descriptionLabel,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  nameError,
  canCreate,
  pending,
  submitError,
  onCreate,
  triggerRef,
  testidPrefix,
  descriptionMaxLength,
}: QuickCreateDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      triggerRef={triggerRef}
      data-testid={`${testidPrefix}-create-dialog`}
      footer={
        <>
          {submitError !== undefined && <span className="form-actions__error">{submitError}</span>}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={pending || !canCreate}
            onClick={onCreate}
            data-testid={`${testidPrefix}-create-confirm`}
          >
            {pending ? t('common.creating') : createLabel}
          </button>
        </>
      }
    >
      {/* Required-ness is conveyed by the disabled confirm button; only a
          malformed (non-empty) name earns the inline error. */}
      <Field label={nameLabel} required hint={nameHint} error={nameError}>
        <TextInput
          value={name}
          onChange={onNameChange}
          maxLength={128}
          required
          data-testid={`${testidPrefix}-create-name`}
        />
      </Field>
      <Field label={descriptionLabel}>
        <TextInput
          value={description}
          onChange={onDescriptionChange}
          maxLength={descriptionMaxLength}
          data-testid={`${testidPrefix}-create-description`}
        />
      </Field>
    </Dialog>
  )
}
