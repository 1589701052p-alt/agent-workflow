// RFC-029: small color-coded chip for an MCP server's connection status.
// Color buckets match the design.md §4.3 i18n keys; an unknown status
// string falls through to the `muted` bucket so a future opencode release
// adding a new state still renders something.
//
// RFC-035: this badge now renders the unified <StatusChip>. The component's
// own name + API are preserved (callers untouched); only the implementation
// is unified with the rest of the app.

import { useTranslation } from 'react-i18next'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'

type Bucket = 'success' | 'warn' | 'danger' | 'muted'

const BUCKET: Record<string, Bucket> = {
  connected: 'success',
  needs_auth: 'warn',
  needs_client_registration: 'warn',
  failed: 'danger',
  disabled: 'muted',
  not_initialized: 'muted',
}

const BUCKET_TO_KIND: Record<Bucket, StatusChipKind> = {
  success: 'success',
  warn: 'warn',
  danger: 'danger',
  muted: 'neutral',
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const bucket = BUCKET[status] ?? 'muted'
  const key = `nodeDrawer.inventory.status.${status}`
  // i18next returns the key string itself when missing; fall back to the
  // raw value so unknown statuses still surface as text.
  const label = t(key, { defaultValue: status })
  return (
    <StatusChip kind={BUCKET_TO_KIND[bucket]} size="sm">
      {label}
    </StatusChip>
  )
}
