// RFC-168 — the agents-list query with a defensive ARRAY projection.
//
// The workgroup studio consumes /api/agents on page load (gallery port
// summaries, panel capability card, add-member datalist). A malformed
// response (proxy error page, wrong shape) must degrade the summaries — not
// crash the whole route with `.map is not a function` (caught by the
// workgroup-launch-page test's minimal fetch stub, which served `{}`).
//
// Scope note: the other ['agents'] consumers keep their local useQuery calls
// for now — unifying all twelve is a dedup-audit follow-up, not RFC-168.

import { useQuery } from '@tanstack/react-query'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'

export interface AgentsList {
  agents: Agent[]
  /** True only when the query succeeded AND the payload was a real array —
   *  gates "agent not found" warnings so a degraded response never flags
   *  every member as dangling. */
  loaded: boolean
}

export function useAgentsList(opts?: { enabled?: boolean }): AgentsList {
  const q = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    enabled: opts?.enabled ?? true,
  })
  const isArray = Array.isArray(q.data)
  return {
    agents: isArray ? (q.data as Agent[]) : [],
    loaded: q.isSuccess && isArray,
  }
}
