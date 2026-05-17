// RFC-032: navigation data model + active-state resolver.
//
// `NAV_GROUPS` is the source of truth for the three sidebar groups (agents /
// workflows / tasks). `resolveActiveNav` is a pure function so unit tests can
// exhaustively cover every route → group mapping without spinning up a router.

export type GroupKey = 'agents' | 'workflows' | 'tasks'

export interface SubNavItem {
  to: string
  i18nKey: string
  /**
   * `'capability'` items render visually adjacent. `'runtime'` items get a thin
   * separator above them so the user reads them as a different category
   * ("compute" vs "capabilities").
   */
  variant?: 'capability' | 'runtime'
}

export interface NavGroupEntry {
  key: GroupKey
  i18nKey: string
  subnav: SubNavItem[]
}

/**
 * PR1 of RFC-032 keeps `/reviews` and `/clarify` parked under the workflows
 * group as visible sub-items so users can still reach them while the inbox
 * footer button + drawer (PR2) are not yet in place. PR2 removes these two
 * entries and lifts them into the inbox drawer.
 */
export const NAV_GROUPS: NavGroupEntry[] = [
  {
    key: 'agents',
    i18nKey: 'nav.group.agents',
    subnav: [
      { to: '/agents', i18nKey: 'nav.agents', variant: 'capability' },
      { to: '/skills', i18nKey: 'nav.skills', variant: 'capability' },
      { to: '/mcps', i18nKey: 'nav.mcps', variant: 'capability' },
      { to: '/plugins', i18nKey: 'nav.plugins', variant: 'capability' },
      { to: '/runtime', i18nKey: 'nav.runtime.label', variant: 'runtime' },
    ],
  },
  {
    key: 'workflows',
    i18nKey: 'nav.group.workflows',
    subnav: [
      { to: '/workflows', i18nKey: 'nav.workflows' },
      // PR1 placeholders — removed in PR2 once the inbox drawer ships.
      { to: '/reviews', i18nKey: 'nav.reviews' },
      { to: '/clarify', i18nKey: 'nav.clarify' },
    ],
  },
  {
    key: 'tasks',
    i18nKey: 'nav.group.tasks',
    subnav: [
      { to: '/tasks', i18nKey: 'nav.tasks' },
      { to: '/repos', i18nKey: 'nav.repos' },
    ],
  },
]

export interface ActiveNav {
  /** True iff the user is on `/` (the homepage). */
  onHome: boolean
  /** True iff the user is on `/settings*`. Used to highlight the footer gear. */
  onSettings: boolean
  /** Group that owns the current path; `null` when on home / settings / unknown. */
  activeGroup: GroupKey | null
  /** The `to` of the matched sub-item, or `null` if no sub-item matches. */
  activeItemTo: string | null
}

/**
 * Map `location.pathname` to an active-state record consumed by the shell.
 *
 * Special cases:
 * - `/` → `onHome:true`; everything else false/null.
 * - `/settings` / `/settings/*` → `onSettings:true`; nav stays inactive (the
 *   footer gear is what gets highlighted).
 * - `/reviews*` / `/clarify*` → during PR1 these *are* visible sub-items under
 *   the workflows group, so they take the workflows group active. PR2 removes
 *   them from `NAV_GROUPS`; this resolver keeps the explicit fallback so
 *   `activeGroup` still maps to `'workflows'` for detail-page deep links.
 * - `/runtime` is a pseudo-URL that exists in `NAV_GROUPS` only as a click
 *   target. The `<NavItem>` for it navigates to `/settings#runtime`, after
 *   which `onSettings` flips true (and `activeGroup` becomes `null`).
 */
export function resolveActiveNav(pathname: string): ActiveNav {
  if (pathname === '/') {
    return { onHome: true, onSettings: false, activeGroup: null, activeItemTo: null }
  }
  if (pathname === '/settings' || pathname.startsWith('/settings/')) {
    return { onHome: false, onSettings: true, activeGroup: null, activeItemTo: null }
  }
  for (const g of NAV_GROUPS) {
    for (const sub of g.subnav) {
      if (pathname === sub.to || pathname.startsWith(sub.to + '/')) {
        return {
          onHome: false,
          onSettings: false,
          activeGroup: g.key,
          activeItemTo: sub.to,
        }
      }
    }
  }
  // Detail-route fallbacks for paths not enumerated in NAV_GROUPS.
  if (pathname.startsWith('/reviews') || pathname.startsWith('/clarify')) {
    return { onHome: false, onSettings: false, activeGroup: 'workflows', activeItemTo: null }
  }
  return { onHome: false, onSettings: false, activeGroup: null, activeItemTo: null }
}
