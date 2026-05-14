import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import type { Skill } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ResourceList } from '@/components/ResourceList'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills',
  component: SkillsPage,
})

function SkillsPage() {
  const { data, isLoading, error } = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
  })

  return (
    <ResourceList
      title="Skills"
      placeholder="Skill editor + file tree lands in P-1-17."
      items={
        data?.map((s) => ({
          id: s.name,
          primary: s.name,
          secondary: `${s.sourceKind} · ${s.description}`,
        })) ?? []
      }
      isLoading={isLoading}
      error={error}
    />
  )
}
