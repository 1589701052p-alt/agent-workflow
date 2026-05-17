// RFC-036 — OIDC provider zod schemas. Admins CRUD providers in
// /settings → Authentication; framework runs the standard OIDC Authorization
// Code + PKCE flow against each enabled provider.

import { z } from 'zod'

export const ProvisioningSchema = z.enum(['auto', 'allowlist', 'invite'])
export type ProvisioningPolicy = z.infer<typeof ProvisioningSchema>

export const PROVIDER_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/
export const EMAIL_DOMAIN_REGEX = /^@[a-z0-9.-]+$/i

export const OidcProviderSchema = z.object({
  id: z.string(),
  slug: z.string().min(1).max(64).regex(PROVIDER_SLUG_REGEX),
  displayName: z.string().min(1).max(128),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1).max(256),
  scopes: z.string().min(1).max(512),
  provisioning: ProvisioningSchema,
  allowedEmailDomains: z.array(z.string().regex(EMAIL_DOMAIN_REGEX)).default([]),
  iconUrl: z.string().url().nullable(),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export type OidcProvider = z.infer<typeof OidcProviderSchema>

/** Public response — login page lists enabled providers without leaking config. */
export const OidcProviderPublicSchema = OidcProviderSchema.pick({
  slug: true,
  displayName: true,
  iconUrl: true,
})

export type OidcProviderPublic = z.infer<typeof OidcProviderPublicSchema>

export const CreateOidcProviderBodySchema = OidcProviderSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  clientSecret: z.string().min(1).max(1024),
})

export type CreateOidcProviderBody = z.infer<typeof CreateOidcProviderBodySchema>

export const PatchOidcProviderBodySchema = CreateOidcProviderBodySchema.partial()

export type PatchOidcProviderBody = z.infer<typeof PatchOidcProviderBodySchema>
