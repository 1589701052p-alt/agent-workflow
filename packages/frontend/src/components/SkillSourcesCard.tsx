// RFC-017: Skill source folders panel on the /skills list page.
//
// Pulls `/api/skill-sources` and renders one card per registered parent
// directory. Each card shows label / path / childCount / lastScannedAt + two
// actions: Rescan (POST /:id/rescan) and Remove (DELETE /:id).
//
// Errors from Remove that carry the `skill-source-children-referenced` code
// surface their `blockers` payload as a structured list so the user can fix
// the binding before retrying.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { SkillSourceWithStats } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ConfirmButton } from '@/components/ConfirmButton'

interface SourcesResponse {
  sources: SkillSourceWithStats[]
}

interface BlockersPayload {
  blockers?: Array<{ skillName: string; byAgent: string }>
}

export function SkillSourcesCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<SourcesResponse>({
    queryKey: ['skill-sources'],
    queryFn: ({ signal }) => api.get<SourcesResponse>('/api/skill-sources', undefined, signal),
  })

  const rescan = useMutation({
    mutationFn: (id: string) => api.post(`/api/skill-sources/${id}/rescan`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/skill-sources/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      void qc.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  const sources = data?.sources ?? []
  return (
    <section className="skill-sources" aria-label={t('skills.sourcesTitle')}>
      <h2 className="skill-sources__title">{t('skills.sourcesTitle')}</h2>
      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && (
        <div className="form-actions__error">{describeError(error, t)}</div>
      )}
      {!isLoading && sources.length === 0 && (
        <div className="muted">{t('skills.sourcesEmpty')}</div>
      )}
      <ul className="skill-sources__list">
        {sources.map((s) => (
          <li key={s.id} id={`source-${s.id}`} className="skill-sources__item">
            <div className="skill-sources__head">
              <strong className="skill-sources__label">{s.label}</strong>
              <span className="skill-sources__count">
                {t('skills.sourceChildCount', { n: s.childCount })}
              </span>
            </div>
            <code className="skill-sources__path">{s.path}</code>
            <div className="skill-sources__meta">
              {s.lastScannedAt === null
                ? t('skills.sourceNeverScanned')
                : t('skills.sourceLastScannedAt', {
                    when: new Date(s.lastScannedAt).toLocaleString(),
                  })}
            </div>
            {s.skipped.length > 0 && (
              <details className="skill-sources__skipped">
                <summary>{t('skills.sourceSkippedBanner', { n: s.skipped.length })}</summary>
                <ul>
                  {s.skipped.map((sk, idx: number) => (
                    <li key={idx}>
                      <code>{sk.proposedName ?? sk.childPath}</code> — {sk.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="skill-sources__actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => rescan.mutate(s.id)}
                disabled={rescan.isPending}
              >
                {t('skills.sourceRescan')}
              </button>
              <ConfirmButton
                label={t('skills.sourceRemove')}
                confirmLabel={t('skills.sourceRemoveConfirmTitle', { label: s.label })}
                onConfirm={() => remove.mutate(s.id)}
                danger
                disabled={remove.isPending}
                size="sm"
              />
            </div>
            {remove.error !== null && remove.error !== undefined && (
              <BlockerBanner err={remove.error} t={t} />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function BlockerBanner({
  err,
  t,
}: {
  err: unknown
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  if (!(err instanceof ApiError)) return <div className="form-actions__error">{String(err)}</div>
  if (err.code !== 'skill-source-children-referenced') {
    return <div className="form-actions__error">{describeError(err, t)}</div>
  }
  const blockers = (err.details as BlockersPayload | undefined)?.blockers ?? []
  return (
    <div className="form-actions__error" role="alert">
      <div>{t('skills.sourceRemoveConfirmBlocked')}</div>
      <ul>
        {blockers.map((b, i) => (
          <li key={i}>
            <code>{b.skillName}</code> ← <code>{b.byAgent}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function describeError(e: unknown, t: (key: string) => string): string {
  if (e instanceof ApiError) return `${t('errors.fallback')}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
