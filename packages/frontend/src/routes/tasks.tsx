import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import type { TaskSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ResourceList } from '@/components/ResourceList'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks',
  component: TasksPage,
})

function TasksPage() {
  const { data, isLoading, error } = useQuery<TaskSummary[]>({
    queryKey: ['tasks'],
    queryFn: ({ signal }) => api.get('/api/tasks', undefined, signal),
    refetchInterval: 4000,
  })

  return (
    <ResourceList
      title="Tasks"
      placeholder="Task detail / diff view lands in P-1-18."
      items={
        data?.map((t) => ({
          id: t.id,
          primary: t.id,
          secondary: `${t.status} · ${t.repoPath}`,
        })) ?? []
      }
      isLoading={isLoading}
      error={error}
    />
  )
}
