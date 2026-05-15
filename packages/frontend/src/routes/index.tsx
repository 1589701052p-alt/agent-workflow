// / — home route.
//
// First-run UX (P-5-10): if no agents and no workflows exist, render the
// Onboarding card; otherwise pass through to /agents. Probing happens via
// react-query (cached, so /agents reuses the same list without a refetch).

import { Navigate, createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Onboarding, useOnboardingProbe } from '@/components/Onboarding'
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
  return <Navigate to="/agents" replace />
}
