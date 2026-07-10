// RFC-151 PR-3 — the resource list pages' name cell, single-sourced.
//
// Byte-equivalent to the cell previously copy-pasted across the resource
// lists: `<td class="data-table__nowrap">` hosting the detail link, the
// RFC-099 private-visibility chip and the owner badge. Locked structurally
// by agents/mcps-list-cell-wrapping tests (nowrap keeps rows single-line and
// scan-friendly; ellipsis clipping is defined on .data-table__nowrap).
//
// /skills keeps its bespoke name cell: its fixed-layout table nests the link
// in a flex `.skills__name-cell__inner` wrapper together with a source pill
// (see skills-list-cell-wrapping.test.ts) — forcing that shape in here would
// bloat the shared cell for one page.

import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ResourceVisibility, UserPublic } from '@agent-workflow/shared'

/** Structural slice of `useUserLookup`'s return — the page-level batch
 *  lookup is created once per page and threaded into every row's cell. */
export interface OwnerLookup {
  get: (id: string | null | undefined) => UserPublic | undefined
}

export interface ResourceNameCellProps {
  /** Detail route of the resource kind (constrained to the resource list pages). */
  to:
    | '/agents/$name'
    | '/skills/$name'
    | '/mcps/$name'
    | '/plugins/$id'
    | '/workflows/$id'
    | '/workgroups/$name'
  params: { name: string } | { id: string }
  name: string
  visibility?: ResourceVisibility | undefined
  ownerUserId?: string | null | undefined
  owners: OwnerLookup
  /** Optional hover title on the link (long names under fixed layouts). */
  title?: string | undefined
}

export function ResourceNameCell(props: ResourceNameCellProps) {
  const { t } = useTranslation()
  return (
    <td className="data-table__nowrap">
      <Link to={props.to} params={props.params} className="data-table__link" title={props.title}>
        {props.name}
      </Link>
      {props.visibility === 'private' && (
        <span className="chip chip--tight">{t('acl.privateChip')}</span>
      )}
      {props.ownerUserId != null && props.owners.get(props.ownerUserId) !== undefined && (
        <span className="muted data-table__owner" title={t('acl.ownerBadge')}>
          {props.owners.get(props.ownerUserId)?.displayName}
        </span>
      )}
    </td>
  )
}
