// RFC-053 P-6 — diagnose panel.
//
// Modal launched from <StuckTaskBanner>. On open it POSTs to
// `/api/tasks/:id/diagnose`, which runs the invariant scan live for that
// task and returns the current findings. Renders the alerts as a table
// of (rule × severity × detail JSON), enough for an operator to
// understand the issue without going to the DB.
//
// Non-goal: this panel does not offer "fix" actions. Recovery still
// flows through fixup scripts (RFC-052 template). The UI's only job is
// to make the wedge visible.

import { useMutation } from '@tanstack/react-query'
import { useEffect, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import type { LifecycleAlertRule, LifecycleAlertSeverity } from '@/types/lifecycle'

interface DiagnoseAlertRow {
  id: string
  taskId: string
  rule: LifecycleAlertRule
  severity: LifecycleAlertSeverity
  detail: Record<string, unknown>
  detectedAt: number
  resolvedAt: number | null
}

interface DiagnoseResponse {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: DiagnoseAlertRow[]
}

export interface TaskDiagnosePanelProps {
  taskId: string
  open: boolean
  onClose: () => void
}

export function TaskDiagnosePanel(props: TaskDiagnosePanelProps): ReactElement {
  const { t } = useTranslation()
  const m = useMutation<DiagnoseResponse>({
    mutationFn: () =>
      api.post<DiagnoseResponse>(`/api/tasks/${encodeURIComponent(props.taskId)}/diagnose`),
  })

  // Auto-run the scan when the panel opens — operators rarely want a stale
  // view of "diagnose". Reset state when the modal closes so the next open
  // re-fetches fresh.
  useEffect(() => {
    if (props.open) {
      m.mutate()
    } else {
      m.reset()
    }
    // We intentionally don't depend on `m` here — the linter would call
    // for it, but `mutate`/`reset` are stable references from react-query.
    // Tracking would re-trigger on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.taskId])

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('tasks.diagnose.panelTitle')}
      size="lg"
      data-testid="task-diagnose-panel"
      footer={
        <div className="dialog__footer">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => m.mutate()}
            disabled={m.isPending}
            data-testid="task-diagnose-rescan"
          >
            {m.isPending ? t('tasks.diagnose.rescanning') : t('tasks.diagnose.rescan')}
          </button>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('tasks.diagnose.close')}
          </button>
        </div>
      }
    >
      {m.isPending && <div className="muted">{t('tasks.diagnose.loading')}</div>}
      {m.error !== null && m.error !== undefined && (
        <div className="error-box">
          {m.error instanceof Error ? m.error.message : String(m.error)}
        </div>
      )}
      {m.data !== undefined && <DiagnoseTable response={m.data} />}
    </Dialog>
  )
}

function DiagnoseTable({ response }: { response: DiagnoseResponse }): ReactElement {
  const { t } = useTranslation()
  if (response.openAlerts.length === 0) {
    return (
      <div className="muted" data-testid="task-diagnose-empty">
        {t('tasks.diagnose.empty')}
      </div>
    )
  }
  return (
    <table className="diagnose-table" data-testid="task-diagnose-table">
      <thead>
        <tr>
          <th>{t('tasks.diagnose.col.rule')}</th>
          <th>{t('tasks.diagnose.col.severity')}</th>
          <th>{t('tasks.diagnose.col.detectedAt')}</th>
          <th>{t('tasks.diagnose.col.detail')}</th>
        </tr>
      </thead>
      <tbody>
        {response.openAlerts.map((a) => (
          <tr key={a.id} data-rule={a.rule}>
            <td>
              <code>{a.rule}</code>
              <div className="muted" style={{ fontSize: 12 }}>
                {t(`tasks.diagnose.rule.${a.rule}`)}
              </div>
            </td>
            <td>
              <span
                className={`status-chip status-chip--${a.severity === 'error' ? 'danger' : 'warning'}`}
              >
                {t(`tasks.diagnose.severity.${a.severity}`)}
              </span>
            </td>
            <td>{new Date(a.detectedAt).toLocaleString()}</td>
            <td>
              <pre className="diagnose-table__detail">{JSON.stringify(a.detail, null, 2)}</pre>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
