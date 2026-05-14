// Code-based TanStack Router tree. M1 keeps it small — file-based routing
// is overkill until the workflow editor (M2) adds nested layouts.

import { createRouter } from '@tanstack/react-router'
import { Route as agentsRoute } from '@/routes/agents'
import { Route as authRoute } from '@/routes/auth'
import { Route as indexRoute } from '@/routes/index'
import { Route as rootRoute } from '@/routes/__root'
import { Route as settingsRoute } from '@/routes/settings'
import { Route as skillsRoute } from '@/routes/skills'
import { Route as tasksRoute } from '@/routes/tasks'
import { Route as workflowsRoute } from '@/routes/workflows'

const routeTree = rootRoute.addChildren([
  indexRoute,
  authRoute,
  agentsRoute,
  skillsRoute,
  workflowsRoute,
  tasksRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
