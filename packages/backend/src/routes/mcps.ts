// MCP HTTP routes (RFC-028).
// GET    /api/mcps             — list
// GET    /api/mcps/:name       — one
// POST   /api/mcps             — create
// PUT    /api/mcps/:name       — update (subset of fields; type immutable)
// DELETE /api/mcps/:name       — delete (refuses if referenced)
// POST   /api/mcps/:name/rename — rename (cascades into agents.mcp arrays)

import { CreateMcpSchema, RenameMcpSchema, UpdateMcpSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { createMcp, deleteMcp, getMcp, listMcps, renameMcp, updateMcp } from '@/services/mcp'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/mcps', async (c) => {
    const list = await listMcps(deps.db)
    return c.json(list)
  })

  app.get('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const mcp = await getMcp(deps.db, name)
    if (mcp === null) {
      throw new NotFoundError('mcp-not-found', `mcp '${name}' not found`)
    }
    return c.json(mcp)
  })

  app.post('/api/mcps', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createMcp(deps.db, parsed.data)
    return c.json(created, 201)
  })

  app.put('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await updateMcp(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    await deleteMcp(deps.db, name)
    return c.body(null, 204)
  })

  app.post('/api/mcps/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const renamed = await renameMcp(deps.db, name, parsed.data)
    return c.json(renamed)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
