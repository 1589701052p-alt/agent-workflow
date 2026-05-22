// LOCKS: RFC-057 — diagnose-repair option taxonomy.
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §3.
// Locks in:
//   - REPAIR_OPTION_IDS covers every LifecycleAlertRule
//   - each rule has ≥ 1 optionId
//   - no duplicate optionId across the whole map
//   - every optionId obeys `<rule>.<kebab>` shape
//   - RepairRequestSchema rejects confirm=false / missing confirm / unknown shape
//   - isKnownRepairOptionId / ruleForOptionId round-trip correctly

import { describe, expect, test } from 'bun:test'

import {
  LIFECYCLE_ALERT_RULES,
  REPAIR_OPTION_IDS,
  RepairRequestSchema,
  isKnownRepairOptionId,
  repairOptionIdsForRule,
  ruleForOptionId,
} from '../src/index'

describe('RFC-057 — REPAIR_OPTION_IDS shape', () => {
  test('covers every LifecycleAlertRule', () => {
    const ruleKeys = new Set(Object.keys(REPAIR_OPTION_IDS))
    for (const rule of LIFECYCLE_ALERT_RULES) {
      expect(ruleKeys.has(rule)).toBe(true)
    }
    expect(ruleKeys.size).toBe(LIFECYCLE_ALERT_RULES.length)
  })

  test('each rule has at least one optionId', () => {
    for (const rule of LIFECYCLE_ALERT_RULES) {
      const ids = REPAIR_OPTION_IDS[rule]
      expect(ids.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('no duplicate optionId across the whole map', () => {
    const seen = new Map<string, string>() // id → rule
    for (const rule of LIFECYCLE_ALERT_RULES) {
      for (const id of REPAIR_OPTION_IDS[rule]) {
        const prev = seen.get(id)
        expect({ id, prevRule: prev, curRule: rule, dup: prev !== undefined }).toEqual({
          id,
          prevRule: prev,
          curRule: rule,
          dup: false,
        })
        seen.set(id, rule)
      }
    }
  })

  test('every optionId obeys `<rule>.<kebab>` shape', () => {
    const kebab = /^[a-z][a-z0-9-]*$/
    for (const rule of LIFECYCLE_ALERT_RULES) {
      for (const id of REPAIR_OPTION_IDS[rule]) {
        const [prefix, ...rest] = id.split('.')
        const suffix = rest.join('.')
        expect({
          id,
          prefix,
          suffix,
          rulePrefix: prefix === rule,
          kebabOk: kebab.test(suffix),
        }).toEqual({
          id,
          prefix: rule,
          suffix,
          rulePrefix: true,
          kebabOk: true,
        })
      }
    }
  })

  test('ruleForOptionId is the inverse of REPAIR_OPTION_IDS', () => {
    for (const rule of LIFECYCLE_ALERT_RULES) {
      for (const id of REPAIR_OPTION_IDS[rule]) {
        expect(ruleForOptionId(id)).toBe(rule)
        expect(isKnownRepairOptionId(id)).toBe(true)
      }
    }
    expect(ruleForOptionId('bogus.option')).toBeNull()
    expect(isKnownRepairOptionId('bogus.option')).toBe(false)
  })

  test('repairOptionIdsForRule returns the same array reference per call', () => {
    // Stable identity makes the frontend's React reference-equality memoization
    // work without copying.
    const a = repairOptionIdsForRule('S3')
    const b = repairOptionIdsForRule('S3')
    expect(a).toBe(b)
  })
})

describe('RFC-057 — RepairRequestSchema', () => {
  test('accepts { optionId, confirm: true }', () => {
    const r = RepairRequestSchema.safeParse({ optionId: 'S3.demote-task', confirm: true })
    expect(r.success).toBe(true)
  })

  test('rejects confirm=false', () => {
    const r = RepairRequestSchema.safeParse({ optionId: 'S3.demote-task', confirm: false })
    expect(r.success).toBe(false)
  })

  test('rejects missing confirm', () => {
    const r = RepairRequestSchema.safeParse({ optionId: 'S3.demote-task' })
    expect(r.success).toBe(false)
  })

  test('rejects empty optionId', () => {
    const r = RepairRequestSchema.safeParse({ optionId: '', confirm: true })
    expect(r.success).toBe(false)
  })

  test('rejects unrelated shape', () => {
    const r = RepairRequestSchema.safeParse({ foo: 'bar' })
    expect(r.success).toBe(false)
  })
})
