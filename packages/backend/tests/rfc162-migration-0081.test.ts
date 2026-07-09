// RFC-162 T4 — migration 0081 retroactive convergence 行选择逐格锁。
//
// 为什么这条测试存在（回归防护）：
// 迁移把 clarify 归一到单卡模型，删两类存量行：
//   ① role_kind='echo'（RFC-134 回执，跨节点专有）；
//   ② UNDISPATCHED 的 clarify designer-by-default 行（scope 派生，source_kind self/cross）。
// 保留：已下发 designer（执行事实 / 在途上游修订）、asker 的 self/questioner。
//
// 关键缺陷（本测试锁定）：**手工问题**以 `role_kind='designer'` 存储，且其正文
// （manual_title / manual_body）就挂在 task_questions 行上，创建即 STAGED（dispatched_at
// IS NULL，见 services/taskQuestions.ts createManualQuestion 的 stagedAt/无 dispatchedAt）。
// 若 designer 删除谓词不排除 `source_kind='manual'`，升级会**静默删掉待下发的手工问题**、
// 丢用户手写内容——违反 RFC-162 AC-6「迁移无损」。初版迁移正是漏了这个排除；此测试先红后绿。
// 任何未来 refactor 一旦把 manual 行卷进删除集，本用例立即变红。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIGRATION = readFileSync(resolve(MIGRATIONS, '0081_rfc162_clarify_unify.sql'), 'utf8')

// 最小 task_questions：只保留迁移谓词读的列 + 手工正文列（证明内容不丢）。
function buildDb(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE task_questions (
    id TEXT PRIMARY KEY,
    role_kind TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    dispatched_at INTEGER,
    manual_title TEXT,
    manual_body TEXT
  )`)
  return db
}

// 剥注释、按 breakpoint 分段执行迁移真实语句（与 0077 测试同法）。
function applyMigration(db: Database): void {
  const statements = MIGRATION.split('--> statement-breakpoint').map((chunk) =>
    chunk
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--') && l.trim().length > 0)
      .join('\n'),
  )
  for (const stmt of statements) {
    if (stmt.trim().length > 0) db.run(stmt)
  }
}

function seed(
  db: Database,
  id: string,
  roleKind: string,
  sourceKind: string,
  dispatchedAt: number | null,
  manual?: { title: string; body: string },
): void {
  db.prepare(
    'INSERT INTO task_questions (id, role_kind, source_kind, dispatched_at, manual_title, manual_body) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, roleKind, sourceKind, dispatchedAt, manual?.title ?? null, manual?.body ?? null)
}

function survives(db: Database, id: string): boolean {
  return db.query('SELECT 1 FROM task_questions WHERE id = ?').get(id) !== null
}

describe('migration 0081 — RFC-162 归一 retroactive convergence', () => {
  test('删 echo + 未下发 clarify designer；保留 asker / 已下发 designer', () => {
    const db = buildDb()
    seed(db, 'echo-cross', 'echo', 'cross', null) // RFC-134 回执 → 删
    seed(db, 'designer-self-undispatched', 'designer', 'self', null) // scope 派生 → 删
    seed(db, 'designer-cross-undispatched', 'designer', 'cross', null) // scope 派生 → 删
    seed(db, 'designer-cross-dispatched', 'designer', 'cross', 1710000000000) // 执行事实 → 留
    seed(db, 'self-asker', 'self', 'self', null) // asker → 留
    seed(db, 'questioner-asker', 'questioner', 'cross', null) // asker → 留
    applyMigration(db)
    expect(survives(db, 'echo-cross')).toBe(false)
    expect(survives(db, 'designer-self-undispatched')).toBe(false)
    expect(survives(db, 'designer-cross-undispatched')).toBe(false)
    expect(survives(db, 'designer-cross-dispatched')).toBe(true)
    expect(survives(db, 'self-asker')).toBe(true)
    expect(survives(db, 'questioner-asker')).toBe(true)
  })

  test('关键回归：待下发手工问题（designer + dispatched_at NULL + source_kind=manual）必须存活且正文完好', () => {
    const db = buildDb()
    // createManualQuestion 落库形态：role_kind='designer'、staged（无 dispatchedAt）、正文挂行上。
    seed(db, 'manual-staged', 'designer', 'manual', null, {
      title: '手工问题标题',
      body: '手工问题正文（用户手写，不可丢）',
    })
    // 对照：同为未下发 designer 但 source_kind=cross 的 clarify 行应被删。
    seed(db, 'designer-cross-undispatched', 'designer', 'cross', null)
    applyMigration(db)
    // 手工问题存活，且正文一字不丢。
    expect(survives(db, 'manual-staged')).toBe(true)
    const row = db
      .query('SELECT manual_title, manual_body FROM task_questions WHERE id = ?')
      .get('manual-staged') as { manual_title: string; manual_body: string }
    expect(row.manual_title).toBe('手工问题标题')
    expect(row.manual_body).toBe('手工问题正文（用户手写，不可丢）')
    // 对照行确实被删（证明谓词只排除 manual、仍收敛 clarify designer）。
    expect(survives(db, 'designer-cross-undispatched')).toBe(false)
  })

  test('已下发手工问题（若存在）同样保留', () => {
    const db = buildDb()
    seed(db, 'manual-dispatched', 'designer', 'manual', 1710000000000, {
      title: 't',
      body: 'b',
    })
    applyMigration(db)
    expect(survives(db, 'manual-dispatched')).toBe(true)
  })

  test('幂等：二次执行零变更', () => {
    const db = buildDb()
    seed(db, 'echo-cross', 'echo', 'cross', null)
    seed(db, 'manual-staged', 'designer', 'manual', null, { title: 't', body: 'b' })
    seed(db, 'self-asker', 'self', 'self', null)
    applyMigration(db)
    const after1 = db.query('SELECT id FROM task_questions ORDER BY id').all()
    applyMigration(db)
    const after2 = db.query('SELECT id FROM task_questions ORDER BY id').all()
    expect(after2).toEqual(after1)
    // 归一后应只剩 manual + self（echo 已删）。
    expect(after2.map((r) => (r as { id: string }).id)).toEqual(['manual-staged', 'self-asker'])
  })
})
