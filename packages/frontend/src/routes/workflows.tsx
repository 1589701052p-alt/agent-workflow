import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import type { Workflow } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ResourceList } from '@/components/ResourceList'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
})

function WorkflowsPage() {
  const { data, isLoading, error } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })

  return (
    <ResourceList
      title="Workflows"
      placeholder="xyflow canvas lands in M2 (P-2-02+)."
      items={
        data?.map((w) => ({
          id: w.id,
          primary: w.name,
          secondary: `v${w.version} · ${w.id}`,
        })) ?? []
      }
      isLoading={isLoading}
      error={error}
    />
  )
}
