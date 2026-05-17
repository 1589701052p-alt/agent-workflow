// RFC-024 — management surface for `cached_repos` (the persistent mirrors of
// remote Git URLs the user has launched tasks against).
//
// GET    /api/cached-repos              list all
// POST   /api/cached-repos/:id/refresh  manual `git fetch --all --prune --tags`
// DELETE /api/cached-repos/:id?force=1  remove cache dir + DB row (force=1 skips
//                                       the "referenced by N tasks" guard)

import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  CachedRepoHasReferencesError,
  deleteCachedRepo,
  listCachedRepos,
  refreshCachedRepo,
} from '@/services/gitRepoCache'

export function mountCachedRepoRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/cached-repos', async (c) => {
    const items = await listCachedRepos(deps.db)
    return c.json({ items })
  })

  app.post('/api/cached-repos/:id/refresh', async (c) => {
    const id = c.req.param('id')
    const r = await refreshCachedRepo({ db: deps.db }, id)
    return c.json(r)
  })

  app.delete('/api/cached-repos/:id', async (c) => {
    const id = c.req.param('id')
    const force = c.req.query('force')
    const isForce = force === '1' || force === 'true'
    try {
      const r = await deleteCachedRepo({ db: deps.db }, id, { force: isForce })
      return c.json({ ok: true, deletedLocalPath: r.deletedLocalPath })
    } catch (err) {
      if (err instanceof CachedRepoHasReferencesError) {
        // Re-throw so the central errorHandler renders the 409 with details
        // (count + urlRedacted). Default Hono handler picks up status/code/details.
        throw err
      }
      throw err
    }
  })
}
