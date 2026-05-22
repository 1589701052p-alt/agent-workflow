// RFC-057 — preview body for a single repair option.
//
// Inside <RepairChoiceDialog>, once the user picks an option from the
// <Select>, this renders:
//   - the option's description paragraph (i18n)
//   - the risk chip (low/medium/high)
//   - an ordered list of preview steps (backend-provided strings)
//   - an "unavailable" disclaimer when `available === false`
//
// destructive=true colors the background so the dialog feels distinct
// from a benign approve-style option.

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import type { RepairOption } from '@agent-workflow/shared'

import { StatusChip } from '@/components/StatusChip'

export interface RepairPreviewProps {
  option: RepairOption
  /** Test hook so the parent dialog can target this preview block. */
  'data-testid'?: string
}

const RISK_CHIP_KIND: Record<RepairOption['risk'], 'success' | 'warn' | 'danger'> = {
  low: 'success',
  medium: 'warn',
  high: 'danger',
}

export function RepairPreview(props: RepairPreviewProps): ReactElement {
  const { t } = useTranslation()
  const { option } = props
  const classes = ['repair-preview']
  if (option.destructive) classes.push('repair-preview--destructive')
  if (!option.available) classes.push('repair-preview--unavailable')

  return (
    <section className={classes.join(' ')} data-testid={props['data-testid']}>
      <div className="repair-preview__meta">
        <StatusChip kind={RISK_CHIP_KIND[option.risk]} size="sm" data-testid="repair-preview-risk">
          {t(`tasks.diagnose.repair.risk.${option.risk}`)}
        </StatusChip>
        {option.destructive && (
          <StatusChip kind="danger" size="sm" data-testid="repair-preview-destructive">
            {t('tasks.diagnose.repair.destructive')}
          </StatusChip>
        )}
      </div>
      <p className="repair-preview__description">{t(option.descriptionKey)}</p>
      {option.available ? (
        <ol className="repair-preview__steps" data-testid="repair-preview-steps">
          {option.previewSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      ) : (
        <div className="repair-preview__unavailable" data-testid="repair-preview-unavailable">
          {option.unavailableReasonKey !== undefined
            ? t(option.unavailableReasonKey)
            : t('tasks.diagnose.repair.unavailable.generic')}
        </div>
      )}
    </section>
  )
}
