// RFC-036 — OIDC discovery + JWKS fetcher with an in-memory LRU cache (TTL 1h
// per design.md §5.3). Pure HTTP; no DB writes.

import { createRemoteJWKSet, type JSONWebKeySet } from 'jose'

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  scopes_supported?: string[]
  userinfo_endpoint?: string
  end_session_endpoint?: string
}

interface CacheEntry {
  metadata: OidcMetadata
  jwks: ReturnType<typeof createRemoteJWKSet>
  fetchedAt: number
}

const TTL_MS = 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export function clearDiscoveryCache(): void {
  cache.clear()
}

export async function getProviderMetadata(
  issuerUrl: string,
  now: number = Date.now(),
  fetcher: typeof fetch = globalThis.fetch,
): Promise<CacheEntry> {
  const hit = cache.get(issuerUrl)
  if (hit && now - hit.fetchedAt < TTL_MS) return hit
  const metadata = await fetchDiscovery(issuerUrl, fetcher)
  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri))
  const entry: CacheEntry = { metadata, jwks, fetchedAt: now }
  cache.set(issuerUrl, entry)
  return entry
}

async function fetchDiscovery(issuerUrl: string, fetcher: typeof fetch): Promise<OidcMetadata> {
  const trimmed = issuerUrl.replace(/\/$/, '')
  const url = `${trimmed}/.well-known/openid-configuration`
  const res = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`oidc-discovery-failed status=${res.status}`)
  }
  const json = (await res.json()) as Partial<OidcMetadata>
  if (!json.issuer || !json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri) {
    throw new Error('oidc-discovery-incomplete')
  }
  return json as OidcMetadata
}

/** Used by the admin /test endpoint — fetch + return metadata, do not cache. */
export async function testDiscovery(
  issuerUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<{ ok: true; metadata: OidcMetadata } | { ok: false; error: string }> {
  try {
    const metadata = await fetchDiscovery(issuerUrl, fetcher)
    // Touch JWKS just to make sure it is reachable.
    const jwksRes = await fetcher(metadata.jwks_uri, { method: 'GET' })
    if (!jwksRes.ok) {
      return { ok: false, error: `jwks-fetch-failed status=${jwksRes.status}` }
    }
    const _jwks = (await jwksRes.json()) as JSONWebKeySet
    void _jwks
    return { ok: true, metadata }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
