// GET    /api/workflows               list
// GET    /api/workflows/:id            one
// POST   /api/workflows                create
// PUT    /api/workflows/:id            update (version+1)
// DELETE /api/workflows/:id            delete (refuses when running task references)
// POST   /api/workflows/:id/validate   M1 stub returning { ok:true, issues:[] }
//
// YAML import/export endpoints land in P-4-08.

import { CreateWorkflowSchema, UpdateWorkflowSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  validateWorkflow,
} from '@/services/workflow'
import { exportWorkflowYaml, importWorkflowYaml } from '@/services/workflow.yaml'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountWorkflowRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/workflows', async (c) => c.json(await listWorkflows(deps.db)))

  app.get('/api/workflows/:id', async (c) => {
    const id = c.req.param('id')
    const wf = await getWorkflow(deps.db, id)
    if (wf === null) {
      throw new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
    }
    return c.json(wf)
  })

  app.post('/api/workflows', async (c) => {
    const parsed = CreateWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-invalid', 'invalid workflow payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createWorkflow(deps.db, parsed.data)
    return c.json(created, 201)
  })

  app.put('/api/workflows/:id', async (c) => {
    const id = c.req.param('id')
    const parsed = UpdateWorkflowSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('workflow-invalid', 'invalid workflow patch', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await updateWorkflow(deps.db, id, parsed.data))
  })

  app.delete('/api/workflows/:id', async (c) => {
    await deleteWorkflow(deps.db, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/workflows/:id/validate', async (c) =>
    c.json(await validateWorkflow(deps.db, c.req.param('id'))),
  )

  // P-4-08: YAML export / import.
  app.get('/api/workflows/:id/export', async (c) => {
    const yaml = await exportWorkflowYaml(deps.db, c.req.param('id'))
    return c.body(yaml, 200, {
      'content-type': 'application/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${c.req.param('id')}.yaml"`,
    })
  })

  app.post('/api/workflows/import', async (c) => {
    const body = await c.req.text()
    if (body.length === 0) {
      throw new ValidationError('workflow-yaml-empty', 'empty YAML body')
    }
    const onConflictRaw = c.req.query('onConflict')
    const onConflict =
      onConflictRaw === 'overwrite' || onConflictRaw === 'new' || onConflictRaw === 'fail'
        ? onConflictRaw
        : 'fail'
    const wf = await importWorkflowYaml(deps.db, body, { onConflict })
    return c.json(wf, 201)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
