// LOCKS: RFC-057 — grep guards for lifecycleRepair source.
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §6.4.
// Locks in:
//   - no naked `db.update(nodeRuns).set({ status:`  → must go through
//     transitionNodeRunStatus / setNodeRunStatus (RFC-053 state machine)
//   - no `db.delete(` in the engine or option modules (audit is append-only;
//     repair never deletes rows — even cancel goes through cancel-by-supersede
//     which UPDATEs status, doesn't DELETE)
//   - shared `REPAIR_OPTION_IDS` keys exactly cover `LifecycleAlertRule`
//   - every backend `REPAIR_OPTIONS[rule].id` is listed in shared
//     `REPAIR_OPTION_IDS[rule]` (PR-A pairs the compile-time satisfies with
//     this runtime check so empty PR-A arrays don't silently drift)

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  LIFECYCLE_ALERT_RULES,
  REPAIR_OPTION_IDS,
  type LifecycleAlertRule,
} from '@agent-workflow/shared'

import { REPAIR_OPTIONS } from '../src/services/lifecycleRepair'

const SVC_DIR = resolve(import.meta.dir, '..', 'src', 'services')
const ENGINE_FILE = resolve(SVC_DIR, 'lifecycleRepair.ts')
const OPTIONS_DIR = resolve(SVC_DIR, 'lifecycleRepair')

function loadEngineSources(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  files.push({ path: ENGINE_FILE, content: readFileSync(ENGINE_FILE, 'utf8') })
  for (const entry of readdirSync(OPTIONS_DIR)) {
    if (!entry.endsWith('.ts')) continue
    const p = resolve(OPTIONS_DIR, entry)
    files.push({ path: p, content: readFileSync(p, 'utf8') })
  }
  return files
}

describe('RFC-057 grep guards', () => {
  test('no naked `db.update(nodeRuns).set({ status:` — must use state machine', () => {
    for (const { path, content } of loadEngineSources()) {
      const naked = /\.update\(\s*nodeRuns\s*\)[\s\S]{0,400}\.set\(\s*\{\s*[\s\S]{0,80}status\s*:/
      expect({ path, ok: !naked.test(content) }).toEqual({ path, ok: true })
    }
  })

  test('no `db.delete(` — audit append-only, repair never deletes', () => {
    for (const { path, content } of loadEngineSources()) {
      // Allow comments mentioning the rule. Strip line comments, then check.
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect({
        path,
        ok: !stripped.includes('db.delete(') && !stripped.includes('.delete('),
      }).toEqual({
        path,
        ok: true,
      })
    }
  })

  test('engine uses transitionNodeRunStatus or setNodeRunStatus at least once', () => {
    // At least one of the option modules must call one of these helpers.
    let total = 0
    for (const { content } of loadEngineSources()) {
      const m1 = (content.match(/transitionNodeRunStatus\s*\(/g) ?? []).length
      const m2 = (content.match(/setNodeRunStatus\s*\(/g) ?? []).length
      total += m1 + m2
    }
    expect(total).toBeGreaterThanOrEqual(4) // PR-A: S3.resurrect-x ×2, T1.resurrect, R1.approve, U1.cancel ×2 — well over 4
  })

  test('shared REPAIR_OPTION_IDS keys exactly cover LifecycleAlertRule union', () => {
    const sharedKeys = new Set(Object.keys(REPAIR_OPTION_IDS))
    const ruleSet = new Set<string>(LIFECYCLE_ALERT_RULES)
    expect(sharedKeys.size).toBe(ruleSet.size)
    for (const r of ruleSet) expect(sharedKeys.has(r)).toBe(true)
  })

  test('backend REPAIR_OPTIONS option ids appear in shared REPAIR_OPTION_IDS', () => {
    for (const rule of Object.keys(REPAIR_OPTIONS) as LifecycleAlertRule[]) {
      const sharedIds = new Set(REPAIR_OPTION_IDS[rule] as readonly string[])
      for (const def of REPAIR_OPTIONS[rule]) {
        expect({ rule, optionId: def.id, knownInShared: sharedIds.has(def.id) }).toEqual({
          rule,
          optionId: def.id,
          knownInShared: true,
        })
      }
    }
  })

  test('every LifecycleAlertRule has ≥ 1 RepairOptionDef (PR-B exhaustiveness)', () => {
    // PR-B narrowed the central `satisfies` to a tuple form so empty arrays
    // fail compilation. This is a runtime backstop for the same guarantee.
    for (const rule of Object.keys(REPAIR_OPTIONS) as LifecycleAlertRule[]) {
      expect({ rule, count: REPAIR_OPTIONS[rule].length }).toEqual({
        rule,
        count: expect.any(Number),
      })
      expect(REPAIR_OPTIONS[rule].length).toBeGreaterThan(0)
    }
  })
})
