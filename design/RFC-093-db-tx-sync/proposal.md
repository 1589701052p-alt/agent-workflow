# RFC-093 — dbTxSync 同步事务助手：消灭装饰性 async 事务（S-10）

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-7**（独立小包）。
> 触发：2026-06-10 用户「继续 WP-7」。

## 背景

调研 S-10（P1，双核实确认）：bun:sqlite 的 `Database.transaction` 是同步包装——async 回调在第一
个 await 处把 pending promise 还给包装器，包装器即刻 COMMIT；await 之后的语句逐条 autocommit，
事后抛错不回滚。`db.transaction(async (tx) => …)` 因此是**装饰性**的：API 形态像安全的，实际
没有任何原子性。仓内双重旁证：clarify.ts:385-387 注释明写 "verified"；lifecycleRepair/
options-R2.ts:4-7 记载 RFC-052 的 approve 半提交事故正是此类。**且 RFC-052 之后 review.ts:505
又新写了一处**——不从结构上封死，复发是必然。当前 src 共 5 处：`review.ts:505`、
`memory.ts:285`（promoteCandidate）、`memory.ts:415`（patchMemory）、`plugin.ts:237`（rename
级联）、`mcp.ts:126`（rename 级联）。memory.ts:5-10 头注释还声称靠该事务防 half-promoted
（错误信念）。现状已被 `scheduler-audit-s10-async-transaction-decorative.test.ts` 锁定（行为
证明层 + 5 处清单守卫层）。

## 目标

1. 提供 `dbTxSync(db, (tx) => {...})` 同步事务原语：**类型层拒绝 async 回调**（返回 Promise 的
   回调直接编译错误）+ 运行时兜底（回调返回 Promise → 抛错并回滚，绝不静默半提交）。
2. 改写全部 5 处装饰性事务为 dbTxSync（语句改 drizzle 同步执行面 `.all()/.run()/.get()`），
   恢复它们注释所声称的原子性。
3. 结构性封死复发：s10 守卫翻转为「src 内 `.transaction(async` 零命中」。
4. 修正 memory.ts 头部的错误注释。

## 非目标

- 不引入跨 await 的异步事务方案（better-sqlite3 风格的 deferred 事务、连接池等）——bun:sqlite
  单连接 + Bun 单线程下同步事务就是正确原语。
- 不改 5 个函数的对外签名与行为（仍是 async 函数；错误类型、WS 事件、返回值不变）。
- 不动 clarify 三表写序（S-1 的 openAskingNodeIds 已守卫调度侧；clarify 收敛单表归 WP-10，
  届时可用 dbTxSync 原子化）。
- 不加 ESLint 规则（仓内先例用源码文本守卫；s10 测试已承担该职责）。

## 用户故事

平台管理员在 review 上游刷新 / memory 提升 / 插件改名中途遇到进程崩溃或语句失败时，数据库
不再处于半提交状态（pending doc_version 已删评论但未改 decision、候选已 approved 但旧版未标
superseded、插件已改名但 agent 引用未级联），重启后无需 lifecycleRepair 兜底。

## 验收标准

- [ ] `scheduler-audit-s10-*.test.ts` 守卫层按头指引翻转：`EXPECTED_ASYNC_TX_SITES` 清空，
      断言 src 内 `.transaction(async` 零命中；行为证明层保留。
- [ ] 新增 `rfc093-db-tx-sync.test.ts`：原语提交/抛错回滚/运行时 Promise 守卫（throw + 回滚）/
      `@ts-expect-error` 编译期拒绝 async 回调；并以 review.ts 三步序列等价复制品做红绿对照
      （async 版半提交〔与 s10 行为证明层同口径〕vs dbTxSync 版第三步抛错前两步全回滚）。
- [ ] 5 个改写函数的既有测试套件全绿（memory / plugin / mcp / review 相关用例是行为回归网）。
- [ ] `bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿；CI 全绿。
