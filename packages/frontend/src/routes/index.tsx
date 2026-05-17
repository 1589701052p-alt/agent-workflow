// / — home route.
//
// First-run UX (P-5-10): if no agents and no workflows exist, render the
// Onboarding card; otherwise the dashboard (`<Homepage />`) — RFC-032 PR3.
// The previous fallback redirected to /agents, which silently forced
// "Agents" to be the de-facto home page. The dashboard surfaces the
// running / waiting / recent task picture instead.

import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Onboarding, useOnboardingProbe } from '@/components/Onboarding'
import { Homepage } from '@/components/home/Homepage'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexPage,
})

function IndexPage() {
  const { t } = useTranslation()
  const probe = useOnboardingProbe()
  if (probe.isLoading) return <div className="page muted">{t('settings.loading')}</div>
  if (probe.isFirstRun) return <Onboarding />
  return <Homepage />
}
