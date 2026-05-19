// RFC-041 PR4 — generic memory row shared by All / By-Scope / Scoped lists.
//
// Pure presentational: the parent passes a MemorySummary and (optionally)
// owns the action buttons. Approval-queue rendering lives in
// <MemoryApprovalQueue /> because it depends on candidate-only fields
// (distillAction, sourceRefs).

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'

export interface MemoryRowProps {
  memory: MemorySummary
  /** Optional trailing actions (Approve / Archive / Delete buttons). */
  actions?: ReactNode
  'data-testid'?: string
}

export function MemoryRow({ memory, actions, 'data-testid': testId }: MemoryRowProps) {
  const { t } = useTranslation()
  return (
    <li
      className={`memory-row memory-row--${memory.status}`}
      data-testid={testId ?? `memory-row-${memory.id}`}
    >
      <div className="memory-row__head">
        <span className={`memory-row__scope memory-row__scope--${memory.scopeType}`}>
          {t(`memory.scope.${memory.scopeType}`)}
        </span>
        <span className="memory-row__title">{memory.title}</span>
        <span className={`memory-row__status memory-row__status--${memory.status}`}>
          {t(`memory.status.${memory.status}`)}
        </span>
      </div>
      {memory.tags.length > 0 && (
        <div className="memory-row__tags">
          {memory.tags.map((tag) => (
            <span key={tag} className="memory-row__tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="memory-row__meta muted">
        <code className="memory-row__id">{memory.id}</code>
        {memory.approvedAt !== null && (
          <span className="memory-row__approved-at">
            {new Date(memory.approvedAt).toLocaleString()}
          </span>
        )}
        {memory.version > 1 && <span className="memory-row__version">v{memory.version}</span>}
      </div>
      {actions !== undefined && <div className="memory-row__actions">{actions}</div>}
    </li>
  )
}
