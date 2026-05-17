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

import { useTranslation } from 'react-i18next'

export type McpProbeUiStatus = 'unknown' | 'probing' | 'ok' | 'error'

export interface McpProbeStatusChipProps {
  status: McpProbeUiStatus
  /** Optional tooltip text (e.g. errorMessage). */
  title?: string
}

export function McpProbeStatusChip(props: McpProbeStatusChipProps) {
  const { t } = useTranslation()
  const label = t(`mcps.probe.status.${props.status}`)
  return (
    <span
      className={`chip chip--tight mcp-probe-chip mcp-probe-chip--${props.status}`}
      role="status"
      aria-label={label}
      title={props.title ?? label}
      data-testid={`mcp-probe-status-${props.status}`}
    >
      {label}
    </span>
  )
}
