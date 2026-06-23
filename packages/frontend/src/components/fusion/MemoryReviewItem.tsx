// RFC-101 — one memory in the fusion approval lists (incorporated / skipped).
// Shows scope chip + title + id + body so the merger can actually judge what
// was incorporated or skipped, instead of a bare, unreviewable id.

import { useTranslation } from 'react-i18next'
import type { Memory } from '@agent-workflow/shared'

export function MemoryReviewItem({
  id,
  mem,
  loading,
  reason,
}: {
  id: string
  mem: Memory | null
  loading: boolean
  /** For skipped memories: why the agent left it out. */
  reason?: string
}) {
  const { t } = useTranslation()
  return (
    <li className="fusion-mem" data-testid={`fusion-mem-${id}`}>
      <div className="fusion-mem__head">
        {mem !== null && (
          <span className={`memory-row__scope memory-row__scope--${mem.scopeType}`}>
            {t(`memory.scope.${mem.scopeType}`)}
          </span>
        )}
        <span className="fusion-mem__title">
          {mem !== null ? mem.title : loading ? t('common.loading') : id}
        </span>
        <code className="fusion-mem__id muted">{id}</code>
      </div>
      {reason !== undefined && reason.length > 0 && (
        <div className="fusion-mem__reason muted">{reason}</div>
      )}
      {mem !== null && <div className="fusion-mem__body">{mem.bodyMd}</div>}
    </li>
  )
}
