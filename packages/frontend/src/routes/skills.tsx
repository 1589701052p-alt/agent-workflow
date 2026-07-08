// Skills list page.

import { useQuery } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Skill, SkillSourceWithStats } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { ConfirmButton } from '@/components/ConfirmButton'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { SkillSourcesCard } from '@/components/SkillSourcesCard'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills',
  component: SkillsPage,
})

function SkillsPage() {
  const { t } = useTranslation()
  // RFC-151 PR-3 — shared list shell: query + delete mutation + owner lookup.
  // The name cell itself stays bespoke (flex inner wrapper + source pill,
  // locked by skills-list-cell-wrapping.test.ts), so only the hook applies.
  const { data, isLoading, error, del, owners } = useResourceList<Skill>({
    queryKey: ['skills'],
    endpoint: '/api/skills',
    deleteBy: 'name',
  })
  const sourceListQuery = useQuery<{ sources: SkillSourceWithStats[] }>({
    queryKey: ['skill-sources'],
    queryFn: ({ signal }) => api.get('/api/skill-sources', undefined, signal),
  })
  const labelById = new Map<string, string>(
    (sourceListQuery.data?.sources ?? []).map((s) => [s.id, s.label]),
  )

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('skills.title')}</h1>
        </div>
        <Link to="/skills/new" className="btn btn--primary">
          {t('skills.newButton')}
        </Link>
      </header>

      {isLoading && <LoadingState data-testid="skills-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('skills.emptyList')} data-testid="skills-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '260px' }} />
            <col style={{ width: '110px' }} />
            <col />
            <col style={{ width: '20%' }} />
            <col style={{ width: '140px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t('skills.colName')}</th>
              <th>{t('skills.colSource')}</th>
              <th>{t('skills.colDescription')}</th>
              <th>{t('skills.colPath')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td className="data-table__nowrap">
                  <div className="skills__name-cell__inner">
                    <Link
                      to="/skills/$name"
                      params={{ name: s.name }}
                      className="data-table__link skills__name-link"
                      title={s.name}
                    >
                      {s.name}
                    </Link>
                    {s.visibility === 'private' && (
                      <span className="chip chip--tight">{t('acl.privateChip')}</span>
                    )}
                    {s.ownerUserId != null && owners.get(s.ownerUserId) !== undefined && (
                      <span className="muted data-table__owner" title={t('acl.ownerBadge')}>
                        {owners.get(s.ownerUserId)?.displayName}
                      </span>
                    )}
                    {s.sourceId !== undefined && (
                      <a
                        href={`#source-${s.sourceId}`}
                        className="source-pill"
                        data-testid="source-pill"
                      >
                        {t('skills.sourceFromPill', {
                          label: labelById.get(s.sourceId) ?? s.sourceId,
                        })}
                      </a>
                    )}
                  </div>
                </td>
                <td>
                  <span className={`chip chip--tight chip--${s.sourceKind}`}>
                    {t(s.sourceKind === 'managed' ? 'skills.tabManaged' : 'skills.tabExternal')}
                  </span>
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={s.description || undefined}
                >
                  {s.description || t('common.emDash')}
                </td>
                <td
                  className="data-table__muted data-table__truncate"
                  title={s.managedPath ?? s.externalPath ?? undefined}
                >
                  <code>{s.managedPath ?? s.externalPath ?? t('common.emDash')}</code>
                </td>
                <td className="data-table__actions">
                  <Link to="/skills/$name" params={{ name: s.name }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('common.delete')}
                    onConfirm={() => del.mutateAsync(s)}
                    variant="danger"
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <SkillSourcesCard />
    </div>
  )
}
