# RFC-W004 Plan - Agent 反问上游 Agent（Clarify-to-Agent）任务分解

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> 编号规则：`RFC-W004-T{N}`，依赖标注 `依赖 T{x}`。

## 总览

3 PR 交付：

- **PR-1（编辑面）**：shared 类型 + DB migration + validator + 前端节点/inspector。目标：用户能画、能配、能保存 to-agent 节点，运行时 stub 守卫拒跑（防落跑半成品）。
- **PR-2（运行时）**：backend service + runner + scheduler + prompt 注入 + lifecycle + invariant。目标：to-agent 真正跑通 B->A->B 全链。撤 PR-1 守卫。
- **PR-3（e2e + 收尾）**：Playwright e2e + WS + 看板 + 门禁收尾 + RFC 索引 Done。

每 PR 自带测试（CLAUDE.md「测试随每次改动落地」），`bun run typecheck && bun run test && bun run format:check` 全绿才推。每个 RFC 改动按 `feat(scope): RFC-W004 ...` 前缀，走新分支 + PR 合并回 main。

---

## PR-1：编辑面（能画能配能保存）

### T1 shared NodeKind + 端口常量 + nodePorts
依赖：无。
deliverable：
- `packages/shared/src/schemas/workflow.ts`：NodeKind 联合追加 `'clarify-to-agent'`；`NODE_KINDS` 数组同步；端口常量 `TO_AGENT_CLARIFY_INPUT_PORT_NAME` / `TO_AGENT_OUT_TO_ANSWERER_PORT` / `TO_AGENT_OUT_TO_QUESTIONER_PORT` / `TO_AGENT_CLARIFY_REQUEST_PORT`。
- `packages/shared/src/nodePorts.ts`：to-agent 端口声明分支（1 in `questions` + 2 out `to_answerer`/`to_questioner`，userEditable 空）；agent-single `systemInputs` 追加 `__clarify_request__`。
测试：
- `tests/shared/node-ports-to-agent.test.ts`：to-agent 端口固定形态断言；agent-single 含 `__clarify_request__` 断言；既有 agent-single caller（cross-clarify inspector 等）零回归。

### T2 shared buildToAgentAutoEdges + isClarifyChannelEdge 扩展
依赖：T1。
deliverable：
- `packages/shared/src/clarify.ts`：`buildToAgentAutoEdges(toAgentNodeId, questionerBId)` 返 2 条自动边（B.`__clarify__`->questions / to_questioner->B.`__clarify_response__`）；`isClarifyChannelEdge`（`:581`）识别 to-agent 通道边。
测试：
- `tests/shared/build-to-agent-edges.test.ts`：2 条边形态 byte 级断言；既有 `buildClarifyEdges` / `buildCrossClarifyAutoEdges` 零回归（strict diff guard）。

### T3 shared envelope schema + protocol block
依赖：T1。
deliverable：
- `packages/shared/src/clarify.ts`：`ClarifyAnswerEnvelopeSchema`（`{ markdown: string(min 1) }`）；`buildToAgentProtocolBlock`（`## Clarify Request` 协议指令文本，含 `<workflow-clarify-answer>` 输出指令 + "不清楚则 `<workflow-clarify>` 问人"指令 + 互斥警告）。
测试：
- `tests/shared/clarify-answer-envelope.test.ts`：schema happy / malformed / 缺 markdown / 空 markdown；protocol block 文本 grep 锁（`<workflow-clarify-answer>` / `## Clarify Request` 出现）。

### T4 shared lifecycle 决策（复用 awaiting_human，无新状态/token）
依赖：无。

**设计简化（见 design §2.7 / §6.1）**：to-agent node_run **复用 `awaiting_human` 状态**（mint 用 `park-human` 事件，A 答 -> `done` 用 `resume-clarify` 事件），不新增 `awaiting_human` 状态、不新增 `park-answer`/`resume-answer` 事件、不新增 `{{__clarify_request__}}` 等 builtin token。理由：`awaiting_human` 在 scheduler/stuckTaskDetector/workgroupRunner 有 ~20 触点，新增状态会触发全量扩散 + s12 status-bucket-universe 审计锁翻红；`awaiting_human` 天然覆盖"等答案"语义（人答/agent A 答同构）。UI 区分靠节点 kind（`clarify-to-agent`），不靠状态值。

deliverable：**无 shared 代码改动**（lifecycle/prompt/schemas/task 均不动）。本任务退化为"设计决策记录"--确认 T1-T3 已无 `awaiting_human` 残留、typecheck 全绿即可。
测试：并入 T1 的 `clarify-to-agent-rfc-w004-shared.test.ts`（NodeKind/行为表/端口，已覆盖）。不再有独立 `lifecycle-awaiting-answer.test.ts`（无新状态可测）。

> 验收对照：proposal A12（原要求 `awaiting_human` 状态）在实现期简化为复用 `awaiting_human`，A13 invariant 改为扫 `clarify_rounds` kind='to-agent' status='awaiting_human' 的 abandoned 升级（T15）。

### T5 backend DB migration + schema.ts
依赖：T4（kind 枚举值）。
deliverable：
- `packages/backend/src/db/schema.ts`：`clarify_rounds` `kind` CHECK 加 `'to-agent'`（`:1468`）；新增列 `answerer_node_id` / `answerer_node_run_id`（self/cross NULL）；`node_runs` 加 `to_agent_iteration INTEGER NOT NULL DEFAULT 0`。
- migration `0090`（journal bump，以 schema.ts 顶部计数为准）：forward ADD COLUMN + CHECK 更新 + 既有行新列默认 NULL（零 backfill）。
测试：
- `tests/rfc-w004-migration-0090.test.ts`：kind 接受 'to-agent'；self/cross 行新列 NULL；to-agent 行写入读回；幂等。

### T6 backend validator §4e + multiplicity + 系统端口完整性 + 环豁免
依赖：T1, T2。
deliverable：
- `packages/backend/src/services/workflow.validator.ts`：§4e to-agent 9 规则（design §5 表）；§4d-bis 系统端口完整性扩展（`__clarify_request__` 源必须是 to-agent `to_answerer`）；RFC-069 multiplicity 预检扩展（`clarify-to-agent-multiple-on-answerer`：A.`__clarify_request__` 被 ≥2 to-agent 指向 fail；`clarify-to-agent-multiple-answerers`：单 to-agent `to_answerer` 连 ≥2 A fail）；拓扑环豁免扩展（`:427-459` 跳过 `clarify-to-agent` 节点）。
测试：
- `tests/clarify-to-agent-validator-rules.test.ts`：9 规则 + multiplicity 2 + 系统端口完整性 2 + 环豁免 1，逐 case 覆盖 happy + 各 fail/warning（≥ 14 case，design §8.4）。

### T7 frontend 节点 + inspector + palette
依赖：T1, T2。
deliverable：
- `packages/frontend/src/components/canvas/nodes/ToAgentClarifyNode.tsx`：画布节点渲染（复用 ClarifyNode/CrossClarifyNode 视觉风格，RFC-035 公共组件）。
- `packages/frontend/src/components/canvas/inspector/ToAgentClarifyEdit.tsx`：inspector（title / description / linked questioner B 只读 / linked answerer A 只读 / in-loop 状态只读 / `sessionModeForAnswerer` Segmented isolated|inline）。
- palette 登记 to-agent 节点（与 clarify/cross-clarify 并列）；canvas drag 接线（反向拖动建 2 自动边 + 手动拖 to_answerer 动态注册 `__clarify_request__`）。
- i18n zh-CN/en-US。
测试：
- `tests/frontend/to-agent-node.test.tsx`：节点渲染 + inspector 字段 + sessionMode Segmented + 反向拖动建边 + 动态注册 `__clarify_request__` 端口（≥ 6 case）。

### T8 backend 运行时 stub 守卫（防 PR-1 落跑）
依赖：T6。
deliverable：
- `packages/backend/src/services/scheduler.ts`：to-agent 节点运行时（若被 dispatch）reject `workgroup-dynamic-not-implemented` 同款 422/fail 守卫（对齐 RFC-167 PR-1），message `to-agent-runtime-not-implemented`，提示等 PR-2。validator 不阻保存（编辑面可用），只阻运行。
测试：
- `tests/clarify-to-agent-stub-guard.test.ts`：to-agent 节点 dispatch -> fail `to-agent-runtime-not-implemented`；保存/编辑不阻。

---

## PR-2：运行时（真正跑通 B->A->B）

### T9 backend service toAgentClarify.ts
依赖：T5, T3。
deliverable：
- `packages/backend/src/services/toAgentClarify.ts`（新建）：
  - `createToAgentSessionAndTriggerAnswerer`（design §3.1）：解析 to_answerer 找 A + 多源汇总屏障 + mint to-agent node_run `awaiting_human` + 插 clarify_rounds kind='to-agent' + 广播 created + 触发 A 重跑 cause=`clarify-to-agent-answer`。
  - `commitToAgentAnswerAndTriggerQuestioner`（design §3.2）：更新 clarify_rounds answered + to-agent node_run answered + 广播 answered + 触发 B 重跑 cause=`clarify-to-agent-questioner-rerun`。
  - `escalateToHuman`（design §3.3）：A 吐 clarify 时 to-agent 保持 awaiting_human + 广播 escalated（A 的 self-clarify 走既有 RFC-023 路径）。
  - `evaluateAnswererRerunReadiness`（多源屏障，对齐 RFC-056 `evaluateDesignerRerunReadiness`）。
测试：
- `tests/clarify-to-agent-service.test.ts`：createSession / commitAnswer / escalate / 多源汇总 / answerer-missing / iteration / loop_iter 隔离（≥ 8 case）。

### T10 backend runner envelope 解析 + 互斥校验
依赖：T3。
deliverable：
- `packages/backend/src/services/runner.ts`：envelope 解析（`:1200-1234` 附近）新增 `<workflow-clarify-answer>` tag -> `result.clarifyAnswer`；互斥校验（design §4）：answer+output / answer+clarify / timeout-no-answer 三 fail。
测试：
- `tests/clarify-to-agent-envelope.test.ts`：answer happy + 3 互斥 fail + malformed（≥ 6 case，design §8.4）。

### T11 backend scheduler dispatch 三分流 + frontier
依赖：T9, T10。
deliverable：
- `packages/backend/src/services/scheduler.ts`：clarify dispatch 入口（`:3422-3513`）扩展三分流（self / cross / **to-agent**），to-agent 分流调 `createToAgentSessionAndTriggerAnswerer`；`loadOpenClarify`（`:1238-1271`）扩展收集 awaiting_human to-agent session 作 frontier 证据；`completed` 判定（`:1605-1614`）不含 awaiting_human。
测试：
- `tests/clarify-to-agent-scheduler.test.ts`：B 提问 dispatch / A 回答 dispatch / A 升级 bubble / frontier 不误推 / 多源汇总 / loop max_iter（≥ 6 case）。

### T12 backend A 回答回流 B + A 升级 bubble
依赖：T11。
deliverable：
- scheduler：A 跑完吐 clarifyAnswer -> `commitToAgentAnswerAndTriggerQuestioner` 回流 B；A 吐 clarify -> `escalateToHuman`（to-agent 保持 awaiting_human，A 的 self-clarify park awaiting_human）。
测试：
- 并入 `tests/clarify-to-agent-scheduler.test.ts`（A 回答回流 + A 升级 bubble 全链断言）。

### T13 backend prompt 注入
依赖：T4, T9。
deliverable：
- `packages/shared/src/prompt.ts` `renderUserPrompt` 扩展：A 是 to-agent answerer 重跑时注入 `ClarifyRequestPromptContext` -> `## Clarify Request` 段（含问题清单 + 协议指令），未引用 token 时 auto-append。
- `packages/backend/src/services/clarifyQueue.ts` `selectAgentQueue` 扩展：选 to-agent answered session，A 回答 markdown 作 `FlatClarifyEntry` 进 B 的 flat `## Clarify Q&A` block。
测试：
- `tests/clarify-to-agent-prompt-injection.test.ts`：`## Clarify Request` 单源/多源 + 3 token grep + auto-append + B 侧 flat block 含 A 回答（≥ 5 case）。

### T14 backend rerun cause + nodeRunMint + gates
依赖：T4。
deliverable：
- `packages/backend/src/services/clarifyRerunLedger.ts`（`:28-34`）+ `nodeRunMint.ts`（`:261-262`）：新增 cause `clarify-to-agent-answer`（isClarifyRerun=TRUE）/ `clarify-to-agent-questioner-rerun`（TRUE）；`RERUN_CAUSES` + gates 表同步登记。
测试：
- `tests/clarify-to-agent-rerun-cause.test.ts`：2 cause isClarifyRerun 断言 + gates 表登记。

### T15 backend RFC-053 invariant
依赖：T5, T9。
deliverable：
- `packages/backend/src/services/lifecycleInvariants.ts`（或 invariant 扫描处）：daemon 启动 + 每小时扫 `clarify_rounds` kind='to-agent' status='awaiting_human'，answerer node_run 已终态 -> 升级 `abandoned`。
测试：
- `tests/clarify-to-agent-abandoned-invariant.test.ts`：awaiting_human + answerer failed -> abandoned；扫描幂等（≥ 3 case）。

### T16 撤 PR-1 T8 守卫
依赖：T11-T15。
deliverable：
- 删 scheduler 的 `to-agent-runtime-not-implemented` 守卫；to-agent 可跑。
测试：
- `tests/clarify-to-agent-stub-guard.test.ts` 改为"守卫已撤，to-agent 可 dispatch"断言。

---

## PR-3：e2e + WS + 收尾

### T17 Playwright e2e
依赖：T16。
deliverable：
- `e2e/clarify-to-agent.spec.ts`：fixture stub-opencode，A->B + to-agent，A 产 `<workflow-clarify-answer>`，B 带回答产出 output -> task done（覆盖 proposal A1）。
测试：e2e 本身。

### T18 WS 事件 + 前端看板 chip + flat block 渲染
依赖：T13, T17。
deliverable：
- WS：`/ws/workflows` / per-task 加 3 event `clarify-to-agent.created` / `.answered` / `.escalated`（broadcaster + registry RFC-152）。
- 前端：to-agent 节点状态色 + awaiting_human chip + 看板（TaskQuestionList）to-agent 项 chip + flat block 渲染 A 回答（reuse Prose）。
- `useTaskSync` WS 失效规则加 to-agent。
测试：
- `tests/frontend/to-agent-ws.test.tsx`：3 event 失效 + chip 渲染（≥ 3 case）。

### T19 门禁收尾 + RFC 索引 Done + STATE.md
依赖：T17, T18。
deliverable：
- `bun run typecheck && bun run test && bun run format:check` 全绿。
- binary smoke + CI 全绿。
- `design/plan.md` RFC 索引表 RFC-W004 状态 Draft -> Done。
- `STATE.md` 已完成 issue 表加一行 + 撤顶部"进行中 RFC"。
测试：门禁。

---

## 验收清单（对照 proposal §4）

| AC | 任务 | 验证 |
| --- | --- | --- |
| A1 S1 happy path e2e | T17 | e2e 全链 task done 无人介入 |
| A2 Clarify Request 注入 | T13 | A prompt 含 `## Clarify Request` + 问题 + 协议指令 |
| A3 回答回流 B | T9, T13 | B flat `## Clarify Q&A` 含 A 回答 peer entry |
| A4 A 升级问人 | T12 | to-agent 保持 awaiting_human + A self-clarity awaiting_human + 人答后 A 答 B |
| A5 互斥 answer+clarify | T10 | fail `clarify-to-agent-answer-and-clarify-both-present` |
| A6 timeout-no-answer | T10 | A 只吐 output -> fail |
| A7 多源汇总 | T9, T11 | 2 to-agent 指向 A，A 一次重跑答两组 |
| A8 wrapper-loop | T9 | session 按 loop_iter 隔离 + max_iter 限 |
| A9 multiplicity | T6 | A.`__clarify_request__` ≥2 to-agent -> fail |
| A10 answerer not ancestor | T6 | warning |
| A11 self agent | T6 | warning `clarify-to-agent-answerer-self` |
| A12 awaiting_human 状态 | T4, T9 | mint/answered/bubble/canceled/failed 转移 |
| A13 invariant | T15 | awaiting_human + answerer 终态 -> abandoned |
| A14 inline | T9 | sessionModeForAnswerer + fallback |
| A15 lifecycle 转移合法 | T4, T6 | s14 守卫放行新转移 |
| A16 WS 同步 | T18 | tab A/B 同步 |
| A17 schema 上提 | T5 | 旧 workflow GET 字段无丢失 |
| B1 门禁 | T19 | typecheck/test/format 全绿 |
| B2 零退化 | T2, T6 | strict diff guard：clarify.ts 既有 export 不变 / crossClarify.ts diff=0 |
| B3 backend ≥+35 | 各 T | 测试清单 design §8.4 |
| B4 frontend ≥+12 | T7, T18 | 节点/inspector/看板/flat block |
| B5 e2e | T17 | clarify-to-agent.spec.ts |
| B6 binary | T19 | 体积/启动不退化 |

## PR 拆分理由（CLAUDE.md「如确实需要拆分，在 plan.md 里说明」）

单 RFC 默认单 PR，但本 RFC 规模大（新 NodeKind + DB + service + scheduler + validator + frontend + e2e），拆 3 PR 降低 review 与回滚粒度：
- **PR-1 编辑面先行**：让用户能画/配/保存 to-agent 节点（stub 守卫防跑），可独立验证编辑体验，不阻塞运行时开发。
- **PR-2 运行时**：核心数据流 B->A->B，依赖 PR-1 的类型/DB/validator，是最大一块。
- **PR-3 e2e + 收尾**：端到端验证 + WS + 看板 + 门禁，依赖 PR-2 跑通。

依赖链：PR-1 -> PR-2 -> PR-3，串行合并回 main。每 PR 自带测试，不全量等 PR-3。
