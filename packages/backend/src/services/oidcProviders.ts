// RFC-036 — OIDC providers service. CRUD with AES-256-GCM-wrapped client
// secret at rest (via auth/secretBox), discovery probe for the /test endpoint,
// and a redacted-for-output view that never leaks the secret.

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  CreateOidcProviderBody,
  OidcProvider,
  OidcProviderPublic,
  PatchOidcProviderBody,
} from '@agent-workflow/shared'
import { OidcProviderSchema } from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { oidcProviders, userIdentities } from '@/db/schema'
import { testDiscovery as runDiscovery } from '@/auth/oidc/discovery'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type Row = typeof oidcProviders.$inferSelect

export interface OidcProvidersService {
  list(): Promise<OidcProvider[]>
  listPublic(): Promise<OidcProviderPublic[]>
  findById(id: string): Promise<OidcProvider | null>
  findBySlug(slug: string): Promise<OidcProvider | null>
  /** Returns the *raw* client_secret value — only call from token-exchange code paths. */
  resolveClientSecret(id: string): Promise<string | null>
  create(body: CreateOidcProviderBody, now?: number): Promise<OidcProvider>
  patch(id: string, body: PatchOidcProviderBody, now?: number): Promise<OidcProvider>
  remove(id: string, force?: boolean): Promise<void>
  testDiscovery(issuerUrl: string): ReturnType<typeof runDiscovery>
}

export function createOidcProvidersService(deps: {
  db: DbClient
  secretBox: SecretBox
}): OidcProvidersService {
  const { db, secretBox } = deps

  function materialize(row: Row): OidcProvider {
    return OidcProviderSchema.parse({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      scopes: row.scopes,
      provisioning: row.provisioning,
      allowedEmailDomains: safeJson<string[]>(row.allowedEmailDomainsJson) ?? [],
      iconUrl: row.iconUrl,
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  return {
    async list() {
      const rows = await db.select().from(oidcProviders)
      return rows.map(materialize)
    },
    async listPublic() {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true))
      return rows.map((r) => ({ slug: r.slug, displayName: r.displayName, iconUrl: r.iconUrl }))
    },
    async findById(id) {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
      return rows[0] ? materialize(rows[0]) : null
    },
    async findBySlug(slug) {
      const rows = await db
        .select()
        .from(oidcProviders)
        .where(eq(oidcProviders.slug, slug))
        .limit(1)
      return rows[0] ? materialize(rows[0]) : null
    },
    async resolveClientSecret(id) {
      const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id)).limit(1)
      if (!rows[0]) return null
      return secretBox.unseal(rows[0].clientSecretEnc)
    },
    async create(body, now = Date.now()) {
      const existing = await this.findBySlug(body.slug)
      if (existing) {
        throw new ConflictError('oidc-slug-taken', `slug '${body.slug}' already exists`)
      }
      const id = ulid()
      await db.insert(oidcProviders).values({
        id,
        slug: body.slug,
        displayName: body.displayName,
        issuerUrl: body.issuerUrl,
        clientId: body.clientId,
        clientSecretEnc: secretBox.seal(body.clientSecret),
        scopes: body.scopes,
        provisioning: body.provisioning,
        allowedEmailDomainsJson: JSON.stringify(body.allowedEmailDomains ?? []),
        iconUrl: body.iconUrl,
        enabled: body.enabled,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      })
      return (await this.findById(id))!
    },
    async patch(id, body, now = Date.now()) {
      const cur = await this.findById(id)
      if (!cur) throw new NotFoundError('oidc-provider-not-found', `provider ${id} not found`)
      const updates: Partial<typeof oidcProviders.$inferInsert> = { updatedAt: now }
      if (body.slug !== undefined && body.slug !== cur.slug) {
        const dup = await this.findBySlug(body.slug)
        if (dup) throw new ConflictError('oidc-slug-taken', `slug '${body.slug}' already exists`)
        updates.slug = body.slug
      }
      if (body.displayName !== undefined) updates.displayName = body.displayName
      if (body.issuerUrl !== undefined) updates.issuerUrl = body.issuerUrl
      if (body.clientId !== undefined) updates.clientId = body.clientId
      if (body.scopes !== undefined) updates.scopes = body.scopes
      if (body.provisioning !== undefined) updates.provisioning = body.provisioning
      if (body.allowedEmailDomains !== undefined) {
        updates.allowedEmailDomainsJson = JSON.stringify(body.allowedEmailDomains)
      }
      if (body.iconUrl !== undefined) updates.iconUrl = body.iconUrl
      if (body.enabled !== undefined) updates.enabled = body.enabled
      // Empty clientSecret in PATCH = keep existing; non-empty = re-seal.
      if (typeof body.clientSecret === 'string' && body.clientSecret.length > 0) {
        updates.clientSecretEnc = secretBox.seal(body.clientSecret)
      }
      await db.update(oidcProviders).set(updates).where(eq(oidcProviders.id, id))
      return (await this.findById(id))!
    },
    async remove(id, force = false) {
      const cur = await this.findById(id)
      if (!cur) throw new NotFoundError('oidc-provider-not-found', `provider ${id} not found`)
      const ids = await db
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.providerId, id))
        .limit(1)
      if (ids.length > 0 && !force) {
        throw new ConflictError(
          'provider-still-linked',
          'one or more users still have identities linked to this provider',
        )
      }
      if (force) {
        // Caller asked for cascade. SQLite ON DELETE RESTRICT on
        // user_identities.provider_id will block; remove identity rows first.
        await db.delete(userIdentities).where(eq(userIdentities.providerId, id))
      }
      await db.delete(oidcProviders).where(eq(oidcProviders.id, id))
    },
    testDiscovery(issuerUrl) {
      if (!/^https?:\/\//.test(issuerUrl)) {
        return Promise.resolve({ ok: false, error: 'bad-issuer-url' } as const)
      }
      return runDiscovery(issuerUrl)
    },
  }
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Redact a provider for API output — drops the encrypted secret. */
export function redactedProvider(p: OidcProvider): OidcProvider & { clientSecret: '***' } {
  // Schema doesn't include clientSecret; we still emit a sentinel so the UI
  // form can show "(hidden — enter a new value to overwrite)".
  return { ...p, clientSecret: '***' as const }
}

export { ValidationError as OidcValidationError }
