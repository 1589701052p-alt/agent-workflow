// RFC-029: small color-coded chip for an MCP server's connection status.
// Color buckets match the design.md §4.3 i18n keys; an unknown status
// string falls through to the `muted` bucket so a future opencode release
// adding a new state still renders something.

import { useTranslation } from 'react-i18next'

type Bucket = 'success' | 'warn' | 'danger' | 'muted'

const BUCKET: Record<string, Bucket> = {
  connected: 'success',
  needs_auth: 'warn',
  needs_client_registration: 'warn',
  failed: 'danger',
  disabled: 'muted',
  not_initialized: 'muted',
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const bucket = BUCKET[status] ?? 'muted'
  const key = `nodeDrawer.inventory.status.${status}`
  // i18next returns the key string itself when missing; fall back to the
  // raw value so unknown statuses still surface as text.
  const label = t(key, { defaultValue: status })
  return <span className={`status-badge status-badge--${bucket}`}>{label}</span>
}
