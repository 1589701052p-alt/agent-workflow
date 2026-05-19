// RFC-043 T5 — lists memory rows produced by this distill job, with
// distillAction badge and current status. Clicking a row jumps to
// the Approval Queue with the candidate id in the query string so the
// existing surface can scroll/focus it (consumed by RFC-041 PR4 UI).

import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { MemoryDistillCandidateSnapshot } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'

interface Props {
  items: MemoryDistillCandidateSnapshot[]
}

export function CandidatesList({ items }: Props) {
  const { t } = useTranslation()
  if (items.length === 0) {
    return <EmptyState size="compact" title={t('memory.distillJobDetail.noCandidates')} />
  }
  // candidate first (still pending approval), then everything else by createdAt asc.
  const sorted = [...items].sort((a, b) => {
    if (a.currentStatus === 'candidate' && b.currentStatus !== 'candidate') return -1
    if (a.currentStatus !== 'candidate' && b.currentStatus === 'candidate') return 1
    return a.createdAt - b.createdAt
  })
  return (
    <ul className="distill-job-detail__candidates" data-testid="distill-candidates">
      {sorted.map((c) => (
        <li
          key={c.memoryId}
          className={`distill-job-detail__candidate distill-job-detail__candidate--${c.currentStatus}`}
          data-testid={`distill-candidate-row-${c.memoryId}`}
        >
          <header className="distill-job-detail__candidate-head">
            <span className={`memory-row__scope memory-row__scope--${c.scopeType}`}>
              {t(`memory.scope.${c.scopeType}`)}
            </span>
            <span
              className={`distill-job-detail__action distill-job-detail__action--${c.distillAction}`}
            >
              {t(`memory.distillAction.${distillActionI18nKey(c.distillAction)}`, {
                id: c.referenceMemoryId ?? '?',
              })}
            </span>
            <span className="distill-job-detail__candidate-status muted">
              {t('memory.distillJobDetail.candidateStatus', {
                status: t(`memory.status.${c.currentStatus}`),
              })}
            </span>
          </header>
          <p className="distill-job-detail__candidate-title">{c.title}</p>
          <p className="distill-job-detail__candidate-body muted">{c.bodyMd}</p>
          <Link
            to="/memory"
            search={{ focus: c.memoryId }}
            className="link"
            data-testid={`distill-candidate-link-${c.memoryId}`}
          >
            {t('memory.distillJobDetail.openInQueue')}
          </Link>
        </li>
      ))}
    </ul>
  )
}

// RFC-041 lib/memory.promoteActionToLabel encodes the same map; we keep
// this short local helper so this component doesn't need to import a
// wider helper just for one lookup.
function distillActionI18nKey(
  action: MemoryDistillCandidateSnapshot['distillAction'],
): 'new' | 'updateOf' | 'duplicateOf' | 'conflictWith' {
  switch (action) {
    case 'new':
      return 'new'
    case 'update_of':
      return 'updateOf'
    case 'duplicate_of':
      return 'duplicateOf'
    case 'conflict_with':
      return 'conflictWith'
  }
}
