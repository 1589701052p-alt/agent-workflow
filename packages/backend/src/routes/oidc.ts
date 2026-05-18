// RFC-036 — admin-only /api/oidc/providers CRUD + /test endpoint.

import type { Hono } from 'hono'
import { CreateOidcProviderBodySchema, PatchOidcProviderBodySchema } from '@agent-workflow/shared'
import { requirePermission } from '@/auth/permissions'
import { createOidcProvidersService, redactedProvider } from '@/services/oidcProviders'
import type { AppDeps } from '@/server'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountOidcRoutes(app: Hono, deps: AppDeps): void {
  if (!deps.secretBox) {
    // OIDC requires the secret box. Without it, mounting these routes would
    // panic on first DB write. Skip silently for non-OIDC tests.
    return
  }
  const svc = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })

  app.get('/api/oidc/providers', requirePermission('oidc:read'), async (c) => {
    const list = await svc.list()
    return c.json(list.map(redactedProvider))
  })

  app.get('/api/oidc/providers/:id', requirePermission('oidc:read'), async (c) => {
    const p = await svc.findById(c.req.param('id'))
    if (!p) throw new NotFoundError('oidc-provider-not-found', 'provider not found')
    return c.json(redactedProvider(p))
  })

  app.post('/api/oidc/providers', requirePermission('oidc:configure'), async (c) => {
    const parsed = CreateOidcProviderBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('oidc-provider-invalid', 'invalid OIDC provider payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await svc.create(parsed.data)
    return c.json(redactedProvider(created), 201)
  })

  app.patch('/api/oidc/providers/:id', requirePermission('oidc:configure'), async (c) => {
    const parsed = PatchOidcProviderBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('oidc-provider-invalid', 'invalid OIDC provider patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await svc.patch(c.req.param('id'), parsed.data)
    return c.json(redactedProvider(updated))
  })

  app.delete('/api/oidc/providers/:id', requirePermission('oidc:configure'), async (c) => {
    const force = c.req.query('force') === 'true'
    await svc.remove(c.req.param('id'), force)
    return c.body(null, 204)
  })

  app.post('/api/oidc/providers/:id/test', requirePermission('oidc:configure'), async (c) => {
    const p = await svc.findById(c.req.param('id'))
    if (!p) throw new NotFoundError('oidc-provider-not-found', 'provider not found')
    const result = await svc.testDiscovery(p.issuerUrl)
    if (!result.ok) return c.json({ ok: false, error: result.error }, 422)
    return c.json({
      ok: true,
      issuer: result.metadata.issuer,
      authorizationEndpoint: result.metadata.authorization_endpoint,
      tokenEndpoint: result.metadata.token_endpoint,
      jwksUri: result.metadata.jwks_uri,
      scopesSupported: result.metadata.scopes_supported ?? [],
    })
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
