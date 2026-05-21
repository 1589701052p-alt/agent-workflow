// RFC-054 W3-3 — compatibility matrix for config $schema_version values.
//
// LOCKS: every historical config file shape MUST still parse cleanly
// through the current `ConfigSchema`. The daemon's startup path reads
// `~/.agent-workflow/config.json` and crashes if validation fails — so a
// silent regression here would break every user upgrading their binary
// at the same time.
//
// Today CONFIG_SCHEMA_VERSION is 1 (no migrations needed). The matrix
// still has value:
//   * Two v1 fixtures exercise the "minimal" + "all optional fields"
//     ends of the shape. A future PR that accidentally MAKES an optional
//     field required (a frequent Zod regression footgun) catches here.
//   * When the v1 → v2 bump lands, this test grows a v2 fixture in the
//     same diff and a `parseAndUpgrade()` migration helper alongside.
//
// Why committed JSON fixtures vs. inline literals: the JSON form IS what
// users have on disk. Inline literals would silently drift from the disk
// shape; fixtures pin it.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_SCHEMA_VERSION, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures', 'config-versions')

interface ConfigFixture {
  filename: string
  raw: unknown
}

function loadFixtures(): ConfigFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((filename) => ({
      filename,
      raw: JSON.parse(readFileSync(join(FIXTURES_DIR, filename), 'utf-8')),
    }))
}

describe('RFC-054 W3-3 — config schema version compatibility matrix', () => {
  const fixtures = loadFixtures()

  test('at least one fixture exists (drift sentinel)', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const f of fixtures) {
    test(`fixture ${f.filename} parses through ConfigSchema cleanly`, () => {
      const parsed = ConfigSchema.safeParse(f.raw)
      if (!parsed.success) {
        throw new Error(
          `config fixture ${f.filename} failed schema validation:\n` +
            JSON.stringify(parsed.error.issues, null, 2),
        )
      }
      expect(parsed.data.$schema_version).toBe(CONFIG_SCHEMA_VERSION)
    })
  }

  test('DEFAULT_CONFIG itself is a valid ConfigSchema value', () => {
    // Sanity that the writer-side default never drifts from the
    // validator-side schema. Frequent regression source — Zod field
    // addition often forgets to update DEFAULT_CONFIG.
    const parsed = ConfigSchema.safeParse(DEFAULT_CONFIG)
    if (!parsed.success) {
      throw new Error(
        `DEFAULT_CONFIG failed schema validation:\n` + JSON.stringify(parsed.error.issues, null, 2),
      )
    }
  })

  test('all fixtures share the current $schema_version (no orphan versions)', () => {
    // When CONFIG_SCHEMA_VERSION bumps to 2, this test will start
    // failing for old fixtures — the PR doing the bump must either
    // update fixtures + add a parse-and-upgrade test, or move v1
    // fixtures into a `legacy/` subdir routed through a migration.
    for (const f of fixtures) {
      const v = (f.raw as { $schema_version: number }).$schema_version
      expect(v).toBe(CONFIG_SCHEMA_VERSION)
    }
  })
})
