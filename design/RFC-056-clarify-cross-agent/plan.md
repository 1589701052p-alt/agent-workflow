# RFC-056 Plan — 任务分解与 PR 拆分

> 状态：Draft（2026-05-22）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)

## 1. 子任务编号 & 依赖

| Task ID    | 描述                                                                                                  | Size | Deps                  |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | --------------------- |
| RFC-056-T1 | shared schemas + NodeKind + validator + NODE_KIND_BEHAVIORS                                           | M    | —                     |
| RFC-056-T2 | shared/clarify-cross.ts 纯函数（buildExternalFeedbackBlock / summariseCrossAnswer / DTO）             | S    | T1                    |
| RFC-056-T3 | shared/prompt.ts 3 个 builtin token + `## External Feedback` auto-append                              | S    | T2                    |
| RFC-056-T4 | backend migration 0029（cross_clarify_sessions 表 + node_runs.cross_clarify_iteration 列）+ 单测      | S    | —（与 T1-T3 可并行） |
| RFC-056-T5 | backend services/crossClarify.ts（session lifecycle / 多源等待 / reject 持久 / abandoned invariant） | L    | T1, T2, T3, T4        |
| RFC-056-T6 | backend scheduler / runner hook（envelope mode 标识 / cross dispatch / cascade reset / inline 复用）  | L    | T5                    |
| RFC-056-T7 | REST + WS（/api/clarify 路径分支 + 4 个 cross-clarify WS event）                                      | M    | T5, T6                |
| RFC-056-T8 | frontend chip + Reject button + 二次确认 modal + 多源 banner + i18n keys                              | M    | T7                    |
| RFC-056-T9 | frontend canvas drag（反向 + manual to_designer + 动态 \_\_external_feedback\_\_）+ NodeInspector segmented | M    | T1, T8                |
| RFC-056-T10 | Playwright e2e + 回归防护守门 + STATE.md / plan.md 索引标 Done                                       | M    | T1-T9                 |

总体规模：3L + 4M + 3S，估计单人 12-16 个工作日。

## 2. 详细任务说明

### RFC-056-T1 — shared schemas + NodeKind + validator + NODE_KIND_BEHAVIORS

**目标**：把 `clarify-cross-agent` 升为合法 NodeKind，框架其余部分（validator / lifecycle / behavior table）感知它。

**子项**：

- `packages/shared/src/schemas/workflow.ts`：
  - 加 `CROSS_CLARIFY_INPUT_PORT_NAME` / `CROSS_CLARIFY_OUT_TO_DESIGNER_PORT` / `CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT` / `CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT` 常量。
  - 新 `ClarifyCrossAgentSessionMode` 联合 + `ClarifyCrossAgentNodeSchema` zod schema + node 定义。
  - `NodeKind` union 加 `'clarify-cross-agent'`；`WorkflowDefinitionSchema.nodes` 加分支。
  - `$schema_version` 枚举加 4；`migrateWorkflowDefinition(v3 → v4)` no-op helper。
- `packages/shared/src/workflow-validator.ts`：加 7 条规则（详见 design.md §2.2）。
- `packages/shared/src/node-kind-behavior.ts`：`NODE_KIND_BEHAVIORS` 加 `'clarify-cross-agent'` 条目（retryCascade / limits / orphanReap / gc / shutdown 5 维度）。
- `packages/shared/src/lifecycle.ts`：转移矩阵加 cross-clarify 节点专属合法转移（pending → awaiting_human、awaiting_human → answered / abandoned）。

**测试**（≥ 6 case）：

- node schema parse happy + 缺字段拒。
- $schema v3 → v4 transparent upgrade。
- 7 validator 规则各 1 case。
- NODE_KIND_BEHAVIORS exhaustiveness 编译期 + 1 runtime 断言。

### RFC-056-T2 — shared/clarify-cross.ts 纯函数

**目标**：cross-clarify 路径专属的纯函数沉淀到独立模块，与 RFC-023 `shared/clarify.ts` 并列、不互相 import（避免循环依赖）。

**子项**：

- `buildExternalFeedbackBlock(sources: CrossClarifySourceContext[]): string`：按 nodeId 字典序渲染 `## External Feedback (round N)` 块 + 每 source `### From '{nodeId}' (round {iter})` 子段 + 题目 / 答案 / synthesis。
- `summariseCrossAnswer(question, answer): string`：单题 framework synthesis（reuse `summariseClarifyAnswer` 单题路径）。
- `parseCrossClarifyEnvelopeBody(jsonText)`：直接复用 `parseClarifyEnvelopeBody(jsonText, { maxQuestions: Infinity })`，包装一下命名。
- DTO 类型 `CrossClarifySourceContext` / `CrossClarifySessionRow` 等。
- `CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE = '## External Feedback'` 常量（供 grep 守门）。

**测试**（≥ 5 case）：

- buildExternalFeedbackBlock 单源 / 多源（字典序）。
- summariseCrossAnswer single+custom / multi+custom / pure。
- parseCrossClarifyEnvelopeBody 问题数 1+ / ≥ 5 都不截断、其余截断 reuse。

### RFC-056-T3 — shared/prompt.ts builtin token + auto-append

**目标**：designer prompt 注入框架支持 cross-clarify。

**子项**：

- `packages/shared/src/prompt.ts`：
  - `BUILTIN_TOKENS` 加 `__external_feedback__` / `__external_feedback_iteration__` / `__external_feedback_sources__` 三个。
  - `renderUserPrompt` 实现：未引用任一 cross token 时 auto-append `## External Feedback` 段（位置：紧贴 `## Self Clarify Q&A` 之后、ask-bias preamble 之前）。
  - 协议块扩展：designer 节点检测到挂了 `__external_feedback__` 端口（即被 cross-clarify manual-edge 指向） → user prompt 末尾追加一行说明 "你可能会收到来自外部反问者的 Q&A，请将它们写进设计文档"。

**测试**（≥ 4 case）：

- 3 token 渲染正确（含空 sources 边界）。
- auto-append 位置 vs `## Self Clarify Q&A` 顺序。
- 协议块在 hasExternalFeedbackChannel=true 时含说明字符串、false 时不含。

### RFC-056-T4 — backend migration 0029 + node_runs 列

**目标**：DB 层 schema 完工。

**子项**：

- `packages/backend/src/db/migrations/0029-cross-clarify.ts`：详见 design.md §3.2 SQL。包含 `cross_clarify_sessions` 表 + 4 索引 + `node_runs.cross_clarify_iteration` 列。
- `packages/backend/src/db/schema.ts`：drizzle schema 加 `crossClarifySessions` 表对象 + `nodeRuns.crossClarifyIteration` 列。
- migration 测试：表创建 + ALTER 加列 + 索引存在 + 已有行 cross_clarify_iteration=0。

**测试**（≥ 3 case）：

- migration 上行 OK + 表存在 + 索引存在。
- 已有 node_runs 行透明默认 0。
- FK ON DELETE CASCADE 工作。

### RFC-056-T5 — backend services/crossClarify.ts + abandoned invariant

**目标**：cross-clarify 节点全生命周期 service。

**子项**：

- `packages/backend/src/services/crossClarify.ts`：
  - `createSession({ taskId, crossClarifyNodeId, questionerNodeRunId, questions, loopIter })` → 写新 row + 进 awaiting_human + 广播 WS。
  - `commitAnswers(sessionId, { answers, directive, ifMatchIteration })` → 乐观锁更新 + 触发 designer rerun（submit） / 触发 questioner stop rerun（reject）。
  - `evaluateDesignerRerunReadiness(taskId, designerNodeId)`：多源汇总等待判定逻辑（详见 design.md §5.2）。
  - `triggerDesignerRerun(designerNodeId, sources)`：rollback + 新 node_run + cascade reset + prompt 注入 sources。
  - `triggerQuestionerStopRerun(questionerNodeRunId)`：cascade reset questioner + prompt 注入 STOP CLARIFYING。
  - `dispatchCrossClarifyNode(nodeRunId)`：dispatch 时检测 reject 持久 stop，命中直接 done with reason='persistent-stop'。
- `packages/backend/src/services/lifecycleInvariants.ts`：加 CR-1 invariant rule（abandoned 升级，详见 design.md §10）。
- `packages/backend/tests/cross-clarify-service.test.ts` 等 12 个 case 覆盖 §B3 service 部分。
- `packages/backend/tests/cross-clarify-abandoned-invariant.test.ts` 3 case。

**测试**（≥ 15 case）：

- 12 service case（详见 proposal.md §B3）。
- 3 abandoned invariant case（happy 升级 / 幂等扫 / 不误升 in-flight）。

### RFC-056-T6 — backend scheduler / runner hook + inline 复用 helper

**目标**：runtime 层把 cross-clarify 接到 scheduler / runner / cascade 路径。

**子项**：

- `packages/backend/src/runner.ts`：
  - envelope 解析时按 NodeKind 选 maxQuestions（self=5 / cross=∞）。
  - questioner emit clarify 后先检测 persistent stop 再决定 fail / create session。
  - `spawnWithOptionalInlineSession` helper 抽出，self / cross-designer / cross-questioner 三路径复用。
- `packages/backend/src/scheduler.ts`：
  - cross-clarify 节点 dispatch 分支（persistent stop 跳过 awaiting / 否则等 envelope）。
  - designer 重跑被 multi-source ready 触发后走新 node_run + cross_clarify_iteration+1 + sibling cascade。
  - questioner cascade rerun 时按 cross_clarify_sessions.directive 决定走 STOP 还是 ask-bias preamble 注入。
  - wrapper-loop 新 iter 时正确写 loop_iter（cross_clarify_sessions 每 iter 起始时 iteration=0、Q&A 列表对该 (node, loop_iter) 而言是空的）。
- `packages/backend/src/services/cascadeReset.ts`（或现有 RFC-014 cascade helper）：cross-clarify 节点 cascade reset 时不重置 directive='stop'（保留），但删除 awaiting/answered 但未消费的 directive='continue' 行（让下轮重开 awaiting）。

**测试**（≥ 12 case）：

- scheduler 8 case（详见 proposal.md §B3）。
- inline 4 case（详见 §B3）。

### RFC-056-T7 — REST + WS

**目标**：API 层暴露 cross-clarify 数据 + WS 实时同步。

**子项**：

- `packages/backend/src/routes/clarify.ts`：
  - `GET /api/clarify` 列表：把 cross_clarify_sessions 与 clarify_sessions 混排（按 created_at），列表项 DTO 加 `kind: 'self' | 'cross'`。
  - `GET /api/clarify/:nodeRunId` 详情：按 node kind 分支返回 self / cross DTO。
  - `POST /api/clarify/:nodeRunId/answer` 路由 dispatch 到 clarifyService 或 crossClarifyService（按 node kind 分支）；request body 含 `directive: 'continue' | 'stop'`（self-clarify 路径只接受 continue）。
- `packages/shared/src/schemas/ws.ts`：加 4 个 `cross-clarify.*` event variant。
- `packages/backend/src/services/wsBroadcast.ts`：在 service 各路径处调 broadcast。

**测试**（≥ 6 case）：

- REST + WS 6 case（详见 proposal.md §B3）。

### RFC-056-T8 — frontend chip + Reject button + modal + banner

**目标**：/clarify 路由 UI 支持 cross-clarify 节点 + 多源等待提示。

**子项**：

- `packages/frontend/src/routes/clarify/index.tsx`：列表项加 chip self / cross。
- `packages/frontend/src/routes/clarify/$nodeRunId.tsx`：详情页底部 footer 按 NodeKind 分支：cross 路径多 Reject 按钮 + 二次确认 modal + 多源等待 banner。
- `packages/frontend/src/i18n/zh-CN/clarify.json` / `en-US/clarify.json`：新增 keys（`crossClarify.button.reject` / `crossClarify.rejectModal.title` / `crossClarify.rejectModal.body` / `crossClarify.rejectModal.confirm` / `crossClarify.multiSourceBanner` / `clarify.list.chip.self` / `clarify.list.chip.cross` 等）。
- 复用 `<Dialog>` / `<Banner>` / `<Button variant='danger'>` / `<Chip>` 公共组件（RFC-035 已有原语）。

**测试**（≥ 8 case）：

- chip 渲染 / Reject 按钮仅 cross 渲染 / Reject 二次确认 modal / Submit/Reject 都要求填完推荐题 / 多源等待 banner / banner 跳转链接 / i18n 双语对称 / 多 tab WS 同步切只读。

### RFC-056-T9 — frontend canvas drag + NodeInspector

**目标**：编辑器支持 cross-clarify 节点拖拽、连线、字段配置。

**子项**：

- `packages/frontend/src/canvas/Palette.tsx`：Human 分类下加 "Cross Clarify"（新 NodeKind palette item）。
- `packages/frontend/src/canvas/handleConnect.ts`：扩展反向拖动 helper（cross-clarify ↔ agent-single：自动建 2 条边）+ 正向拖动 cross.to_designer → agent-single：动态注册 `__external_feedback__` target handle。
- `packages/frontend/src/canvas/NodeInspector.tsx`：cross-clarify 节点 Inspector 加 2 个 Segmented（sessionModeForDesigner / sessionModeForQuestioner）。
- `packages/frontend/src/canvas/Node.tsx` 或类似：cross-clarify 节点视觉表达（1 input + 2 outputs handle 渲染）。

**测试**（≥ 9 case）：

- canvas drag 5 case + Inspector 4 case（详见 proposal.md §B4）。

### RFC-056-T10 — e2e + 回归防护守门 + 完工记录

**目标**：e2e 闭环 + 守门测试落库 + STATE.md / plan.md 索引标 Done + 推 CI。

**子项**：

- `packages/frontend/e2e/cross-clarify.spec.ts`：覆盖 A1 happy path + fixture `stub-opencode` 5 轮 spawn 编排。
- C1-C9 9 条回归防护测试（详见 proposal.md §C）。
- `STATE.md` 顶部 "进行中 RFC" 行改为 RFC-056 Done 记录 + commit hash + CI run id。
- `design/plan.md` RFC 索引行 Draft → Done。

**测试**（≥ 10 case）：

- e2e 1 case。
- C1-C9 9 条守门。

## 3. PR 拆分建议

按依赖与代码模块切，推荐 **4 PR**：

| PR    | Tasks           | 主要文件                                                                                       | Commit message 前缀                                                              |
| ----- | --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PR-A  | T1 + T2 + T3 + T4 | shared/schemas + shared/clarify-cross.ts + shared/prompt.ts + migration 0029                  | `feat(shared+db): RFC-056 NodeKind + cross-clarify 纯函数 + builtin token + migration 0029` |
| PR-B  | T5 + T6 + T7    | backend services/crossClarify.ts + invariant CR-1 + scheduler/runner hook + REST + WS         | `feat(backend): RFC-056 cross-clarify runtime + scheduler + REST/WS`             |
| PR-C  | T8 + T9         | frontend /clarify chip + Reject + modal + banner + canvas drag + NodeInspector + i18n         | `feat(frontend): RFC-056 cross-clarify UI + canvas + Inspector`                  |
| PR-D  | T10             | e2e + C1-C9 守门 + STATE.md + plan.md 索引标 Done                                              | `test(e2e+regression): RFC-056 cross-clarify 端到端 + 9 条守门 + 收官`           |

每个 PR 落地约束：

- **每个 PR 三件套全绿**：`bun run typecheck && bun run test && bun run format:check`。
- **PR-A 三件套全绿 + DB migration test 单独跑通**才能开 PR-B。
- **PR-B 三件套全绿 + 新增 service / scheduler / REST / WS 测试全绿**才能开 PR-C。
- **PR-C 三件套全绿 + frontend vitest 全绿**才能开 PR-D。
- **PR-D 推 CI 后等 6 jobs 全绿**才能在 STATE.md 标 Done（参考 RFC-053 / RFC-054 / RFC-055 完工记录格式）。
- 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。

## 4. 验收清单

完工前逐条核对：

### 功能（对照 proposal.md §A）

- [ ] A1 — S1 happy path e2e 通过
- [ ] A2 — designer prompt 注入断言级覆盖单选 / 多选 / custom
- [ ] A3 — 多源等待：第一个 submit 后 designer 不重跑；全部解决后重跑一次、含多 source 子段
- [ ] A4 — reject 触发 questioner stop rerun；designer 不重跑
- [ ] A5 — reject 持久性跨 cascade 多次
- [ ] A6 — wrapper-loop iter 1 reject → iter 2 questioner 仍带 STOP；iter 2 Q&A 历史复位 / cross_clarify_iteration 重置
- [ ] A7 — 互斥 envelope reuse RFC-023 错误码
- [ ] A8 — 问题数 1+ 无上限
- [ ] A9 — 选项数仍 ≤ 4 截断 + warning
- [ ] A10 — options=1 fail
- [ ] A11 — v3 → v4 transparent upgrade
- [ ] A12 — cross_clarify_iteration / clarify_iteration 正交
- [ ] A13 — agent-multi 拒 fail
- [ ] A14 — 同 agent 自审 warning
- [ ] A15 — abandoned 状态升级
- [ ] A16 — inline 模式 happy（spawn 含 --session + 精简 prompt）
- [ ] A17 — inline 回退 warning
- [ ] A18 — manual edge 缺 warning + 运行时找不到 target fail
- [ ] A19 — 多 tab WS 同步切只读
- [ ] A20 — chip self/cross 区分
- [ ] A21 — reject 后 questioner 仍 emit clarify → warning + 不创建新 awaiting

### 非功能（对照 proposal.md §B）

- [ ] B1 — bun run typecheck && bun run test && bun run format:check 全绿
- [ ] B2 — RFC-023 / 026 / 039 / 014 既有套件零退化（含 `services/review.ts` diff = 0 守门）
- [ ] B3 — backend tests ≥ +40
- [ ] B4 — frontend tests ≥ +18
- [ ] B5 — e2e/cross-clarify.spec.ts 新文件覆盖 A1
- [ ] B6 — 单二进制构建包体积 / 启动时间不退化

### 回归防护（对照 proposal.md §C）

- [ ] C1 — envelope reuse 守门
- [ ] C2 — 3 token + auto-append 文案 grep 守门
- [ ] C3 — 多源等待
- [ ] C4 — reject 持久性 cross-cascade
- [ ] C5 — wrapper-loop 部分持久
- [ ] C6 — 7 validator 规则枚举
- [ ] C7 — inline 回退枚举
- [ ] C8 — self + cross 共存隔离
- [ ] C9 — abandoned invariant

### 落地

- [ ] migration 0029 上行可跑 + 单测绿
- [ ] STATE.md 顶部 "进行中 RFC" 改为 Done 记录（commit hash + CI run id）
- [ ] design/plan.md RFC 索引 Draft → Done
- [ ] GitHub Actions 六 jobs 全绿（Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary smoke × {macos, ubuntu} + Playwright e2e × {macos, ubuntu}）

## 5. 风险缓解（实施层）

详见 proposal.md §7。本节补 4 条实施层风险：

| 风险                                                           | 缓解                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| RFC-023 既有套件意外退化（envelope parser 改造）               | parser 加可选参数 default = 旧值；新增独立测试守门旧路径字节级一致                                |
| `services/review.ts` 在 PR-B 中被无意改到                      | PR-B diff guard：禁文件出现在 git diff（不在白名单内）；CI 加 grep 守门                           |
| frontend ClarifyForm 组件 cross / self 分支膨胀                | 拆 footer 子组件 `<CrossClarifyFooter>`，主组件按 node kind 选 footer，业务逻辑分离               |
| migration 0029 在已运行 RFC-053 invariant 的 daemon 上启动失败 | invariant CR-1 在 migration 0029 上行后才生效；daemon 启动顺序：先 migration 跑完、再 invariant 注册 |

## 6. 实施顺序提示

接手 session 时：

1. 先读 STATE.md 找 RFC-056 进度（顶部 "进行中 RFC" 行 + 已 push commit）。
2. 读 design.md 找最新决策。
3. 读本 plan.md 找下一个 T-N 任务。
4. 实现 + 测试 + push + 查 CI（[feedback_post_commit_ci_check]）。
5. 完工后更新 STATE.md（commit hash + CI run id）+ 本 plan.md 验收清单打勾。
