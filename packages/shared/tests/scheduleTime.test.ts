// RFC-159 T1 — scheduleTime 纯函数：间隔锚定不漂移 + 周期预设创建者时区下次触发 + DST 边界。
//
// DST fixture 锁 design §2 的 R2-d/R3-3/R4-2 收口：
//  - NY 春进 gap（02:30 不存在 → 顺延切换瞬间 03:00 EDT）
//  - NY 秋退 overlap（01:30 出现两次 → 取较早 EDT 实例）
//  - Sydney 秋退 overlap（南半球/正偏移 → 仍取较早的 AEDT 实例，锁 R4-2）
import { describe, expect, test } from 'bun:test'

import { computeNextRunAt, tzOffsetMs, wallClockAt, zonedWallClockToEpoch } from '../src/index'
import type { ScheduleSpec } from '../src/index'

const HOUR = 3_600_000
const NY = 'America/New_York'
const SYD = 'Australia/Sydney'

describe('tzOffsetMs — DST-aware UTC offset', () => {
  test('NY winter = EST (−5h), summer = EDT (−4h)', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12), NY)).toBe(-5 * HOUR)
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12), NY)).toBe(-4 * HOUR)
  })
  test('Sydney summer = AEDT (+11h), winter = AEST (+10h)', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12), SYD)).toBe(11 * HOUR)
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12), SYD)).toBe(10 * HOUR)
  })
})

describe('zonedWallClockToEpoch — normal / gap / overlap', () => {
  test('normal: 09:00 NY winter = 14:00 UTC', () => {
    expect(zonedWallClockToEpoch({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY)).toBe(
      Date.UTC(2026, 0, 15, 14, 0, 0),
    )
  })
  test('gap (NY spring-forward 2026-03-08 02:30 does not exist) → 03:00 EDT = 07:00 UTC', () => {
    expect(zonedWallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toBe(
      Date.UTC(2026, 2, 8, 7, 0, 0),
    )
  })
  test('overlap (NY fall-back 2026-11-01 01:30 twice) → earlier EDT = 05:30 UTC', () => {
    expect(zonedWallClockToEpoch({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY)).toBe(
      Date.UTC(2026, 10, 1, 5, 30, 0),
    )
  })
  test('overlap Southern Hemisphere (Sydney fall-back 2026-04-05 02:30) → earlier AEDT = Apr4 15:30 UTC (R4-2)', () => {
    expect(zonedWallClockToEpoch({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, SYD)).toBe(
      Date.UTC(2026, 3, 4, 15, 30, 0),
    )
  })
  test('round-trips: result formatted back in tz matches the request (non-DST)', () => {
    const e = zonedWallClockToEpoch({ year: 2026, month: 6, day: 20, hour: 14, minute: 45 }, SYD)
    const wc = wallClockAt(e, SYD)
    expect([wc.hour, wc.minute, wc.day, wc.month]).toEqual([14, 45, 20, 6])
  })
})

describe('computeNextRunAt — interval anchored, no drift', () => {
  const spec: ScheduleSpec = { kind: 'interval', every: 6, unit: 'hours' }
  test('first fire = anchor + interval when now == anchor', () => {
    expect(computeNextRunAt(spec, 0, 0)).toBe(6 * HOUR)
  })
  test('coalesces missed slots to the single next grid slot strictly > now', () => {
    // anchor=0, now=13h → grid {6,12,18}, next strictly >13h = 18h (one fire, no burst)
    expect(computeNextRunAt(spec, 13 * HOUR, 0)).toBe(18 * HOUR)
  })
  test('stays on the fixed anchor grid regardless of a late now (no drift)', () => {
    // late by 40min into the 12h slot → next is still the 18h grid point, not 18h40m
    expect(computeNextRunAt(spec, 12 * HOUR + 40 * 60_000, 0)).toBe(18 * HOUR)
  })
  test('always strictly greater than now (on-grid now advances one step)', () => {
    expect(computeNextRunAt(spec, 12 * HOUR, 0)).toBe(18 * HOUR)
  })
  test('minutes/days units', () => {
    expect(computeNextRunAt({ kind: 'interval', every: 30, unit: 'minutes' }, 0, 0)).toBe(
      30 * 60_000,
    )
    expect(computeNextRunAt({ kind: 'interval', every: 2, unit: 'days' }, 0, 0)).toBe(
      2 * 86_400_000,
    )
  })
})

describe('computeNextRunAt — daily / weekly / monthly in creator timezone', () => {
  const at9 = { at: '09:00', timezone: NY }

  test('daily: fires later today if time still ahead, else tomorrow', () => {
    const daily: ScheduleSpec = { kind: 'daily', ...at9 }
    const before = Date.UTC(2026, 0, 15, 13, 0, 0) // 08:00 EST
    expect(computeNextRunAt(daily, before)).toBe(Date.UTC(2026, 0, 15, 14, 0, 0)) // 09:00 EST today
    const after = Date.UTC(2026, 0, 15, 15, 0, 0) // 10:00 EST
    expect(computeNextRunAt(daily, after)).toBe(Date.UTC(2026, 0, 16, 14, 0, 0)) // 09:00 EST tomorrow
  })

  test('weekly: next Monday (dow=1) at 09:00, skipping non-selected days', () => {
    const weekly: ScheduleSpec = { kind: 'weekly', daysOfWeek: [1], ...at9 }
    // 2026-01-15 is a Thursday → next Monday = 2026-01-19
    const now = Date.UTC(2026, 0, 15, 13, 0, 0)
    const next = computeNextRunAt(weekly, now)
    const wc = wallClockAt(next, NY)
    expect([wc.year, wc.month, wc.day, wc.hour, wc.minute]).toEqual([2026, 1, 19, 9, 0])
    expect(new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay()).toBe(1)
  })

  test('monthly: day 31 skips 30-day / February months to the next month that has a 31st', () => {
    const monthly: ScheduleSpec = { kind: 'monthly', dayOfMonth: 31, ...at9 }
    // now = 2026-02-15 → February has no 31st, March does → next fire 2026-03-31
    const now = Date.UTC(2026, 1, 15, 13, 0, 0)
    const wc = wallClockAt(computeNextRunAt(monthly, now), NY)
    expect([wc.year, wc.month, wc.day, wc.hour, wc.minute]).toEqual([2026, 3, 31, 9, 0])
  })

  test('monthly: fires this month if the day is still ahead', () => {
    const monthly: ScheduleSpec = { kind: 'monthly', dayOfMonth: 20, ...at9 }
    const now = Date.UTC(2026, 0, 10, 13, 0, 0) // Jan 10
    const wc = wallClockAt(computeNextRunAt(monthly, now), NY)
    expect([wc.month, wc.day]).toEqual([1, 20])
  })

  test('every result is strictly after now', () => {
    const specs: ScheduleSpec[] = [
      { kind: 'daily', ...at9 },
      { kind: 'weekly', daysOfWeek: [0, 3, 6], ...at9 },
      { kind: 'monthly', dayOfMonth: 15, ...at9 },
    ]
    const now = Date.UTC(2026, 4, 20, 10, 0, 0)
    for (const s of specs) expect(computeNextRunAt(s, now)).toBeGreaterThan(now)
  })
})
