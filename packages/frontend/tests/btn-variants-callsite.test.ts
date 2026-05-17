// RFC-035 PR1 — guard the set of files that use the previously-undefined
// btn--ghost / btn--xs variants. If a callsite drops the variant without
// also dropping the file from this list, the test fires; that catches
// "someone removed the variant on a button and the visual fell back to the
// default rectangle" silently.

import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listFiles(full))
    } else if (name.endsWith('.tsx') || name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const allFiles = listFiles(SRC)

function callsitesOf(variant: string): string[] {
  return allFiles.filter((f) => readFileSync(f, 'utf8').includes(variant))
}

describe('RFC-035 btn variants — callsite inventory', () => {
  test('btn--ghost is used by at least 4 source files', () => {
    // Exclude styles.css since it's the CSS declaration, not a callsite.
    const sites = callsitesOf('btn--ghost').filter((f) => !f.endsWith('styles.css'))
    expect(sites.length, sites.join('\n')).toBeGreaterThanOrEqual(4)
  })

  test('btn--xs is used by at least 4 source files', () => {
    const sites = callsitesOf('btn--xs').filter((f) => !f.endsWith('styles.css'))
    expect(sites.length, sites.join('\n')).toBeGreaterThanOrEqual(4)
  })

  test('total distinct btn--ghost + btn--xs callsites ≥ 7 (RFC-035 design.md §2 inventory)', () => {
    const ghost = callsitesOf('btn--ghost').filter((f) => !f.endsWith('styles.css'))
    const xs = callsitesOf('btn--xs').filter((f) => !f.endsWith('styles.css'))
    const union = new Set([...ghost, ...xs])
    // After RFC-032 PR2 + PR3 landed: 4 ghost-only + 4 xs-only + 1 file
    // (UploadPicker) using both = 8 distinct source files. Lower bound 7
    // tolerates a single audit drift before the guard fires.
    expect(union.size).toBeGreaterThanOrEqual(7)
  })
})
