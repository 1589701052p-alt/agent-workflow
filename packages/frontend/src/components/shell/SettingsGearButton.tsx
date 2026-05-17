// RFC-032: settings cog button in the sidebar footer row.
//
// Replaces the old "Settings" sidebar link as part of the 3-group nav redesign.
// When the user is on `/settings*` the button gets a colored ring + sets
// `aria-current="page"` so screen readers announce the active state.

import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

interface SettingsGearButtonProps {
  /** True iff `resolveActiveNav(pathname).onSettings === true`. */
  active: boolean
}

export function SettingsGearButton({ active }: SettingsGearButtonProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <button
      type="button"
      className={`settings-gear${active ? ' settings-gear--active' : ''}`}
      aria-label={t('nav.settingsIcon.label')}
      aria-current={active ? 'page' : undefined}
      title={t('nav.settingsIcon.tooltip')}
      onClick={() => {
        void navigate({ to: '/settings' })
      }}
    >
      <GearIcon />
    </button>
  )
}

function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
