# RFC-094 — 任务分解

单 PR（RFC 默认；main 直推）。commit 前缀：`fix(backend): RFC-094 validator 守门（loop 嵌 loop / fanout inner-chain 禁入 + boundary 边误报修复）`。

## 子任务

### RFC-094-T1 — validator 三改 + 新测试

- `wrapper-loop-nested`（error，传递上溯）+ `fanout-inner-chain-unsupported`（error，含豁免集）
  - 规则 2 boundary='wrapper-input' source-port 豁免（design §1）。
- 新建 `rfc094-validator-guardrails.test.ts`（design §5-1）。
- 依赖：无。

### RFC-094-T2 — audit 锁定翻转与核对

- 翻转 `scheduler-audit-s05-*` validator 层两条；跑通 s05 运行时层 / s06 全文件确认不受影响。
- 依赖：T1。

### RFC-094-T3 — S-18 文档归一（按批准时所选方案；默认 A）

- design/design.md fanout 失败语义改写 + scheduler.ts "fails-fast" 注释修正 +
  `scheduler-audit-s18-*` 头注释同步（design §2）。
- 依赖：无。

### RFC-094-T4 — S-26 注释清账 + 收尾

- design §3 清单逐处修正（纯注释）；computeReadyNodes 零引用则删（grep 前置）。
- `design/plan.md` RFC 索引置 Done；`STATE.md` 登记。
- 门禁：`bun run typecheck` + 根 `bun test` + `bun run format:check`；推送后查 CI。
- 依赖：T1-T3。

## 验收清单

见 proposal.md「验收标准」。
