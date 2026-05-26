// RFC-024 — single-repo segmented Local Path / Remote URL picker.
//
// RFC-066 PR-C — the body markup was extracted into `RepoSourceRow.tsx` so
// the new `<RepoSourceList>` container can stamp N rows side-by-side with
// `+ Add` / `− Remove` controls. This file kept as the back-compat shim
// for callers that still take a single `RepoSource` (notably the
// pre-RFC-066 fixture surface in tests/launch-repo-source.test.ts,
// repo-source-tabs-field-parity.test.ts, tabs-retrofit-grep.test.ts).
//
// Single-repo render is byte-baseline with pre-RFC-066: `showRemove=false`,
// no preview chip, no auto-suffix logic — exactly the same Field layout the
// single-source launcher produced before.

import { useTranslation } from 'react-i18next'
import { RepoSourceRow } from '@/components/launch/RepoSourceRow'
import type { RepoSource } from '@/lib/launch-repo-source'

export interface RepoSourceTabsProps {
  source: RepoSource
  onChange: (next: RepoSource) => void
}

export function RepoSourceTabs({ source, onChange }: RepoSourceTabsProps) {
  // useTranslation kept loaded here so any future label/banner work in the
  // single-source shim (e.g. an aria-label change at the top wrapper) lands
  // in this file without reaching back into RepoSourceRow.
  useTranslation()
  return (
    <div className="repo-source-tabs">
      <RepoSourceRow source={source} onChange={onChange} />
    </div>
  )
}
