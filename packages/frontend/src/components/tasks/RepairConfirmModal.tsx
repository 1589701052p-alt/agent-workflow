// RFC-057 — second-confirm modal nested under <RepairChoiceDialog>.
//
// The choice dialog renders the option list + preview steps. This modal
// is the gating "are you sure?" step required by RFC-057 §4
// destructive-action policy. It:
//   - re-renders the <RepairPreview> (so the user re-sees the steps
//     they're about to apply)
//   - shows a danger-styled Confirm button when option.destructive=true
//   - POSTs { optionId, confirm: true } and forwards the response
//   - surfaces backend errors inline via <ErrorBanner>
//
// `confirm: true` is enforced server-side via Zod; the modal sends it
// unconditionally so a UI-state bug can never trigger an apply.

import { useMutation } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { RepairOption, RepairRequest, RepairResponse } from '@agent-workflow/shared'

import { ApiError, api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'

import { RepairPreview } from './RepairPreview'

export interface RepairConfirmModalProps {
  taskId: string
  alertId: string
  option: RepairOption
  open: boolean
  onCancel: () => void
  onApplied: (result: RepairResponse) => void
}

export function RepairConfirmModal(props: RepairConfirmModalProps): ReactElement {
  const { t } = useTranslation()
  const { taskId, alertId, option, open, onCancel, onApplied } = props

  const apply = useMutation<RepairResponse, ApiError>({
    mutationFn: () => {
      const body: RepairRequest = { optionId: option.id, confirm: true }
      return api.post<RepairResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/alerts/${encodeURIComponent(alertId)}/repair`,
        body,
      )
    },
    onSuccess: (result) => onApplied(result),
  })

  const confirmDisabled = !option.available || apply.isPending
  const confirmClass = option.destructive ? 'btn btn--sm btn--danger' : 'btn btn--sm btn--primary'

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('tasks.diagnose.repair.confirmTitle')}
      size="md"
      data-testid="repair-confirm-modal"
      panelClassName={option.destructive ? 'repair-confirm--destructive' : undefined}
      footer={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={onCancel}
            disabled={apply.isPending}
            data-testid="repair-confirm-cancel"
          >
            {t('tasks.diagnose.repair.cancel')}
          </button>
          <button
            type="button"
            className={confirmClass}
            onClick={() => apply.mutate()}
            disabled={confirmDisabled}
            data-testid="repair-confirm-apply"
          >
            {apply.isPending
              ? t('tasks.diagnose.repair.applying')
              : t('tasks.diagnose.repair.confirmApply')}
          </button>
        </>
      }
    >
      <p className="repair-confirm__lead">
        {t('tasks.diagnose.repair.confirmLead', {
          option: t(option.labelKey),
        })}
      </p>
      <RepairPreview option={option} data-testid="repair-confirm-preview" />
      {apply.error !== null && apply.error !== undefined && <ErrorBanner error={apply.error} />}
    </Dialog>
  )
}
