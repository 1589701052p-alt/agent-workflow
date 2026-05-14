// Placeholder list page; full DataTable + drawer lands in P-1-17.

import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ResourceList } from '@/components/ResourceList'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/agents',
  component: AgentsPage,
})

function AgentsPage() {
  const { data, isLoading, error } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  return (
    <ResourceList
      title="Agents"
      placeholder="Full agent editor lands in P-1-17. This page just verifies the API/token wiring."
      items={data?.map((a) => ({ id: a.id, primary: a.name, secondary: a.description })) ?? []}
      isLoading={isLoading}
      error={error}
    />
  )
}
