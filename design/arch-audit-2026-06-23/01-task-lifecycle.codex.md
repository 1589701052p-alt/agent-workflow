# Codex 核验：任务/节点生命周期状态机 (01-task-lifecycle)

> 对应报告：`design/arch-audit-2026-06-23/01-task-lifecycle.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **LIFE-05 属实，P1 合理**：`resumeTask` 用 `r.id > prev.id` 按 `nodeId` 选最新行，未过滤 `parentNodeRunId !== null` 子行；随后把 `failed/interrupted` 最新行拿去按其 snapshot 回滚。见 `packages/backend/src/services/task.ts:1044-1052`、回滚调用 `packages/backend/src/services/task.ts:1068`。同仓权威 picker 默认过滤 child：`packages/backend/src/services/freshness.ts:290-304`。
- **LIFE-06 属实，P1 合理但范围更大**：`startTask` 和 `resumeTask` 有 commit&push 透传，`retryNode` 服务启动块没有。见 `packages/backend/src/services/task.ts:811-844`、`1090-1128`、`1360-1384`。此外 REST `/retry` 路由也没读取 `resolveCommitPushConfig`，所以不是只漏服务映射：`packages/backend/src/routes/tasks.ts:445-456`。
- **LIFE-01 基本属实，但“转移表”术语需修正**：task 侧确实只有 `setTaskStatus/trySetTaskStatus` + 调用点 `allowedFrom`，没有 `nextTaskStatus` 纯函数；见 `packages/backend/src/services/lifecycle.ts:200-296`。RFC-097 设计本身把“矩阵”落实为 caller-shaped `allowedFrom`，不是 node_run 那种事件表：`design/RFC-097-task-status-cas/design.md:6-23`、`47-64`。因此问题是“缺少可执行 SSOT”，不是实现偏离 RFC-097 CAS。
- **LIFE-03 属实，P2 合理**：不变式扫描是周期/启动后的事后 reconcile，T1/T2/U1 等检查在 `runLifecycleInvariants` 中手动执行：`packages/backend/src/services/lifecycleInvariants.ts:706-764`，循环默认 1h：`packages/backend/src/services/lifecycleInvariants.ts:786-812`。
- **LIFE-04 属实，偏设计债 P2**：`mintNodeRun` 允许直接 born `awaiting_review/awaiting_human/failed`，且明确状态机只治理 UPDATE 不治理 INSERT；见 `packages/backend/src/services/nodeRunMint.ts:15-22`、`42-45`、`138-157`。
- **LIFE-07 属实，P2 合理**：repair engine 直接 import `resumeTask`，并依赖 `isTaskActive` call-site gate：`packages/backend/src/services/lifecycleRepair.ts:41-42`、`293-307`，`packages/backend/src/services/lifecycleRepair/helpers.ts:12-28`。
- **EXT-3 / EXT-4 / LIFE-08 / LIFE-12 基本属实**：不变式 loop 仍手抄 `checkR1...checkCR1`：`packages/backend/src/services/lifecycleInvariants.ts:732-739`；前端本地重抄 task terminal/retryable：`packages/frontend/src/routes/tasks.detail.tsx:879-883`、`packages/frontend/src/components/NodeDetailDrawer.tsx:660-671`；task terminal 在 backend 而 node_run terminal 在 shared：`packages/backend/src/services/lifecycle.ts:200-203`、`packages/shared/src/lifecycle.ts:20-30`；CAS lost race 仅 warn：`packages/backend/src/services/scheduler.ts:449-460`、`477-488`、`502-515`、`4268-4285`。

## REFUTED / 伪问题（给反证 file:line）

- **LIFE-02 的若干“漂移”例子不能直接当 bug**：`cancelTask` fallback 允许 `pending/running` 是无 controller 或 scheduler 未落地时的兜底，源码注释明确“no controller exists; mark directly”：`packages/backend/src/services/task.ts:940-971`；scheduler 内部 `cancelTaskRow` 只允许 `running`，因为它发生在已 claim 的 runTask 路径：`packages/backend/src/services/scheduler.ts:4291-4305`。这是入口语义不同，不是同语义漂移。
- **wrapper revival 缺 `failed` 不是疑似遗漏**：`findResumableWrapperRun` 明确把 `done/failed/exhausted` 当终态返回 null，只让 `canceled/interrupted` 同一行续跑：`packages/backend/src/services/scheduler.ts:2592-2621`。测试也锁定 `done/failed` 要铸 placeholder、新 wrapper 行：`packages/backend/tests/retry-cascade-kind-matrix.test.ts:301-310`，fanout failed resume 重铸 wrapper：`packages/backend/tests/scheduler-audit-s18-s19-fanout-failure-semantics.test.ts:411-420`。
- **“RFC-097 已有转移表”不能作为反驳 LIFE-01**：RFC 文档称“转移矩阵”，但实际 API 就是 `allowedFrom` 参数；测试也按调用方 allowedFrom 抽样，而不是枚举 `from × event` 的 `nextTaskStatus`：`packages/backend/tests/rfc097-task-status-cas.test.ts:376-399`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **`retryNode` 先改 task 状态、后校验 nodeRunId — P1 — `packages/backend/src/services/task.ts:1173-1188`、`1198-1204` — 影响**：对 failed/done/canceled task 传不存在或跨 task 的 `nodeRunId`，会先把 task CAS 成 `pending` 并清空错误，再抛 `node-run-not-found`，没有 scheduler kick，留下被错误复活的 pending task。
- **HTTP resume/repair/retry 入口没有传 commit&push 配置 — P2 — `packages/backend/src/routes/tasks.ts:250-257`、`376-383`、`417-430`、`445-456` — 影响**：start 会读取并传入 commit&push settings，但 resume、repair 后 resume、retry 都不传；即使 `resumeTask` 服务层支持透传，常规 REST 入口仍会回退默认 commit&push 行为。
- **后端 stuck detector 也重抄 node_run terminal 集 — P3 — `packages/backend/src/services/stuckTaskDetector.ts:164-171` 对比 `packages/shared/src/lifecycle.ts:20-30` — 影响**：报告只指出前端镜像；实际上后端诊断也有一份 terminal 字面量。新增 node_run 状态时，stuck 分类可能和 shared 状态机漂移。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的总体方向正确，但建议把“统一状态机”拆成两步，不要一次性大改所有调用点。先引入 `TaskTransitionEvent`/`allowedFromForTaskEvent`，让现有 `setTaskStatus` 仍保持 RFC-097 的 CAS 与 `allowTerminal` 不变量；再逐步收敛调用点。这样不会破坏 RFC-097 的所有权锁语义。

`kickScheduler` 抽象值得做，但要同时修路由层配置解析；否则只抽服务函数仍会漏 `/resume`、repair、`/retry` 的 commit&push settings。抽象边界应包括“从 StartTaskDeps 到 RunTaskOptions 的映射”，但不要碰 opencode 注入/env 合并逻辑，避免影响现有 `OPENCODE_CONFIG_CONTENT` 优先级不变量。

mint post-hook/写入时断言可以做，但 prod 下应以 alert/结构化日志为主，避免在恢复和 repair 路径把历史脏数据变成新 hard failure。lease 替代 `isTaskActive` 是长期正确方向，但短期先把 repair option 的 liveness gate 类型化/集中化，收益更稳。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：主问题判断大体扎实，尤其 LIFE-05/LIFE-06/LIFE-01，但它把部分有意的 `allowedFrom` 特例说成漂移，并漏掉了 `retryNode` 校验顺序和 HTTP 入口配置透传这两个更直接的实现缺陷。
