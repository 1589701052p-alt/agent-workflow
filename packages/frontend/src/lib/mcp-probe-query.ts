// RFC-030 — TanStack hooks for the /api/mcps/.../probe endpoints.
//
// useMcpProbes()           — list, used on /mcps page
// useMcpProbe(name)        — single, used on /mcps/$name page
// useProbeMcpMutation(name) — POST trigger; invalidates both query keys
//
// All three live in a sibling file so the page + detail + panel components
// share the same cache keys (otherwise we'd race two probes against one
// fresh result).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { McpProbe } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'

export const MCP_PROBES_KEY = ['mcps', 'probes'] as const
export const mcpProbeKey = (name: string): readonly unknown[] => ['mcps', name, 'probe']

export function useMcpProbes() {
  return useQuery<McpProbe[]>({
    queryKey: MCP_PROBES_KEY,
    queryFn: ({ signal }) => api.get<McpProbe[]>('/api/mcps/probes', undefined, signal),
  })
}

/**
 * Returns the probe for a given mcp. A 404 `probe-not-found` is mapped to
 * `null` so the detail page can render "never probed" without an error
 * banner — but `mcp-not-found` still surfaces as an error (that's a real
 * data integrity problem the page should show).
 */
export function useMcpProbe(name: string) {
  return useQuery<McpProbe | null>({
    queryKey: mcpProbeKey(name),
    queryFn: async ({ signal }) => {
      try {
        return await api.get<McpProbe>(
          `/api/mcps/${encodeURIComponent(name)}/probe`,
          undefined,
          signal,
        )
      } catch (e) {
        if (e instanceof ApiError && e.code === 'probe-not-found') return null
        throw e
      }
    },
  })
}

export function useProbeMcpMutation(name: string) {
  const qc = useQueryClient()
  return useMutation<McpProbe, Error, void>({
    mutationFn: () => api.post<McpProbe>(`/api/mcps/${encodeURIComponent(name)}/probe`, undefined),
    onSuccess: (probe) => {
      qc.setQueryData(mcpProbeKey(name), probe)
      void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
    },
  })
}
