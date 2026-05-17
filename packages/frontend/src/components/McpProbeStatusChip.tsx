// RFC-030 — four-state probe status chip used in /mcps list + detail header.
//
// States:
//   unknown — no probe row exists (never probed)
//   probing — POST in flight (transient UI state, controlled by parent)
//   ok      — last probe status === 'ok' (includes 'partial' — server is reachable,
//             we just couldn't enumerate everything; the partial detail is
//             surfaced separately in the inventory panel, not here)
//   error   — last probe status === 'error'
//
// We deliberately keep this dumb: the parent decides what state to pass in,
// usually derived from the probe row + a local `isPending` from the mutation.
//
// RFC-035: this chip now renders the unified <StatusChip> with `withDot` so
// the live "probing" indicator still has a visual pulse anchor.

import { useTranslation } from 'react-i18next'
import { StatusChip, type StatusChipKind } from './StatusChip'

export type McpProbeUiStatus = 'unknown' | 'probing' | 'ok' | 'error'

export interface McpProbeStatusChipProps {
  status: McpProbeUiStatus
  /** Optional tooltip text (e.g. errorMessage). */
  title?: string
}

const KIND: Record<McpProbeUiStatus, StatusChipKind> = {
  unknown: 'neutral',
  probing: 'info',
  ok: 'success',
  error: 'danger',
}

export function McpProbeStatusChip(props: McpProbeStatusChipProps) {
  const { t } = useTranslation()
  const label = t(`mcps.probe.status.${props.status}`)
  return (
    <StatusChip
      kind={KIND[props.status]}
      size="sm"
      withDot
      title={props.title ?? label}
      aria-label={label}
      data-testid={`mcp-probe-status-${props.status}`}
    >
      {label}
    </StatusChip>
  )
}
