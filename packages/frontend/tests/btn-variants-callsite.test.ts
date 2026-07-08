// RFC-035 PR1 — guard the set of files that use the previously-undefined
// btn--ghost / btn--xs variants. If a callsite drops the variant without
// also dropping the file from this list, the test fires; that catches
// "someone removed the variant on a button and the visual fell back to the
// default rectangle" silently.
//
// RFC-150 PR-1 (D4) adds the ConfirmButton callsite lock: the `danger`
// boolean prop became `variant="danger"` (aligned with the .btn--* enum);
// the old prop must never reappear at a callsite.

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

describe('RFC-150 ConfirmButton callsites — `danger` prop stays deleted', () => {
  test('no <ConfirmButton …> open tag carries a `danger` prop (only variant="danger")', () => {
    const offenders: string[] = []
    for (const file of allFiles) {
      const body = readFileSync(file, 'utf8')
      let idx = body.indexOf('<ConfirmButton')
      while (idx !== -1) {
        // All callsites are self-closing; the open tag runs to the next `/>`
        // (a plain `>` would false-stop inside `onConfirm={() => …}`).
        const end = body.indexOf('/>', idx)
        const tag = end === -1 ? body.slice(idx) : body.slice(idx, end)
        // `variant="danger"` is the sanctioned spelling — blank the quoted
        // string value, then any residual `danger` token is the legacy prop.
        if (/\bdanger\b/.test(tag.replaceAll('"danger"', '""'))) {
          offenders.push(`${path.relative(SRC, file)}:${body.slice(0, idx).split('\n').length}`)
        }
        idx = body.indexOf('<ConfirmButton', idx + 1)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
