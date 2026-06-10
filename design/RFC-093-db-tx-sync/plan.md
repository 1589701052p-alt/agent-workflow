# RFC-093 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-093 dbTxSync 同步事务助手（S-10 装饰性 async 事务清零）`。

## 子任务

### RFC-093-T1 — 原语 + 单测

- 新建 `packages/backend/src/db/txSync.ts`（design §1）。
- 新建 `packages/backend/tests/rfc093-db-tx-sync.test.ts`（design §4-2：原语四面 + review 三步序列红绿对照）。
- 依赖：无。

### RFC-093-T2 — 五处改写

- review.ts:505 / memory.ts:285 / memory.ts:415 / plugin.ts:237 / mcp.ts:126 按 design §2 机械改写；
  memory.ts 头注释修正。
- 回归：memory / plugin / mcp / review 既有套件全绿。
- 依赖：T1。

### RFC-093-T3 — 守卫翻转 + 收尾

- 翻转 `scheduler-audit-s10-*` 守卫层（清单清零 → 零容忍断言）。
- `design/plan.md` RFC 索引置 Done；`STATE.md` 登记。
- 门禁：`bun run typecheck` + 根 `bun test` + `bun run format:check`；推送后查 CI。
- 依赖：T1-T2。

## 验收清单

见 proposal.md「验收标准」。
