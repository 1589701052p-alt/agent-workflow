// RFC-043 T5 — lists the source events consumed by this distill job
// (clarify / review / feedback), grouped by kind. Deleted / missing
// rows render greyed out without a deep link.

import { useTranslation } from 'react-i18next'
import type { MemoryDistillSourceEventEntry } from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { groupSourceEventsByKind } from '@/lib/distill-job-detail'

interface Props {
  items: MemoryDistillSourceEventEntry[]
}

export function SourceEventsList({ items }: Props) {
  const { t } = useTranslation()
  if (items.length === 0) {
    return <EmptyState size="compact" title={t('memory.distillJobDetail.noSourceEvents')} />
  }
  const groups = groupSourceEventsByKind(items)
  return (
    <div className="distill-job-detail__source-events" data-testid="distill-source-events">
      {(['clarify', 'review', 'feedback'] as const).map((kind) =>
        groups[kind].length === 0 ? null : (
          <section key={kind} data-testid={`distill-source-events-${kind}`}>
            <h3 className="distill-job-detail__section-subhead">
              {t(`memory.sourceKind.${kind}`)} · {groups[kind].length}
            </h3>
            <ul className="distill-source-events__list">
              {groups[kind].map((e) => (
                <li
                  key={`${e.kind}-${e.id}`}
                  className={`distill-source-events__row ${e.deletedOrMissing ? 'is-missing' : ''}`}
                  data-testid={`distill-source-event-row-${e.id}`}
                >
                  {e.deletedOrMissing ? (
                    <>
                      <span className="distill-source-events__id">
                        <code>{e.id}</code>
                      </span>
                      <span className="muted">{t('memory.distillJobDetail.sourceDeleted')}</span>
                    </>
                  ) : (
                    <>
                      <a
                        href={e.deepLink}
                        className="link distill-source-events__link"
                        data-testid={`distill-source-event-link-${e.id}`}
                      >
                        {e.summary.length > 0 ? e.summary : e.id}
                      </a>
                      <code className="muted">{e.id}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  )
}
