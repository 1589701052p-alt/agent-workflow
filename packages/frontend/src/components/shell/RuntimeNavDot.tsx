// RFC-032: 4-state daemon status dot rendered on the right side of the
// sidebar's "Runtime" sub-item.
//
// State table:
//
//   - loading            → yellow dot, "checking…" tooltip
//   - !binary (no path)  → red dot, "opencode not found" tooltip
//   - binary, !compatible (version too old) → grey dot, "incompatible" tooltip
//   - binary, compatible → green dot, "ready vX.Y.Z" tooltip
//
// Uses an independent query key from <RuntimeStatusCard> so its refetch
// cycle does not drag Settings into a refetch storm (and vice versa).

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { RuntimeOpencodeStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'

export const RUNTIME_OPENCODE_SIDEBAR_QUERY_KEY = ['runtime', 'opencode', 'sidebar'] as const

type DotState = 'ready' | 'checking' | 'incompatible' | 'missing'

interface RuntimeNavDotPresentationProps {
  state: DotState
  /** Plain-text tooltip shown via the `title` attribute. */
  tooltip: string
}

function describe(
  t: (k: string, opts?: Record<string, unknown>) => string,
  probe: {
    isLoading: boolean
    data?: RuntimeOpencodeStatus
  },
): RuntimeNavDotPresentationProps {
  if (probe.isLoading || !probe.data) {
    return { state: 'checking', tooltip: t('nav.runtime.tooltip.checking') }
  }
  const data = probe.data
  if (data.version === null) {
    return {
      state: 'missing',
      tooltip: t('nav.runtime.tooltip.missing', { path: data.binary }),
    }
  }
  if (!data.compatible) {
    return {
      state: 'incompatible',
      tooltip: t('nav.runtime.tooltip.incompatible', {
        version: data.version,
        minVersion: data.minVersion,
      }),
    }
  }
  return {
    state: 'ready',
    tooltip: t('nav.runtime.tooltip.ready', { version: data.version }),
  }
}

export function RuntimeNavDot() {
  const { t } = useTranslation()
  const probe = useQuery<RuntimeOpencodeStatus>({
    queryKey: RUNTIME_OPENCODE_SIDEBAR_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtime/opencode', undefined, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const { state, tooltip } = describe(t, probe)
  return (
    <span
      className={`nav-runtime-dot nav-runtime-dot--${state}`}
      data-state={state}
      aria-label={tooltip}
      title={tooltip}
      role="status"
    />
  )
}

// Exposed for unit testing — lets the test pass synthesized probe results
// without spinning up react-query.
export const __test__ = { describe }
