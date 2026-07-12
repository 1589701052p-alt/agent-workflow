// RFC-159 — 定时任务「下次触发时刻」计算（纯函数、前后端共用、零依赖，仅用运行时自带 Intl）。
//
// 与 cron 不同：只支持「固定间隔」+「友好周期预设」（每天/每周/每月 at HH:MM）。周期预设按
// spec 显式携带的 IANA 时区解释（含 DST）。承重算法与边界语义见
// design/RFC-159-scheduled-tasks/design.md §2（R2-d / R3-3 / R4-2 收口版）。
//
// 纯函数约束：本模块绝不调用 Date.now() / 无参 new Date() / Math.random()——`now` 一律由
// 调用方传入，日历遍历用 new Date(Date.UTC(...)) / new Date(epoch)（均带参、确定性）。
import type { ScheduleSpec } from './schemas/scheduledTask'

const MIN_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const UNIT_MS: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: MIN_MS,
  hours: HOUR_MS,
  days: DAY_MS,
}

/** IANA 时区名是否被运行时 Intl 接受（构造 DateTimeFormat 不抛即有效）。 */
export function isValidIanaTz(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// 构造 DateTimeFormat 不便宜——按时区缓存。
const FMT_CACHE = new Map<string, Intl.DateTimeFormat>()
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = FMT_CACHE.get(tz)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    FMT_CACHE.set(tz, f)
  }
  return f
}

interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
  second: number
}

/** epoch 在时区 tz 里的墙钟分解。 */
export function wallClockAt(epoch: number, tz: string): WallClock {
  const parts = fmtFor(tz).formatToParts(new Date(epoch))
  const pick = (t: string): number => Number(parts.find((p) => p.type === t)!.value)
  let hour = pick('hour')
  if (hour === 24) hour = 0 // 某些 ICU 把午夜输出为 '24'
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 时区 tz 在瞬间 epoch 的 UTC 偏移（ms，= 本地墙钟 − UTC；东半球为正）。 */
export function tzOffsetMs(epoch: number, tz: string): number {
  const wc = wallClockAt(epoch, tz)
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second)
  return asUtc - epoch
}

interface WallInput {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
}

/**
 * 把「时区 tz 的墙钟」转 epoch（ms）。正确覆盖 DST gap / overlap，**与偏移符号及半球无关**。
 *
 * 候选集算法（design §2）：`guess = Date.UTC(墙钟)`；在 guess 两侧 ±26h（必跨任一单次 DST
 * 切换）探偏移得切换前后两个偏移，生成候选 `guess − off`，逐个回环校验（格式化回 tz、墙钟
 * 是否 == 请求值）：
 *  - 正常：恰一个有效 → 返回它。
 *  - overlap（秋退，两候选均有效）→ 返回 min（最早），候选已含两侧偏移故 min 恒最早、南北半球一致。
 *  - gap（春进，均无效）→ 二分定位 spring-forward 切换瞬间，返回切换后第一个有效瞬间。
 */
export function zonedWallClockToEpoch(wc: WallInput, tz: string): number {
  const guess = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0)
  const matches = (epoch: number): boolean => {
    const g = wallClockAt(epoch, tz)
    return (
      g.year === wc.year &&
      g.month === wc.month &&
      g.day === wc.day &&
      g.hour === wc.hour &&
      g.minute === wc.minute
    )
  }
  // 两侧偏移（切换前后）——候选必须来自两侧，否则南半球/正偏移 overlap 会漏掉较早实例。
  const offsets = new Set([
    tzOffsetMs(guess - 26 * HOUR_MS, tz),
    tzOffsetMs(guess, tz),
    tzOffsetMs(guess + 26 * HOUR_MS, tz),
  ])
  const valid: number[] = []
  for (const off of offsets) {
    const cand = guess - off
    if (matches(cand)) valid.push(cand)
  }
  if (valid.length > 0) return Math.min(...valid) // overlap 取最早；正常唯一

  // gap：请求墙钟不存在 → 二分定位切换瞬间（偏移从 offLo 变化处），返回切换后第一个有效瞬间。
  // 关键：`tzOffsetMs` 只有秒级精度（Intl 无毫秒），故必须在**分钟对齐**的 epoch 上比较偏移——
  // guess/±26h 均分钟对齐（60000 整除），按分钟索引二分即保证每个探针分钟对齐、偏移为整数、`===` 可靠。
  const loMin = (guess - 26 * HOUR_MS) / MIN_MS
  const hiMin = (guess + 26 * HOUR_MS) / MIN_MS
  const offLo = tzOffsetMs(loMin * MIN_MS, tz)
  let a = loMin
  let b = hiMin
  while (b - a > 1) {
    const mid = a + Math.floor((b - a) / 2)
    if (tzOffsetMs(mid * MIN_MS, tz) === offLo) a = mid
    else b = mid
  }
  return b * MIN_MS
}

/** 间隔模式：锚定 `anchor + k*unitMs` 网格上「严格晚于 now」的最小槽（固定 epoch、不漂移、合并 missed）。 */
function nextIntervalRunAt(
  spec: Extract<ScheduleSpec, { kind: 'interval' }>,
  now: number,
  anchor: number,
): number {
  const unitMs = UNIT_MS[spec.unit] * spec.every
  let n = anchor + unitMs
  if (n <= now) n = anchor + Math.ceil((now - anchor) / unitMs) * unitMs
  while (n <= now) n += unitMs
  return n
}

const DOW_OF = (year: number, month: number, day: number): number =>
  new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=周日..6=周六

/** 周期预设：在 spec.timezone 里，从 now 当天起逐日前推，取首个「严格晚于 now」的 at HH:MM 触发。 */
function nextPresetRunAt(
  spec: Extract<ScheduleSpec, { kind: 'daily' | 'weekly' | 'monthly' }>,
  now: number,
): number {
  const [h, m] = spec.at.split(':').map(Number) as [number, number]
  const tz = spec.timezone
  const start = wallClockAt(now, tz)
  let y = start.year
  let mo = start.month
  let d = start.day
  // 上界仅作防呆：daily ≤2 天、weekly ≤8 天、monthly ≤ ~62 天必命中（缺该日的月跳过）。
  const bound = spec.kind === 'monthly' ? 800 : 8
  for (let i = 0; i < bound; i++) {
    const dateOk =
      spec.kind === 'daily'
        ? true
        : spec.kind === 'weekly'
          ? spec.daysOfWeek.includes(DOW_OF(y, mo, d))
          : d === spec.dayOfMonth // monthly：逐日遍历天然跳过缺该日的月
    if (dateOk) {
      const epoch = zonedWallClockToEpoch({ year: y, month: mo, day: d, hour: h, minute: m }, tz)
      if (epoch > now) return epoch
    }
    const nd = new Date(Date.UTC(y, mo - 1, d + 1))
    y = nd.getUTCFullYear()
    mo = nd.getUTCMonth() + 1
    d = nd.getUTCDate()
  }
  throw new Error(`scheduleTime: no next fire within bound for kind=${spec.kind}`)
}

/**
 * 统一入口：给定 spec 与当前时刻 now，返回下一次触发的 epoch（ms），**严格晚于 now**。
 * `anchor`（仅 interval 用）= 上一次 next_run_at（创建时传 now）——固定 epoch 网格、不随 tick 漂移。
 */
export function computeNextRunAt(spec: ScheduleSpec, now: number, anchor?: number): number {
  if (spec.kind === 'interval') return nextIntervalRunAt(spec, now, anchor ?? now)
  return nextPresetRunAt(spec, now)
}
