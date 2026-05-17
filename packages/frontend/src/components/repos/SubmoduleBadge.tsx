// RFC-034 — small chip rendered next to each cached_repos row to advertise
// whether the parent repo has submodules and whether the latest sync/init
// pass succeeded.

import { useTranslation } from 'react-i18next'

export interface SubmoduleBadgeProps {
  /** `null` when never probed; boolean once probed. */
  hasSubmodules: boolean | null
  /** `null` when never attempted; boolean otherwise. */
  lastSubmoduleSyncOk: boolean | null
  /** Pre-redacted stderr from the last failed pass. */
  lastSubmoduleSyncError: string | null
}

export function SubmoduleBadge({
  hasSubmodules,
  lastSubmoduleSyncOk,
  lastSubmoduleSyncError,
}: SubmoduleBadgeProps) {
  const { t } = useTranslation()
  if (hasSubmodules === null) {
    // Legacy row — never probed.
    return null
  }
  if (hasSubmodules === false) {
    return null
  }
  if (lastSubmoduleSyncOk === false) {
    return (
      <span
        className="submodule-badge submodule-badge--error"
        title={lastSubmoduleSyncError ?? t('repos.submodule.errorFallback')}
        data-testid="submodule-badge-error"
      >
        {t('repos.submodule.labelError')}
      </span>
    )
  }
  return (
    <span
      className="submodule-badge submodule-badge--ok"
      title={t('repos.submodule.titleOk')}
      data-testid="submodule-badge-ok"
    >
      {t('repos.submodule.labelOk')}
    </span>
  )
}
