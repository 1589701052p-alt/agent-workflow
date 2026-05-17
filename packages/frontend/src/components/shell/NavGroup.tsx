// RFC-032: one of the three sidebar nav groups (Agents / Workflows / Tasks).
//
// Each group renders an 11-px uppercase header + a chevron placeholder (no
// collapse behaviour in v1; the chevron is a pure visual anchor so the user
// reads the section as a folded unit) and the group's sub-items underneath.
//
// `runtime`-variant sub-items get a separator above them and embed the
// `<RuntimeNavDot>` daemon status indicator on the right.

import type { ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { ActiveNav, NavGroupEntry, SubNavItem } from '@/lib/nav'
import { RuntimeNavDot } from './RuntimeNavDot'

interface NavGroupProps {
  group: NavGroupEntry
  active: ActiveNav
  /** Optional badge factory (PR1 passes `null`; reviews/clarify get badges via the inline placeholder until PR2 lifts them into the inbox). */
  renderBadge?: (item: SubNavItem) => ReactNode
}

export function NavGroup({ group, active, renderBadge }: NavGroupProps) {
  const { t } = useTranslation()
  return (
    <div className="nav-group" data-group={group.key}>
      <div className="nav-group__header">
        <span>{t(group.i18nKey)}</span>
        <span className="nav-group__chevron" aria-hidden="true">
          ▾
        </span>
      </div>
      <div className="nav-group__items">
        {group.subnav.map((item) => (
          <NavItem
            key={item.to}
            item={item}
            isActive={active.activeItemTo === item.to}
            badge={renderBadge ? renderBadge(item) : null}
          />
        ))}
      </div>
    </div>
  )
}

interface NavItemProps {
  item: SubNavItem
  isActive: boolean
  badge: ReactNode
}

function NavItem({ item, isActive, badge }: NavItemProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const className = [
    'nav-item',
    item.variant === 'runtime' ? 'nav-item--runtime' : null,
    isActive ? 'nav-item--active' : null,
  ]
    .filter(Boolean)
    .join(' ')

  // The /runtime pseudo-URL is a click target only; intercept the navigation
  // and route the user to /settings#runtime where the runtime card lives.
  if (item.to === '/runtime') {
    return (
      <button
        type="button"
        className={className}
        onClick={() => {
          void navigate({ to: '/settings', hash: 'runtime' })
        }}
      >
        <span className="nav-item__label">{t(item.i18nKey)}</span>
        <RuntimeNavDot />
      </button>
    )
  }

  return (
    <Link
      to={item.to}
      className={className}
      activeProps={{ className: `${className} nav-item--active` }}
    >
      <span className="nav-item__label">{t(item.i18nKey)}</span>
      {badge}
    </Link>
  )
}
