// P-5-05 single-binary runtime helpers.
//
// `embed.generated.ts` lists every file the build script chose to embed; this
// module hides the storage detail behind two operations the daemon uses:
//   - `getEmbeddedAsset(urlPath)` — synchronous-ish lookup for static GETs
//     when the daemon serves the SPA from the binary instead of a vite dev
//     server.
//   - `extractMigrationsTo(dir)` — drizzle's bun-sqlite migrator wants a
//     filesystem path. In dev that path is packages/backend/db/migrations on
//     disk; in the binary we extract the embedded copies once on startup.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FRONTEND_FILES, IS_EMBEDDED, MIGRATION_FILES } from './embed.generated'

export { IS_EMBEDDED }

export function listEmbeddedFrontendPaths(): string[] {
  return Object.keys(FRONTEND_FILES)
}

/**
 * Count the .sql files embedded in the binary. `doctor` uses this when
 * IS_EMBEDDED=true to check that the binary actually carries migrations,
 * since the on-disk `Paths.migrationsDir` is meaningless in that mode
 * (`import.meta.dirname` gets baked into `/` by `bun build --compile`).
 *
 * Mirror filtering used by `start.ts`'s dbVersion calculation (.sql only —
 * `meta/_journal.json` is metadata, not a migration).
 */
export function countEmbeddedSqlMigrations(): number {
  let count = 0
  for (const rel of Object.keys(MIGRATION_FILES)) {
    if (rel.endsWith('.sql')) count++
  }
  return count
}

export async function getEmbeddedAsset(
  urlPath: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const filePath = FRONTEND_FILES[urlPath]
  if (filePath === undefined) return null
  const body = await Bun.file(filePath).arrayBuffer()
  return { body, contentType: mimeTypeFor(urlPath) }
}

/**
 * Write every embedded migration file (and meta/_journal.json) into
 * `targetDir`, mirroring the original folder layout so drizzle's migrator
 * can `readFileSync` them. Returns the count of files written.
 */
export async function extractMigrationsTo(targetDir: string): Promise<number> {
  mkdirSync(targetDir, { recursive: true })
  let count = 0
  for (const [rel, src] of Object.entries(MIGRATION_FILES)) {
    const dest = join(targetDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    const bytes = new Uint8Array(await Bun.file(src).arrayBuffer())
    writeFileSync(dest, bytes)
    count++
  }
  return count
}

function mimeTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8'
    case 'js':
    case 'mjs':
      return 'application/javascript; charset=utf-8'
    case 'css':
      return 'text/css; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'svg':
      return 'image/svg+xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'ico':
      return 'image/x-icon'
    case 'woff':
      return 'font/woff'
    case 'woff2':
      return 'font/woff2'
    case 'map':
      return 'application/json; charset=utf-8'
    case 'txt':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
