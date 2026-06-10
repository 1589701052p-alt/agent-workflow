// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-10 (WP-7)
//
// 两层各司其职：
//
// 【行为证明层】固化平台语义（这不是 bug 测试，是"为什么 async 事务是装饰性的"
// 的可执行证据，绿测试）：drizzle + bun:sqlite 的 `db.transaction(async (tx) => …)`
// 中，bun:sqlite 的 Database.transaction 是同步包装——async 回调在第一个 await
// 处把控制权交还包装器，包装器见回调"返回"（返回的是 pending promise）即刻
// COMMIT。因此：
//   - 第一个 await 之后 connection 已不在事务中（raw.inTransaction === false）；
//   - await 之后的语句逐条 autocommit；
//   - 事后抛异常只会 reject 外层 promise，已写入的行不回滚。
// 仓内双重旁证：services/clarify.ts:385-387 注释明写 "db.transaction does NOT
// help: bun:sqlite's transaction is synchronous, so an async body COMMITs at
// its first real await — verified"；lifecycleRepair/options-R2.ts:4-7 记载
// RFC-052 approve 半提交事故正是此类。
//
// 【守卫层】RFC-093（WP-7）已落地：调研基线的五处装饰性 async 事务（review.ts、
// memory.ts ×2、plugin.ts、mcp.ts）已全部改写为 src/db/txSync.ts 的 dbTxSync
// （类型层拒绝 async 回调 + 运行时 Promise 守卫即回滚），守卫从此零容忍——
// src 内任何非注释行出现 `.transaction(async` 本测试即红，强迫作者面对本文件
// 行为证明层的事实并改用 dbTxSync。原语自身的行为锁定（提交/回滚/运行时守卫/
// review 三步序列红绿对照）见 rfc093-db-tx-sync.test.ts。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// ---------------------------------------------------------------------------
// 行为证明层
// ---------------------------------------------------------------------------

const t = sqliteTable('t', {
  id: integer('id').primaryKey(),
  v: text('v').notNull(),
})

function makeDb(): { raw: Database; db: ReturnType<typeof drizzle> } {
  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)')
  return { raw, db: drizzle(raw) }
}

describe('S-10 platform semantics: drizzle + bun:sqlite async transaction is decorative', () => {
  test('async body COMMITs at the first await — connection leaves the transaction mid-body', async () => {
    const { raw, db } = makeDb()
    const observed = {
      inTxAtBodyStart: null as boolean | null,
      inTxAfterFirstAwait: null as boolean | null,
    }

    await db.transaction(async (tx) => {
      // 同步前奏仍在 BEGIN..COMMIT 内。
      observed.inTxAtBodyStart = raw.inTransaction
      await tx.insert(t).values({ id: 1, v: 'a' })
      // 第一个 await 已把控制权交还同步包装器 → 包装器已 COMMIT。
      observed.inTxAfterFirstAwait = raw.inTransaction
      await tx.insert(t).values({ id: 2, v: 'b' }) // autocommit 单飞
    })

    expect(observed.inTxAtBodyStart).toBe(true)
    expect(observed.inTxAfterFirstAwait).toBe(false) // ← S-10 的核心事实
    expect((await db.select().from(t)).length).toBe(2)
  })

  test('throw after the first await rejects the promise but does NOT roll back already-run statements', async () => {
    const { db } = makeDb()

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(t).values({ id: 1, v: 'a' })
        await tx.insert(t).values({ id: 2, v: 'b' })
        // 模拟 review.ts:505-538 这类多写序列中途失败/崩溃点。
        throw new Error('mid-sequence failure')
      }),
    ).rejects.toThrow('mid-sequence failure')

    // 半态留存：两行都已 autocommit 落库，没有任何回滚——
    // 正是 lifecycleRepair R2 规则（RFC-052 approve 半提交）的事故根因类。
    const rows = await db.select().from(t)
    expect(rows.length).toBe(2)
  })

  test('the safe primitive WP-7 will wrap: raw bun:sqlite SYNCHRONOUS transaction does roll back on throw', () => {
    const { raw } = makeDb()
    const ins = raw.prepare('INSERT INTO t (id, v) VALUES (?, ?)')
    const txFn = raw.transaction(() => {
      ins.run(1, 'a')
      ins.run(2, 'b')
      throw new Error('sync failure')
    })

    expect(() => txFn()).toThrow('sync failure')
    const count = raw.query('SELECT COUNT(*) AS n FROM t').get() as { n: number }
    expect(count.n).toBe(0) // 同步回调形态：真回滚
  })
})

// ---------------------------------------------------------------------------
// 守卫层
// ---------------------------------------------------------------------------

const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of content.split('\n')) {
    if (isCommentLine(line)) continue
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

/**
 * RFC-093 已落地（WP-7）：调研基线的五处装饰性 async 事务（mcp.ts / memory.ts ×2 /
 * plugin.ts / review.ts）已全部改写为 `dbTxSync`（src/db/txSync.ts）的同步执行面。
 * 守卫从此零容忍：src 内任何非注释行出现 `.transaction(async` 即红。
 */
const EXPECTED_ASYNC_TX_SITES: Record<string, number> = {}

describe('S-10 guard: `.transaction(async` inventory in packages/backend/src', () => {
  test('ZERO decorative async transactions — any occurrence turns this red (use dbTxSync)', () => {
    const actual: Record<string, number> = {}
    for (const file of walkTsFiles(BACKEND_SRC)) {
      const count = countNonCommentMatches(
        readFileSync(file, 'utf8'),
        /\.transaction\s*\(\s*async\b/g,
      )
      if (count > 0) {
        actual[relative(BACKEND_SRC, file).split(sep).join('/')] = count
      }
    }
    // 任何命中 → 此断言红。处置：不要写 async 事务体——它在 bun:sqlite 下
    // 没有任何原子性（见本文件行为证明层）；用 src/db/txSync.ts 的 dbTxSync
    // + 同步执行面（.all()/.run()/.get()）。
    expect(actual).toEqual(EXPECTED_ASYNC_TX_SITES)
  })
})
