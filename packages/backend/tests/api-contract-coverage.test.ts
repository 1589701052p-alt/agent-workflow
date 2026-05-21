// RFC-054 W1-2 — coverage guard for the API contract registry.
//
// LOCKS: every HTTP endpoint mounted under `packages/backend/src/routes/*.ts`
// must be enumerated in `tests/contracts/registry.ts ENDPOINTS`. A new route
// landing without a registry entry → CI red. This is the "did the contract
// file actually keep up with reality" half of the W1-2 spec; the runtime
// behavior half lives in `api-contract.test.ts`.

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENDPOINTS, type HttpMethod } from './contracts/registry'

const ROUTES_DIR = resolve(import.meta.dir, '..', 'src', 'routes')

// Match `app.get('/path', ...)`, `app.post('/path', ...)`, etc. We strip
// comment lines first so commented-out routes don't get picked up. Tolerant
// of leading whitespace and additional middleware args.
const ROUTE_RE = /\bapp\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g

interface DiscoveredRoute {
  method: HttpMethod
  path: string
  /** File the route was discovered in (helpful in failure messages). */
  source: string
}

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(ROUTES_DIR, f))
}

function stripLineComments(src: string): string {
  // Drop everything from `//` to end-of-line. Block comments stay because
  // the route literal doesn't contain `*/`.
  return src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

function discoverRoutes(): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = []
  for (const f of listRouteFiles()) {
    const src = stripLineComments(readFileSync(f, 'utf-8'))
    let m: RegExpExecArray | null
    ROUTE_RE.lastIndex = 0
    while ((m = ROUTE_RE.exec(src)) !== null) {
      out.push({
        method: m[1]!.toUpperCase() as HttpMethod,
        path: m[2]!,
        source: f,
      })
    }
  }
  return out
}

// `/api/whoami` is registered directly in server.ts (not under routes/) but
// is owned by the auth layer; we deliberately skip it in this guard. Other
// non-route registrations (SPA fallback `*`, ws upgrade in server.ts) live
// outside routes/ too and similarly are not in scope.
const NON_ROUTES_EXCEPTIONS = new Set<string>()

describe('API contract registry coverage', () => {
  const discovered = discoverRoutes()
  const registered = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`))

  test('discovers at least 100 endpoints across routes/*.ts', () => {
    // Sanity: project currently has ~138; if this drops below 100 the route
    // scan is broken (likely RegExp change), not the routes themselves.
    expect(discovered.length).toBeGreaterThan(100)
  })

  test('every src/routes/*.ts endpoint is registered in ENDPOINTS', () => {
    const missing = discovered
      .filter((d) => !NON_ROUTES_EXCEPTIONS.has(`${d.method} ${d.path}`))
      .filter((d) => !registered.has(`${d.method} ${d.path}`))
      .map((d) => `  ${d.method.padEnd(7)} ${d.path}\n    (defined in ${d.source})`)
    if (missing.length > 0) {
      throw new Error(
        `RFC-054 contract registry is missing ${missing.length} endpoint(s):\n` +
          missing.join('\n') +
          '\n\nAdd the entry to packages/backend/tests/contracts/registry.ts ENDPOINTS.',
      )
    }
  })

  test('every ENDPOINTS entry maps to a real source route (no zombie registrations)', () => {
    const discoveredKeys = new Set(discovered.map((d) => `${d.method} ${d.path}`))
    const zombies = ENDPOINTS.filter((e) => !discoveredKeys.has(`${e.method} ${e.path}`)).map(
      (e) => `${e.method} ${e.path}`,
    )
    if (zombies.length > 0) {
      throw new Error(
        `RFC-054 contract registry has ${zombies.length} entries with no source route:\n` +
          zombies.map((z) => `  ${z}`).join('\n') +
          '\n\nEither restore the route or drop the entry.',
      )
    }
  })

  test('no duplicate registry entries (same method+path twice)', () => {
    const seen = new Map<string, number>()
    for (const e of ENDPOINTS) {
      const key = `${e.method} ${e.path}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `  ${k} (x${n})`)
    if (dups.length > 0) {
      throw new Error(`duplicate entries:\n${dups.join('\n')}`)
    }
  })
})
