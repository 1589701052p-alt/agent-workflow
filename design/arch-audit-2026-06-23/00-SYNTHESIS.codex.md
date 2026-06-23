# Codex 核验：全仓架构综合与重构路线图 (00-SYNTHESIS)

> 对应报告：`design/arch-audit-2026-06-23/00-SYNTHESIS.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- freshest-run 旁路属实 — **P1** — `packages/backend/src/services/task.ts:1044-1052`  
  `resumeTask` 的 `latestPerNode` 按 `nodeId` + ULID 取最新，没有过滤 `parentNodeRunId !== null`；而 fanout shard 行确实以 `parentNodeRunId=wrapperRunId` 铸造（`packages/backend/src/services/scheduler.ts:3440-3443`）。报告结论成立。

- `retryNode` 漏传 commitPush 属实 — **P1** — `packages/backend/src/services/task.ts:1096-1114` vs `packages/backend/src/services/task.ts:1362-1374`  
  `resumeTask` 传了 `commitPushModel/maxRepairRetries/diffMaxBytes`，`retryNode` 没传。带 auto commit/push 的单节点重试会静默降级。

- opencode cache token 解析属实 — **P1 / security-adjacent** — `packages/backend/src/services/runner.ts:1787-1795`  
  解析器只读 `cache_creation/cache_read/cacheCreation/cacheRead`，真实 fixture 是 `tokens.cache.read/write`（`packages/backend/tests/fixtures/opencode-recordings/1.15.5-with-envelope.ndjson:4`）。限额依赖 `tok_total`（`packages/backend/src/services/limits.ts:75-80`），影响不只是 UI 统计。

- fanout `list<markdown>` 误分片属实 — **P1** — `packages/backend/src/services/scheduler.ts:3129-3132`  
  fanout 仍按 `\n` split；shared codec 明确说 `list<markdown>` 是 boundary 分隔、多行 body，不能换行切（`packages/shared/src/listWire.ts:25-35`, `packages/shared/src/listWire.ts:55-68`）。

- envelope 嵌套 `</port>` 截断属实 — **P1** — `packages/backend/src/services/envelope.ts:139-143`, `packages/backend/src/services/envelope.ts:254-256`  
  `PORT_RE` 是非贪婪正则到第一个 `</port>`，没有 XML/容器级解析；现有测试只覆盖普通多行内容（`packages/backend/tests/envelope.test.ts:106-115`）。

- `NODE_KIND_BEHAVIORS` 只接线一维属实，但严重级应降为 **P2 design debt** — `packages/shared/src/node-kind-behavior.ts:15-21`  
  文件注释已明说只有 `retryCascade` 运行时消费，其他维度是 future hook；这不是隐藏 bug，但确实不应被当成运行时 SSOT。

- 融合状态机死代码 / 无 CAS 属实 — **P1** — `packages/backend/src/services/fusion.ts:70-81`, `packages/backend/src/services/fusion.ts:620-629`  
  `isValidFusionTransition` 只在测试里被调用；实际 `setFusionStatus` 是裸 `where(id)`。`approveFusion` 先读 `awaiting_approval` 再写 `applying`（`packages/backend/src/services/fusion.ts:640-658`），存在竞态窗口。

- task 状态机“CAS 有、转移表无”属实 — **P1 design** — `packages/backend/src/services/lifecycle.ts:231-270`  
  task 写入依赖调用点手写 `allowedFrom`；node_run 才有 `nextNodeRunStatus` 单表和 exhaustive guard（`packages/shared/src/lifecycle.ts:87-160`）。

- 全局 semaphore 实为 per-task 属实 — **P1/P2 operational** — `packages/backend/src/services/scheduler.ts:389-403`  
  每次 `runTaskInner` 新建 `globalSem: new Semaphore(...)`，与 design 的“全局 semaphore”（`design/design.md:754-757`）不一致。

- OIDC post-login open redirect 属实 — **High** — `packages/backend/src/routes/oidc-auth.ts:36-42`, `packages/backend/src/routes/oidc-auth.ts:181-184`  
  `postLoginRedirect` 原样进入 flow，回调时拼上 `#aw_session=...` 后 `c.redirect`。若传入绝对 URL，会把 session token 放进攻击者 origin 的 fragment。

## REFUTED / 伪问题（给反证 file:line）

- “27 表的 `schema_version` 列从不写”表述不准确。当前 Drizzle schema 中可见 `schemaVersion` 列不是 27 处，而是有限几处，如 `packages/backend/src/db/schema.ts:439`, `packages/backend/src/db/schema.ts:517`, `packages/backend/src/db/schema.ts:1160`。  
  但 workflow 这一条的具体问题成立：`createWorkflow/updateWorkflow` 只写 migrated JSON definition，不写 DB `schemaVersion`（`packages/backend/src/services/workflow.ts:46-57`, `packages/backend/src/services/workflow.ts:79-88`），`rowToWorkflow` 又暴露 `row.schemaVersion`（`packages/backend/src/services/workflow.ts:173-183`）。

- `NODE_KIND_BEHAVIORS` 不应作为“已漂移成 bug”处理。源码明确标注其他四维只是未来意图、可与当前 kind-blind 路径不一致（`packages/shared/src/node-kind-behavior.ts:15-21`）。这是文档/扩展性债，不是当前行为 bug。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- GC 会删除可恢复任务的 worktree — **High** — `packages/backend/src/services/gc.ts:23-28`, `packages/backend/src/services/gc.ts:50-84` — `failed/interrupted` 被纳入 GC 候选，但 `resumeTask` 明确允许从这两种状态恢复（`packages/backend/src/services/task.ts:1001-1004`）。现有测试也把该行为锁为缺陷（`packages/backend/tests/scheduler-audit-gap3-gc-terminal-statuses.test.ts:1-10`）。影响：用户稍后 resume 时 worktree/快照语义可能已被 GC 破坏。

- `CLAUDE.md` 对 task 状态机描述已漂移 — **Medium** — `CLAUDE.md:142-143` vs `packages/backend/src/services/lifecycle.ts:231-270` — CLAUDE 说 task 写入有“CAS + 转移表”，实际只有 CAS + 调用点 `allowedFrom`。影响：后续 agent 按约束文件建立错误心智模型，容易漏掉本次报告里最关键的状态机重构前提。

- OIDC callback URL 生成信任转发 Host — **Medium** — `packages/backend/src/routes/oidc-auth.ts:196-211` — 未配置 `publicBaseUrl` 时使用 `X-Forwarded-Proto/X-Forwarded-Host` 拼 redirect_uri。影响：代理配置不严时可造成 OIDC redirect_uri poisoning/登录 DoS；虽不等同于 token 泄露，但应与 postLoginRedirect 白名单一起收敛。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

整体方向 **mostly sound**：先修漂移 bug，再统一状态写入，再做声明式 registry，比直接拆 scheduler 安全。

需要收敛但避免过度设计：`runScope` 统一和 scope 路径栈是 XL 级，不应早于 `NodeKind→端口`、worktree lifecycle、全局 coordinator。fanout 嵌套/链路支持没落地前，validator 的禁入墙应保留。

状态机重构不能把 RFC-097 的 CAS 语义抽薄：`resume/retry` 的 CAS 所有权锁必须继续发生在 rollback/kick 之前；`allowTerminal` 这类少数逃生口要显式建模，不要用泛化 `trySetStatus(table, id, from[], to)` 掩盖语义差异。

RFC-099 prompt 隔离必须作为资源注册表重构的硬测试：`ownerUserId/visibility` 不得进 `OPENCODE_CONFIG_CONTENT`（`packages/backend/tests/rfc099-prompt-isolation.test.ts:151-179`），review/clarify 的用户归属也不得进入 prompt（`packages/backend/tests/rfc099-prompt-isolation.test.ts:195-205`）。

OpencodeProcess 抽象必须保持现有 env 合并不变量：全量继承 `process.env`、强制 `PWD=worktreePath`、设置 `OPENCODE_CONFIG_DIR` 和最后胜出的 `OPENCODE_CONFIG_CONTENT`（`packages/backend/src/services/runner.ts:384-390`, `packages/backend/src/services/runner.ts:720-738`）。这部分不能被“清理 env”式重构破坏。

事务/after-commit 建议正确，但要符合 Bun sqlite 约束：`dbTxSync` 只能同步 body（`packages/backend/src/db/txSync.ts:31-43`），WS publish 应改成事务后 hook，而不是在事务体里 await/broadcast。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**。报告抓住了主要结构病灶和多个真实 P1 漂移 bug，但有少量表述夸大，并漏掉了“GC 删除可恢复 worktree”和权威约束文档漂移这类会直接误导后续实现的问题。
