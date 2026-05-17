// RFC-032 PR3: homepage hero.
//
// Top of the dashboard: a time-of-day greeting, the runtime status line,
// and the "Start task" primary action. The runtime status uses an
// independent query key (`['runtime','opencode','home']`) so it does
// not drag the sidebar's `RuntimeNavDot` or Settings' `RuntimeStatusCard`
// into a refetch storm.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RuntimeOpencodeStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { pickGreetingKey } from '@/lib/homepage'

export const RUNTIME_OPENCODE_HOME_QUERY_KEY = ['runtime', 'opencode', 'home'] as const

type RuntimeState = 'ready' | 'checking' | 'incompatible' | 'missing'

interface RuntimeView {
  state: RuntimeState
  text: string
}

export function HomepageGreeting() {
  const { t } = useTranslation()
  // The clock ticks roughly every minute so the greeting + relative date
  // line stays current without flooding the renderer.
  const [now, setNow] = useState<Date>(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const probe = useQuery<RuntimeOpencodeStatus>({
    queryKey: RUNTIME_OPENCODE_HOME_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtime/opencode', undefined, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const runtime = describeRuntime(t, probe)
  const greetingKey = `home.greet.${pickGreetingKey(now)}` as const

  return (
    <header className="homepage__greet">
      <div className="homepage__greet-text">
        <h1 className="homepage__greet-title">{t(greetingKey)}</h1>
        <p className="homepage__greet-runtime" data-testid="homepage-runtime">
          <span
            className={`homepage__runtime-dot homepage__runtime-dot--${runtime.state}`}
            aria-hidden="true"
          />
          <Link to="/settings" hash="runtime" className="homepage__runtime-link">
            {runtime.text}
          </Link>
        </p>
      </div>
      <Link
        to="/workflows"
        className="btn btn--primary homepage__start-task"
        data-testid="homepage-start-task"
      >
        {t('home.startTask')}
      </Link>
    </header>
  )
}

function describeRuntime(
  t: (key: string, opts?: Record<string, unknown>) => string,
  probe: {
    isLoading: boolean
    data?: RuntimeOpencodeStatus
  },
): RuntimeView {
  if (probe.isLoading || !probe.data) {
    return { state: 'checking', text: t('home.runtime.checking') }
  }
  const data = probe.data
  if (data.version === null) {
    return { state: 'missing', text: t('home.runtime.missing') }
  }
  if (!data.compatible) {
    return {
      state: 'incompatible',
      text: t('home.runtime.incompatible', {
        version: data.version,
        minVersion: data.minVersion,
      }),
    }
  }
  return { state: 'ready', text: t('home.runtime.ready', { version: data.version }) }
}

export const __test__ = { describeRuntime }
