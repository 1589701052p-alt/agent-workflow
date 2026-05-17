// RFC-029: opencode plugin module — entry points used by the framework.
//
// `transcoder.ts` exposes the TS twin of `aw-inventory-dump.mjs`'s pure
// conversion functions so that unit tests can exercise the field mapping
// without spawning an opencode process. `awInventoryDumpSourcePath()` returns
// the on-disk path to the actual ESM file that the framework copies into a
// per-run-dir's `.opencode/plugins/` directory before spawning opencode.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Absolute path to the dump plugin's ESM source. Stable across dev (`bun
 * run`) and the single-binary distribution (`bun build --compile` ships the
 * file via the embed table; see `embed.ts`'s migration path for the same
 * pattern). Use this from runner.ts when materializing the file into the
 * spawn dir.
 */
export function awInventoryDumpSourcePath(): string {
  return resolve(HERE, 'aw-inventory-dump.mjs')
}

export * from './transcoder'
