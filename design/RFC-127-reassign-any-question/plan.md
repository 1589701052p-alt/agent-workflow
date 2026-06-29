# RFC-127 — 任务分解 / plan

> 依赖：无（借壳基建自包含）。**RFC-128 依赖本 RFC** 的借壳执行。
> 默认单 PR；过大则按「基建（不改用户可见行为）」→「切换（放开角色 + designer 切借壳 + 前端）」两 PR。
> migration 号取落地时下一个空号（现存最新 0066；RFC-127 先于 RFC-128）。

## 子任务

- **RFC-127-T1（基建·DB + mint）**：`node_runs` 加 `agent_override_name` 列（nullable）+ migration（journal +1 → 同步 bump `upgrade-rolling.test.ts`，[migration-bumps-journal-count-test]；多语句注意 `--> statement-breakpoint`）；`MintNodeRunOverrides`（`nodeRunMint.ts:70-89`）加字段、`buildMintNodeRunValues`（`:126-175`）写出；与 `inheritFrom` 正交。测：mint 带 override 落列；跨 tick 重派带 override（§7.4 回归锁）。
- **RFC-127-T2（调度器 agent 解析单点 + 端口契约）**：`runOneNode`（`scheduler.ts:1764-1772`）解析前读本行 `agent_override_name` → 非空用 X 的 agentName `getAgent`；必须早于 `prepareNodeRunInjection`（`:1797`）与 `resolveFrozenRuntime`（`:2659`）。借壳注入 `options.outputs` 用**原节点**声明（`buildInlineAgentEntry` `runner.ts:1675-1701` 改 outputs 取原节点、其余取 X）。测：借壳 run 用 X agent + 原节点 outputs；无 override 退回原节点 agent（黄金锁）。
- **RFC-127-T3（lineage / 相位口径）**：`resolveHandlerRun`（`shared/task-questions.ts:264-289`）借壳条目按**原节点** id 框 lineage（`effectiveTargetNodeId`=原节点，`override_target_node_id` 仅用于解析借用 agent）；统一全角色承接 run nodeId=原节点。测：借壳条目相位「处理中/已处理待确认」派生正确、后续不相关新轮不误拉。
- **RFC-127-T4（放开改派全角色）**：`canReassign`（`task-questions.ts:178-184`）从 `roleKind==='designer'` 改「任意角色 + 目标是工作流 agent 节点」；前端 `reassignable`（`TaskQuestionList.tsx`）改「任意角色 + 未下发态」。测：全角色可改派、非 agent/非工作流节点拒（422）、前端下拉。
- **RFC-127-T5（designer 切借壳·行为变更）**：designer 改派从「换节点 X 走 X 下游」（`taskQuestionDispatch.ts:658`）改为借壳（产出归 D、走 D 下游）；**替换** RFC-120 旧「走 X 下游」测试并注释行为变更来源。测：AC-6。
- **RFC-127-T6（readonly 随 X）**：验证写锁（`scheduler.ts:1912`）/ fanout（`:3977`）/ 回滚（`:2001`）随 X.readonly。测：AC-7（P readonly 借 X writer 占写锁；P writer 借 X readonly 不占）。
- **RFC-127-T7（下游接线 + park 解除）**：self/questioner 借壳 run done+输出后，原节点下游被调度并消费、`awaiting_human` park 解除（复用现有续跑 done 退 park 路径，design §3.5）、不死锁。测：AC-4。
- **RFC-127-T8（隔离 + 权限）**：借壳 run promptText 无改派人/归属（双层锁，仿 RFC-099/120 AC-13）；改派/下发经 `requireTaskMember`。测：AC-9/10。
- **RFC-127-T9（端口契约失败）**：X 未吐齐原节点端口 → envelope 校验失败（`runner.ts:1402-1424`）→ run failed → 相位回「处理中」。测：AC-5。

## 落地顺序（硬约束，design §10）

1. **先** T3（lineage 口径）+ T1（列/mint）→ **再** T4（放开角色）；否则放开后 self/questioner 改派按旧「换节点」路径 mint（nodeId=X），与借壳并存期产生错误下游。
2. T5（designer 切借壳）与 T4（放开）同 PR（都依赖借壳基建）；designer 行为变更测试先替换、避免红着合。
3. T2（端口契约）必须与 borrow 解析（T2 本身）同 PR——少了它 X 不吐原节点端口、下游拿空。

## PR 拆分

- **PR-A（基建，不改用户可见行为）**：T1+T2+T3+T6+T7+T9。
- **PR-B（切换，一次性）**：T4+T5+T8+前端 `reassignable`。

## 验收清单

proposal `AC-1`~`AC-10` 全绿；门槛 `bun run typecheck && bun run test && bun run format:check` + CI（lint+test×2OS+binary smoke+e2e+静态扫描）；Codex 设计 gate（落码前）+ 实现 gate（每 PR 前）各跑；push 后查 CI（[feedback-post-commit-ci-check]）。
