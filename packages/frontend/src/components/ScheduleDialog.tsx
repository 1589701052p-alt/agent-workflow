// RFC-159 — "Save as scheduled task" dialog. Reuses the launch form's already-built
// StartTask body (passed as `buildLaunchPayload`) and only collects the schedule:
// a name + one of interval / daily / weekly / monthly, in the creator's timezone.
import type { ScheduleSpec } from '@agent-workflow/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, type ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, NumberInput, TextInput } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { describeApiError } from '@/i18n'
import { nextRuns } from '@/lib/schedule-view'

type Kind = ScheduleSpec['kind']
type Unit = 'minutes' | 'hours' | 'days'

const CREATOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

interface ScheduleDialogProps {
  open: boolean
  onClose: () => void
  /** Called on save — returns the current launch form's StartTask body (opaque JSON; backend validates). */
  buildLaunchPayload: () => unknown
  defaultName?: string
}

function buildSpec(
  kind: Kind,
  every: number,
  unit: Unit,
  at: string,
  daysOfWeek: number[],
  dayOfMonth: number,
): ScheduleSpec {
  if (kind === 'interval') return { kind: 'interval', every, unit }
  if (kind === 'daily') return { kind: 'daily', at, timezone: CREATOR_TZ }
  if (kind === 'weekly') return { kind: 'weekly', daysOfWeek, at, timezone: CREATOR_TZ }
  return { kind: 'monthly', dayOfMonth, at, timezone: CREATOR_TZ }
}

function fmtPreview(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ScheduleDialog({
  open,
  onClose,
  buildLaunchPayload,
  defaultName,
}: ScheduleDialogProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [name, setName] = useState(defaultName ?? '')
  const [kind, setKind] = useState<Kind>('daily')
  const [every, setEvery] = useState<number | undefined>(6)
  const [unit, setUnit] = useState<Unit>('hours')
  const [at, setAt] = useState('09:00')
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1])
  const [dayOfMonth, setDayOfMonth] = useState<number | undefined>(1)

  const spec = useMemo<ScheduleSpec | null>(() => {
    try {
      if (kind === 'interval' && (every === undefined || every < 1)) return null
      if (kind === 'monthly' && (dayOfMonth === undefined || dayOfMonth < 1 || dayOfMonth > 31))
        return null
      if (kind === 'weekly' && daysOfWeek.length === 0) return null
      return buildSpec(kind, every ?? 1, unit, at, daysOfWeek, dayOfMonth ?? 1)
    } catch {
      return null
    }
  }, [kind, every, unit, at, daysOfWeek, dayOfMonth])

  const preview = useMemo(() => {
    if (spec === null) return []
    try {
      return nextRuns(spec, Date.now(), 3)
    } catch {
      return []
    }
  }, [spec])

  const save = useMutation<{ id: string }, ApiError>({
    mutationFn: () =>
      api.post('/api/scheduled-tasks', {
        name: name.trim(),
        launchPayload: buildLaunchPayload(),
        scheduleSpec: spec,
        enabled: true,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['scheduled-tasks'] })
      onClose()
      void navigate({ to: '/scheduled' })
    },
  })

  const canSave = name.trim().length > 0 && spec !== null && !save.isPending
  const toggleDay = (d: number) =>
    setDaysOfWeek((cur) =>
      cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b),
    )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('scheduled.dialogTitle')}
      size="md"
      data-testid="schedule-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('scheduled.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={() => save.mutate()}
            data-testid="schedule-save"
          >
            {save.isPending ? t('scheduled.saving') : t('scheduled.save')}
          </button>
        </>
      }
    >
      <Field label={t('scheduled.fieldName')} required>
        <TextInput value={name} onChange={setName} maxLength={255} data-testid="schedule-name" />
      </Field>

      <Field label={t('scheduled.fieldMode')} group>
        <Segmented<Kind>
          value={kind}
          onChange={setKind}
          ariaLabel={t('scheduled.fieldMode')}
          testidPrefix="schedule-kind"
          options={[
            { value: 'interval', label: t('scheduled.modeInterval') },
            { value: 'daily', label: t('scheduled.modeDaily') },
            { value: 'weekly', label: t('scheduled.modeWeekly') },
            { value: 'monthly', label: t('scheduled.modeMonthly') },
          ]}
        />
      </Field>

      {kind === 'interval' && (
        <div className="schedule-dialog__row">
          <Field label={t('scheduled.fieldEvery')}>
            <NumberInput
              value={every}
              onChange={setEvery}
              min={1}
              max={1000}
              data-testid="schedule-every"
            />
          </Field>
          <Field label={t('scheduled.fieldUnit')}>
            <Select<Unit>
              value={unit}
              onChange={setUnit}
              options={[
                { value: 'minutes', label: t('scheduled.unitMinutes') },
                { value: 'hours', label: t('scheduled.unitHours') },
                { value: 'days', label: t('scheduled.unitDays') },
              ]}
            />
          </Field>
        </div>
      )}

      {kind !== 'interval' && (
        <Field label={t('scheduled.fieldAt')} hint={t('scheduled.tzNote', { tz: CREATOR_TZ })}>
          <TextInput
            value={at}
            onChange={setAt}
            type="text"
            pattern="^([01]\d|2[0-3]):[0-5]\d$"
            data-testid="schedule-at"
          />
        </Field>
      )}

      {kind === 'weekly' && (
        <Field label={t('scheduled.fieldDays')} group>
          <div className="schedule-dialog__days" role="group" aria-label={t('scheduled.fieldDays')}>
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <button
                key={d}
                type="button"
                className={`btn btn--sm${daysOfWeek.includes(d) ? ' btn--primary' : ''}`}
                aria-pressed={daysOfWeek.includes(d)}
                onClick={() => toggleDay(d)}
                data-testid={`schedule-dow-${d}`}
              >
                {t(`scheduled.dow.${d}`)}
              </button>
            ))}
          </div>
        </Field>
      )}

      {kind === 'monthly' && (
        <Field label={t('scheduled.fieldDayOfMonth')} hint={t('scheduled.dayOfMonthHint')}>
          <NumberInput
            value={dayOfMonth}
            onChange={setDayOfMonth}
            min={1}
            max={31}
            data-testid="schedule-dom"
          />
        </Field>
      )}

      <div className="schedule-dialog__preview" data-testid="schedule-preview">
        <span className="schedule-dialog__preview-label">{t('scheduled.preview')}</span>
        {preview.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <ul>
            {preview.map((e) => (
              <li key={e}>{fmtPreview(e)}</li>
            ))}
          </ul>
        )}
      </div>

      {save.error != null && <div className="error-box">{describeApiError(save.error)}</div>}
    </Dialog>
  )
}
