// RFC-028 — render the MCP names that will be injected for this node-run.
//
// Reuses the `/api/agents/:name/closure` endpoint (which now includes each
// closure member's mcp[] — see services/routes/agents.ts T10 patch). The
// computed union is what the scheduler will actually pass to the runner
// via `loadMcpsByNames` (see services/mcpClosure.ts) — so what users see in
// the Stats tab is byte-for-byte the same set as runtime.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'

interface ClosureMember {
  name: string
  mcp?: string[]
  missing?: boolean
}

interface ClosureResponse {
  ok?: boolean
  agents?: ClosureMember[]
}

interface Props {
  agentName: string
}

export function NodeMcpClosureSection({ agentName }: Props) {
  const { t } = useTranslation()
  const closure = useQuery<ClosureResponse>({
    queryKey: ['agent-closure', agentName],
    queryFn: ({ signal }) =>
      api.get(`/api/agents/${encodeURIComponent(agentName)}/closure`, undefined, signal),
    enabled: agentName.length > 0,
    staleTime: 30_000,
    retry: false,
  })

  if (closure.isLoading) return <span className="muted">{t('common.loading')}</span>
  if (closure.error !== null && closure.error !== undefined) {
    return <span className="muted">{t('nodeDrawer.mcpClosureLoadFailed')}</span>
  }
  const list = closure.data?.agents ?? []
  // Union with first-seen order; matches services/mcpClosure.ts
  // `collectMcpNamesFromClosure` semantics exactly.
  const seen = new Set<string>()
  const names: string[] = []
  for (const a of list) {
    if (a.missing) continue
    for (const n of a.mcp ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      names.push(n)
    }
  }
  if (names.length === 0) {
    return <span className="muted">{t('nodeDrawer.mcpClosureEmpty')}</span>
  }
  return (
    <span className="chip-row" data-testid="node-mcp-closure">
      {names.map((n) => (
        <span className="chip chip--tight" key={n}>
          {n}
        </span>
      ))}
    </span>
  )
}
