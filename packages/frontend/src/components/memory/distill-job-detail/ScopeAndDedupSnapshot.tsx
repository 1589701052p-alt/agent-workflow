// RFC-043 T5 — shows the resolved scope (agent ids / workflow / repo /
// global) the distiller was given + the snapshot of approved memories
// it saw at run time as dedup context.

import { useTranslation } from 'react-i18next'
import type { MemoryDistillDedupSnapshotEntry, ResolvedDistillScope } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'

interface Props {
  scope: ResolvedDistillScope
  snapshot: MemoryDistillDedupSnapshotEntry[]
}

export function ScopeAndDedupSnapshot({ scope, snapshot }: Props) {
  const { t } = useTranslation()
  return (
    <div className="distill-job-detail__scope" data-testid="distill-scope-and-dedup">
      <div className="distill-job-detail__scope-row">
        {scope.agentIds.length > 0 && (
          <span className="distill-job-detail__scope-chip">
            {t('memory.scopeRow.agentCount', { n: scope.agentIds.length })}
          </span>
        )}
        {scope.workflowId !== null && (
          <span className="distill-job-detail__scope-chip">
            {t('memory.scopeRow.workflowPrefix')}
            <code>{scope.workflowId}</code>
          </span>
        )}
        {scope.repoId !== null && (
          <span className="distill-job-detail__scope-chip">
            {t('memory.scopeRow.repoPrefix')}
            <code>{scope.repoId}</code>
          </span>
        )}
        {scope.includeGlobal && (
          <span className="distill-job-detail__scope-chip">{t('memory.scopeRow.global')}</span>
        )}
      </div>
      <h3 className="distill-job-detail__section-subhead">
        {t('memory.distillJobDetail.dedupSnapshotLabel')}
      </h3>
      {snapshot.length === 0 ? (
        <EmptyState size="compact" title={t('memory.distillJobDetail.noDedupSnapshot')} />
      ) : (
        <ul className="distill-job-detail__snapshot-list">
          {snapshot.map((m) => (
            <li key={m.memoryId} data-testid={`distill-dedup-row-${m.memoryId}`}>
              <span className={`memory-row__scope memory-row__scope--${m.scopeType}`}>
                {t(`memory.scope.${m.scopeType}`)}
              </span>
              <span className="distill-job-detail__snapshot-title">{m.title}</span>
              <code className="muted">{m.memoryId}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
