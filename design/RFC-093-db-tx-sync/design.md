# RFC-093 — 技术设计

行号基线：`b8c447a`（2026-06-10）。

## 1. 原语：`src/db/txSync.ts`

drizzle bun-sqlite 的 `transaction` 本身就是同步签名（node_modules/drizzle-orm/bun-sqlite/
session.d.ts:24 `transaction<T>(fn: (tx) => T): T`）——传 async 回调只是让 T 推断成 Promise，
这正是装饰性的根源。助手只做两件事：类型层禁止 Promise 返回 + 运行时兜底：

```ts
import type { DbClient } from './client'

/** The drizzle bun-sqlite transaction handle (sync execution surface). */
export type DbTxSync = Parameters<Parameters<DbClient['transaction']>[0]>[0]

/** Rejects async callbacks at the type level: a Promise-returning fn makes T = Promise → never. */
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T

export function dbTxSync<T>(db: DbClient, fn: (tx: DbTxSync) => NotPromise<T>): T {
  return db.transaction((tx) => {
    const result = fn(tx)
    if (
      result instanceof Promise ||
      (result !== null && typeof result === 'object' && 'then' in (result as object))
    ) {
      // Fail LOUD inside the transaction: the throw makes drizzle ROLLBACK,
      // so a runtime-smuggled async callback can never half-commit.
      throw new Error(
        'dbTxSync callback returned a Promise — async bodies COMMIT at their first await under bun:sqlite (audit S-10). Use synchronous drizzle execution (.all()/.run()/.get()) inside dbTxSync.',
      )
    }
    return result
  })
}
```

回调内语句必须用 drizzle 的同步执行面：`tx.select(...).all()` / `.get()`、
`tx.update(...).run()`、`tx.insert(...).run()`、`tx.delete(...).run()`。

## 2. 五处改写（机械模式）

外层 `await db.transaction(async (tx) => { ... await tx.X ... })` →
`dbTxSync(db, (tx) => { ... tx.X.run()/.all() ... })`。函数自身保持 async、签名不变；
事务返回值语义不变（`return db.transaction(...)` → `return dbTxSync(db, ...)`，async 函数
自动包回 Promise）。

| 位置                                                                                | 体内语句                                 | 备注                                                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| review.ts:505-538（stale doc_version 退役三步：删评论 → 改 decision → 盖 consumed） | select/delete/update ×4                  | RFC-052 同型事故的复发点，S-10 主证                                                                          |
| memory.ts:285（promoteCandidate）                                                   | select/update ×6 + 同步 publish + 域抛错 | 抛错路径（NotFound/Conflict/Validation）回滚后语义不变（本就发生在首写之前；改写后即使未来加先写后抛也安全） |
| memory.ts:415（patchMemory）                                                        | select/update + 同步 publish             | 幂等 no-op 早 return 保留                                                                                    |
| plugin.ts:237（rename 级联）                                                        | update + select/update 循环              | dependents 预查在事务外（现状如此，保留）                                                                    |
| mcp.ts:126（rename 级联）                                                           | 同上                                     | 同上                                                                                                         |

`publish`（WS 广播，纯同步函数）留在事务体内：Bun 单线程 + 同步事务不让出事件循环，任何
订阅方的后续读都发生在 COMMIT 之后——比现状（广播落在 autocommit 汤中间）更安全，不另移位。

memory.ts:5-10 头注释改写：原"wrapped in a single drizzle transaction so we never end up
with a half-promoted candidate"在改写前是错误信念（S-10），改为指向 dbTxSync 并注明同步
事务语义。

## 3. 失败模式

| 风险                                                                                                      | 缓解                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 改写引入行为差（漏改某条 await → 类型层直接报 Promise/never 冲突；select 结果形状差异 `.all()` vs await） | drizzle bun-sqlite 下 `await builder` 与 `.all()` 同结果；5 个函数的既有测试套件全绿为准 |
| 体内误留真 async 工作                                                                                     | 已逐处核读：5 处体内只有 drizzle 语句 + 同步 publish + 域抛错，零文件 IO / 零网络        |
| 同步事务阻塞事件循环过久                                                                                  | 5 处皆短序列（≤ 数十行写）；与现状相比只多 BEGIN/COMMIT 包裹                             |
| 未来再写出第六处 async 事务                                                                               | s10 守卫翻转为零容忍清单；dbTxSync 类型层让"看起来对的写法"真的对                        |

## 4. 测试策略

1. 翻转 `scheduler-audit-s10-async-transaction-decorative.test.ts` 守卫层（按其头指引）：
   `EXPECTED_ASYNC_TX_SITES` 清空 → 断言 src 内 `.transaction(async` 零命中；行为证明层
   三个用例原样保留（平台语义文档）。
2. 新增 `rfc093-db-tx-sync.test.ts`：
   - 原语：提交生效；体内抛错 → 全回滚；回调运行时返回 Promise（绕过类型）→ throw 且回滚；
     `@ts-expect-error` 锁编译期拒绝 async 回调。
   - 红绿对照（WP-7 oracle 的落地形态）：review.ts 三步序列等价复制品（删评论 → 改 decision
     → 第三步注入抛错）——dbTxSync 版断言前两步回滚（评论还在、decision 未变）；async 版
     半提交已由 s10 行为证明层锁定，测试注释互链。
3. 行为回归网（不动但必须全绿）：memory / plugin / mcp / review 的全部既有用例
   （promoteCandidate、patchMemory、rename 级联、review supersede/refresh 路径）。
