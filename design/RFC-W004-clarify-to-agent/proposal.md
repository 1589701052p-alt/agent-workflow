# RFC-W004 Proposal - Agent 反问上游 Agent（Clarify-to-Agent）：B 反问 A、A 自主回答、不清楚才升级问人

> 状态：Draft（2026-07-12）
> Owner：-
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-056 clarify-cross-agent](../RFC-056-clarify-cross-agent/proposal.md)、[RFC-026 clarify-inline-session](../RFC-026-clarify-inline-session/proposal.md)、[RFC-039 clarify-ask-bias](../RFC-039-clarify-ask-bias/proposal.md)、[RFC-014 iterate-sibling-regen](../RFC-014-iterate-sibling-regen/proposal.md)、[RFC-053 node-run-lifecycle-hardening](../RFC-053-node-run-lifecycle-hardening/proposal.md)、[RFC-058 clarify-sessions-unification](../RFC-058-clarify-sessions-unification/proposal.md)、[RFC-100 mandatory-clarify](../RFC-100-mandatory-clarify/proposal.md)

## 1. 背景

### 1.1 现有两条反问通道都停在「人」

本仓已落地的反问机制有两条，都把**问题最终抛给人**：

- **RFC-023 self-clarify**（`clarify` 节点）：agent 自己反问**人**，人填表回答，agent 带答案重跑。整条链路只有一个 agent。
- **RFC-056 cross-agent clarify**（`clarify-cross-agent` 节点）：下游 questioner agent 反问**人**，人答后，上游 designer agent 拿人的答案重跑产出。questioner 和 designer 是不同 agent，但**回答者始终是人**--designer 只是答案的"消费者"，从不"回答"questioner 的问题。

调研确认（`packages/backend/src/routes/clarify.ts:186,205` `ensureClarifyMember`）：两条通道的答案提交入口 `POST /api/clarify/:nodeRunId/answers` 都校验提交者是任务成员（人）。`clarify_sessions` / `cross_clarify_sessions` 的 status 枚举都硬绑 `awaiting_human`。**"agent 回答另一个 agent 的反问"在现有机制里覆盖度为零。**

### 1.2 真实需求：层次化反问 B -> A -> 人

实战中存在第三种正交模式--**两个 agent 之间直接互问，答不上来才升级到人**：

工作流形如 `input -> A(agent-single) -> B(agent-single)`，A 的产出喂给 B。

- A 自己挂了一个反问人的组件（RFC-023 self-clarify）：A 不清楚需求时反问人。
- B 也挂了一个**反问 A** 的组件（本 RFC）：B 读完 A 的产出，觉得有需要澄清的点，**直接反问 A**，而不是反问人。

B 反问 A 之后，A 自己判断：

- **A 清楚**（产出没问题，B 误解了 / A 知道答案）-> A **直接回答给 B**，B 拿到回答继续。
- **A 不清楚**（A 自己也没想清楚）-> A **反问人**（走 A 自己的 RFC-023 self-clarify 通道）-> 人答 A -> A 带答案**回答 B**。

直到 A 给出回答，B 才继续。整条链路 `B 反问 A -> A 答 B / A 不清楚 -> 人答 A -> A 答 B` 是层次化的，人只在 A 也答不上来时才介入。

### 1.3 为什么 RFC-056 不算覆盖

把 RFC-056 和本 RFC 放一起对比：

| 维度 | RFC-056 cross-clarify | RFC-W004 clarify-to-agent |
| --- | --- | --- |
| 提问者 | 下游 questioner | 下游 B |
| **回答者** | **人**（task member） | **上游 A 自己**（A 不清楚才升级到人） |
| 回答触发 | 人 POST answers | A 重跑产出 `<workflow-clarify-answer>` |
| 上游 agent 角色 | designer = 答案的消费者（带人答重跑产出） | A = 答案的**生产者**（自主回答 B） |
| 答案流向 | 人 -> designer 产出 | A -> B（人 -> A 仅在 A 不清楚时） |
| 节点 kind | `clarify-cross-agent` | `clarify-to-agent`（本 RFC 新增） |
| session 状态 | `awaiting_human` | `awaiting_answer`（等 A 答，非等人） |

关键差异：RFC-056 里 A 从不"回答"questioner 的问题，A 只是拿人的答案更新产出；本 RFC 里 A 是回答者，问题先问 A，A 答不上来才升级到人。两者拓扑相似但**回答者不同、回答时机不同、session 等待对象不同**，无法通过给 RFC-056 加 mode 开关合并（详见 §5.1）。

### 1.4 为什么要现在做

- RFC-023 / 056 / 058 / 100 / 132 / 148 已经把 envelope 协议 / `<workflow-clarify>` JSON schema / awaiting 状态机 / unified `clarify_rounds` 表 / mandatory gate / flat `## Clarify Q&A` 注入器全部铺好。本 RFC 复用这些原语，新增的是"回答者从人换成 A"这一条无人值守回答通道。
- 真实工作流里"agent 互查"是高频模式：审计 agent 看完设计文档想问设计 agent "这段为什么这么做"，这种问题最适合**让设计 agent 自己答**（它最清楚自己的产出），而不是抛给人（人还得去问设计 agent 或翻代码）。
- 与 RFC-056 正交：RFC-056 解决"产出维度的不确定，该由人定夺"；本 RFC 解决"理解维度的不确定，A 自己能答"。两者可在同一工作流并存（B 既可挂 cross-clarify 问人、也可挂 to-agent 问 A）。
- A 升级问人时**完全复用 RFC-023 self-clarify**，零新增"问人"机制--本 RFC 只新增"A 答 B"这一段。

## 2. 目标

### 2.1 做

1. **新 NodeKind `clarify-to-agent`**：叶子节点，**1 个 input 端口** `questions` + **2 个 output 端口** `to_answerer` / `to_questioner`，画布上不允许用户增减端口。Palette 在已有 "Human" / clarify 分类下与 `clarify` / `clarify-cross-agent` 节点并列。

2. **反向拖动建两条自动边**（沿用 RFC-007 / RFC-023 / RFC-056 机制）：用户从 to-agent 节点 input handle 反向拖到任意 **agent-single** 节点 B（v1 仅 agent-single）-> 框架自动建：
   - `B.__clarify__ -> newNode.questions`（B 提问出口）
   - `newNode.to_questioner -> B.__clarify_response__`（回答回流 B）
   两条边形态、视觉、handle 高亮均与 RFC-023 / RFC-056 反向拖动行为对齐。

3. **手动连第三条边到 A（answerer）**：用户从 to-agent 节点的 `to_answerer` output handle 拖到任意上游 agent-single 节点 A -> 框架在 A 上动态注册**系统级输入端口** `__clarify_request__`（不进入 agent.outputs / 不写 DB / 仅存于 workflow.definition，机制对齐 RFC-056 的 `__external_feedback__`）。该端口仅当被 ≥1 个 to-agent 节点 manual-edge 指向时画布可见。

4. **envelope 协议（reuse RFC-023 提问 + 新增回答 envelope）**：
   - **B 提问**：B 用 `<workflow-clarify>` envelope 出问题，JSON schema 完全沿用 RFC-023（每题 `id / title / kind / recommended / options`，options 2-4，单选/多选/第 5 行 custom 规则相同）。问题数上限沿用 RFC-056 的 1+（无上限）。
   - **A 回答**：新增 envelope `<workflow-clarify-answer>`，body 是 A 对 B 问题的回答（markdown 文本，或结构化 per-question 答案 JSON，见 design.md §3.1）。**这是本 RFC 唯一新增的 envelope tag**。

5. **运行时核心数据流（方式一：A 重跑产回答回流 B）**：
   - B 跑完吐 `<workflow-clarify>` -> scheduler 检测 B.`__clarify__` 指向 to-agent 节点 -> 创建 to-agent session（`clarify_rounds` kind=`'to-agent'`）-> to-agent node_run mint，status=`awaiting_answer`（新状态值，等 A 回答，非等人）-> **触发 A 重跑**（rerun cause `clarify-to-agent-answer`）。
   - A 重跑 prompt 注入 B 的问题（`## Clarify Request` 协议块，见 §2.1.8）+ 强指令"你的回答必须用 `<workflow-clarify-answer>` envelope 输出"。
   - **A 清楚** -> A 吐 `<workflow-clarify-answer>` -> runner 解析 -> to-agent node_run done（status=`answered`）-> 回答回流 B.`__clarify_response__` -> **触发 B 重跑**（rerun cause `clarify-to-agent-questioner-rerun`），B 的 prompt 注入 A 的回答（flat `## Clarify Q&A` block 作为 peer entry，与 RFC-023/056 注入面统一）-> B 带回答继续。
   - **A 不清楚** -> A 吐 `<workflow-clarify>` envelope（A 走自己的 RFC-023 self-clarify 通道反问人）-> A 的 self-clarify park awaiting_human -> 人答 A -> A 带答案重跑 -> A 产 `<workflow-clarify-answer>` -> 回流 B。**这一段完全复用 RFC-023，本 RFC 不新增"问人"代码**。

6. **A 升级问人（自然组合 RFC-023）**：A 同时挂 to-agent（作为 answerer 接 B 的反问）+ self-clarify（作为 asker 反问人）时，两个通道**端口方向不同**（A.`__clarify_request__` 是输入接 to-agent；A.`__clarify__` 是输出发 self-clarify），天然不冲突。A 一次重跑里若同时输出 `<workflow-clarify-answer>`（答 B）+ `<workflow-clarify>`（问人），runner 视为协议合法（答 B 优先回流，问人走 self-clarify park）；若 A 只输出 `<workflow-clarify>`（只问人不答 B），to-agent session 保持 `awaiting_answer`，task park awaiting_human（等 A 拿人答后再答 B）。

7. **`## Clarify Request` 协议块（A 侧注入）**：A 被 to-agent 触发重跑时，prompt 末尾追加 `## Clarify Request` 段，含 B 的问题清单（per-question `id / title / options`）+ 协议指令"请用 `<workflow-clarify-answer>` envelope 回答；若你也不清楚，可用 `<workflow-clarify>` 反问人（走你的 self-clarify 通道）"。未引用 `{{...}}` token 时 auto-append（与 RFC-023 `## Clarify Q&A` auto-append 同套机制）。

8. **builtin token（A 侧，与 RFC-023/056 对称）**：
   - `{{__clarify_request__}}` - 渲染 B 的当轮问题清单 markdown。
   - `{{__clarify_request_iteration__}}` - A 当前被 B 反问的轮次（0 = 首次被反问）。
   - `{{__clarify_request_questioner__}}` - 提问方 B 的 nodeId（便于 A 在模板里引用"你被 B 反问了"）。
   未引用时 auto-append `## Clarify Request` 段。

9. **B 侧回答注入（reuse flat block）**：B 重跑带回答时，A 的回答作为 peer entry 进 flat `## Clarify Q&A` block（RFC-132/148 统一注入器 `buildClarifyQueueContext`）。**不新增 B 侧注入面**，A 的回答与人答的 Q&A 同等渲染（设计意图：B 不该区分"这是人答的还是 A 答的"，都是它的反问得到的答案）。如需区分，`FlatClarifyEntry` 可选加 `answeredBy` 字段（design.md §3.4 权衡，v1 不加）。

10. **wrapper-loop 内语义**：
    - to-agent 节点不在 loop 内 -> warning `clarify-to-agent-no-iteration-cap`（与 RFC-023/056 同款，可能无限 B->A->B 往返）。
    - 在 loop 内：每 iter 的 to-agent session 按 `(loop_iter, to_agent_iteration)` 隔离；B->A->B 往复受 `max_iterations` 自然限制。
    - A 升级问人的 reject / STOP 持久性沿用 RFC-023 cross-iter 语义（A 的 self-clarify 通道行为不变）。

11. **DB schema 变更**：
    - migration：`clarify_rounds` 表 `kind` 枚举加 `'to-agent'`（CHECK 约束同步）；新增列 `answerer_node_id` / `answerer_node_run_id`（A 作为回答者的标识，self/cross 时为 null）。**不新建独立表**（RFC-058 unified 表已是单一事实源，本 RFC 沿用）。
    - legacy `clarify_sessions` / `cross_clarify_sessions` 双写不触及（to-agent 不走 legacy 表，只进 `clarify_rounds`）。
    - `node_runs` 新列 `to_agent_iteration INTEGER NOT NULL DEFAULT 0`（A 被反问轮次，对齐 RFC-056 的 `cross_clarify_iteration`）。
    - workflow `$schema_version` bump（仅追加 to-agent 节点形态，透明上提）。

12. **新 node_run status：`awaiting_answer`**：to-agent node_run mint 时 status=`awaiting_answer`（等 A 回答）。加入 `shared/lifecycle.ts` 转移表：`pending -> awaiting_answer`（mint）、`awaiting_answer -> answered`（A 吐回答）、`awaiting_answer -> awaiting_human`（A 升级问人，task 整体 park）、`awaiting_answer -> canceled/failed`。RFC-053 invariants 加 1 条 to-agent 专用 invariant（awaiting_answer session 的 answerer node_run 必须存在且非终态）。

13. **新 rerun cause**（加入 `clarifyRerunLedger` / `nodeRunMint` 映射）：
    - `clarify-to-agent-answer`（A 重跑回答，`isClarifyRerun`=TRUE，可 inline resume）
    - `clarify-to-agent-questioner-rerun`（B 重跑带回答，`isClarifyRerun`=TRUE）

14. **Workflow validator 校验扩展**（沿用 RFC-023/056 风格）：
    - `clarify-to-agent-input-source-missing` - input 未接 -> **fail**。
    - `clarify-to-agent-target-not-agent-single` - input 端对端不是 agent-single -> **fail**（v1 严格）。
    - `clarify-to-agent-has-downstream` - 有非法 outgoing 边 -> **fail**。
    - `clarify-to-agent-answerer-edge-missing` - `to_answerer` 未连 -> **warning**。
    - `clarify-to-agent-answerer-not-ancestor` - A 不是 B 的拓扑上游祖先 -> **warning**（A 必须在 B 上游，否则 A 看不到 B 上下文）。
    - `clarify-to-agent-answerer-self` - A === B 同 agent 定义 -> **warning** "可考虑改用 RFC-023 self-clarify"。
    - `clarify-to-agent-no-iteration-cap` - 不在 wrapper-loop 内 -> **warning**。
    - `clarify-to-agent-multiple-answerers` - `to_answerer` 连向 ≥2 个 agent -> **fail**。
    - multiplicity 预检扩展（RFC-069）：A 的 `__clarify_request__` 只能接 1 个 to-agent 节点（一个 agent 不能同时被多个 to-agent 反问，避免回答归属歧义）。

15. **WS 事件**：`/ws/workflows` / per-task 加 3 个 event：
    - `clarify-to-agent.created`（B 提问、to-agent 进 awaiting_answer、A 即将重跑）
    - `clarify-to-agent.answered`（A 吐回答、to-agent done、B 即将重跑）
    - `clarify-to-agent.escalated`（A 升级问人、to-agent 保持 awaiting_answer、A 的 self-clarify park）

16. **i18n + 错误码全集**：所有 to-agent UI 文案 zh-CN + en-US；错误码：
    - 拓扑级（新增，见 §2.1.14）
    - 解析级（新增）：`clarify-to-agent-answer-malformed`（A 吐的 `<workflow-clarify-answer>` body 不合法）
    - 运行时（新增）：`clarify-to-agent-answerer-missing-at-runtime`（to_answerer 目标运行时找不到）/ `clarify-to-agent-timeout-no-answer`（A 重跑完既没吐回答也没升级问人 -> fail node_run）
    - 协议级（reuse RFC-023）：`clarify-and-output-both-present`（A 同回复同时含 `<workflow-output>` + `<workflow-clarify-answer>`）

### 2.2 不做

- **不做** agent-multi（fan-out）作为 B 或 A：v1 严格限定 agent-single（与 RFC-056 v1 一致）；agent-multi 涉及 shard 级 session 路由、多 shard 回答 UI 等增量复杂度，留给后续 RFC。validator 给 fail。
- **不做** "B 直接读 A 的新产出"作为回答（方式二）：已在 §5.2 论证方式二在"场景 X（A 觉得产出没问题、B 误解）"失效，本 RFC 选方式一（A 产独立回答回流 B）。
- **不做** 部分提交：to-agent session 的回答是 A 一次性产出（A 重跑一次产一个 `<workflow-clarify-answer>`），不存在"逐题回答"。B 的多题在 A 的一次回答 envelope 里统一作答。
- **不做** 人直接替 A 回答：to-agent session 的回答者是 A（agent），人不能通过 `POST /api/clarify/:nodeRunId/answers` 替 A 回答（该路由只服务 self/cross 的人答路径）。人只能通过 A 的 self-clarify 通道答 A（A 再答 B）。
- **不做** 跨 task 反馈持久化：to-agent session 绑 task，task 删除时级联清。
- **不做** "A 回答撤销"：A 吐回答后 to-agent session 即 `answered`，回答回流 B；改主意需重启 task（与 RFC-056 reject 不可撤销同款）。
- **不做** review 节点路径任何改动：本 RFC 与 review 完全并列。
- **不做** FlatClarifyEntry 加 `answeredBy` 角色字段（v1 不区分人答/A 答，B 侧注入统一）；如未来需要"B 知道这是 A 答的"再开 follow-up。
- **不做** 新建独立 DB 表：沿用 RFC-058 `clarify_rounds` unified 表加 kind=`'to-agent'`。

## 3. 用户故事

**S1（happy path：A 清楚，1 轮）**
工作流：`input(requirement) -> A(agent-single 'designer.md') -> B(agent-single 'auditor.md') -> output`。B 上挂 to-agent 节点（反向拖到 B 建 2 条自动边），to-agent.to_answerer 手动拖到 A（动态注册 A.`__clarify_request__`）。A 另挂 RFC-023 self-clarify（A 不清楚时反问人）。

Launch task -> A 跑出 v1 产出 -> B 跑完读 A 产出，吐 `<workflow-clarify>` envelope 2 题（"这里为什么用 Redis？""限流是 P50 还是 P99？"）-> to-agent 节点进 `awaiting_answer` -> 触发 A 重跑（cause=`clarify-to-agent-answer`）-> A prompt 含 `## Clarify Request` 段 + 2 题 + 协议指令 -> A 清楚 -> A 吐 `<workflow-clarify-answer>`（"Redis 因为 X / P99"）-> to-agent node_run done（`answered`）-> 回答回流 B.`__clarify_response__` -> B 重跑（cause=`clarify-to-agent-questioner-rerun`），B prompt 的 `## Clarify Q&A` 含 A 的回答 -> B 带回答产出 output -> task done。**全程无人介入。**

**S2（A 不清楚 -> 升级问人 -> A 答后答 B）**
同 S1 拓扑。B 反问 A 2 题 -> to-agent `awaiting_answer` -> A 重跑看题 -> A 觉得其中 1 题自己也不清楚（"限流 P50 还是 P99 需求没写"）-> A 吐 `<workflow-clarify>` envelope（走 A 的 self-clarify 通道反问人）-> to-agent 保持 `awaiting_answer`，A 的 self-clarify 节点 park awaiting_human -> task 顶层 awaiting_human。

人进 `/clarify/{A的self-clarify nodeRunId}` 答题（chip "self"，与 RFC-023 同形）-> A 带 self-clarify 答案重跑 -> A 这次清楚 -> A 吐 `<workflow-clarify-answer>`（含 self-clarify 得到的 P99 答案）-> to-agent `answered` -> 回流 B -> B 重跑带回答 -> task done。

**S3（wrapper-loop 内 B->A->B 往返）**
工作流：`input -> wrapper-loop[ A -> B -> to-agent ](max_iterations=3)`。loop iter 1：A 跑 -> B 反问 A -> A 答 B -> B 带回答重跑 -> B 这次满意产出 output -> loop iter 1 结束（exit_condition port-not-empty on B.output）。若 iter 1 A 答完 B 仍不满意，loop iter 2 重新 A->B->to-agent，session 按 loop_iter 隔离。loop 到顶 exhausted -> failed（与 RFC-016 loop 语义一致）。

**S4（A === B 同 agent -> validator warning）**
用户错拼：A 和 B 是同一 agent 定义 -> validator warning `clarify-to-agent-answerer-self` "可考虑改用 RFC-023 self-clarify"。task 仍可启动。

**S5（A 同时被 to-agent 反问 + 自己 self-clarify 问人，一次重跑两件事都做）**
S2 的细化：A 一次重跑里**同时**输出 `<workflow-clarify-answer>`（答 B 能答的部分）+ `<workflow-clarify>`（问人不能答的部分）。runner 视为合法：答 B 的部分回流 B（to-agent `answered`），问人的部分走 self-clarify park。**但 v1 简化：A 一次重跑只允许一种 envelope**（见 §5.4 技术选型）--若 A 同回复同时输出 answer + clarify，fail node_run `clarify-to-agent-answer-and-clarify-both-present`（reuse RFC-023 互斥逻辑），retries 兜底；A 必须"先答 B 能答的、再问人不能答的"分两次重跑。S5 描述的"一次两件事"留作后续延展。

**S6（A 重跑完既没答 B 也没问人 -> fail）**
to-agent `awaiting_answer` -> A 重跑完只吐 `<workflow-output>`（A 忽略了 Clarify Request，直接产出）-> runner 检测 to-agent session 仍 `awaiting_answer` 且 A 本次没吐 answer/clarify -> fail node_run `clarify-to-agent-timeout-no-answer`，retries 兜底。A 必须明确"答 B"或"问人"二选一。

**S7（多源：多个 B 反问同一个 A）**
工作流：`A -> B1 -> to-agent1(->A)` 和 `A -> B2 -> to-agent2(->A)`，两个 to-agent 都指向 A。B1、B2 各自反问 A -> 两个 to-agent session 都 `awaiting_answer` -> A 被触发重跑（一次重跑 prompt 含两个 to-agent 的问题，按 nodeId 字典序拼 `## Clarify Request` 子段）-> A 一次回答 envelope 里作答两组问题 -> 两组回答回流各自的 B1/B2。**v1：A 一次重跑答所有指向它的 to-agent 问题**（多源汇总到一次 A 重跑，避免 A 被连续触发多次，对齐 RFC-056 多源汇总屏障设计）。

**S8（inline session 续接）**
to-agent 节点配 `sessionModeForAnswerer='inline'`（默认 isolated）。A 第一轮跑出 sessionId=`opc_a1`。B 反问 A -> A 重跑带 `--session opc_a1`（inline）-> A 续接自己之前看 B 产出的 thinking 历史 -> token 高效。sessionId 缺失/session-not-found -> 透明退 isolated + warning `inline-clarify-to-agent-fallback-to-isolated`（reuse RFC-026 fallback 机制）。

## 4. 验收标准

### 功能

- **A1（S1 happy path e2e）**：3 节点工作流 A->B + to-agent，A 清楚直接答 B，B 带回答产出 -> task done，全程无人介入，e2e 通过。
- **A2（Clarify Request 注入）**：A 重跑 prompt 含完整 `## Clarify Request` 段 + B 的问题清单 + `<workflow-clarify-answer>` 协议指令；断言覆盖单选/多选/custom 三种 question kind。
- **A3（回答回流 B）**：A 吐 `<workflow-clarify-answer>` -> B 重跑 prompt 的 flat `## Clarify Q&A` block 含 A 的回答作为 peer entry；B 拿到回答继续。
- **A4（A 升级问人）**：A 吐 `<workflow-clarify>` 走 self-clarify -> task awaiting_human -> 人答 A -> A 带答案重跑吐 answer -> 回流 B；**to-agent session 在 A 升级期间保持 `awaiting_answer`**，A 的 self-clarify session 独立 `awaiting_human`。
- **A5（A 一次重跑只一种 envelope）**：A 同回复同时含 `<workflow-clarify-answer>` + `<workflow-clarify>` -> fail `clarify-to-agent-answer-and-clarify-both-present`；retries > 0 -> 新 retry。
- **A6（A 不答不问 -> fail）**：A 重跑只吐 `<workflow-output>` -> fail `clarify-to-agent-timeout-no-answer`。
- **A7（多源汇总）**：2 个 to-agent 指向同一 A，A 一次重跑 prompt 含两组问题 -> 一次回答 envelope 作答两组 -> 分别回流 B1/B2。
- **A8（wrapper-loop）**：loop 内 to-agent session 按 loop_iter 隔离；B->A->B 往返受 max_iterations 限制。
- **A9（multiplicity：A 只接一个 to-agent）**：A.`__clarify_request__` 被 ≥2 个 to-agent 指向 -> validator fail `clarify-to-agent-multiple-on-answerer`。
- **A10（answerer not ancestor）**：to_answerer 目标 A 不是 B 的拓扑上游 -> validator warning，task 可启动。
- **A11（self agent warning）**：A === B 同 agent 定义 -> validator warning `clarify-to-agent-answerer-self`。
- **A12（awaiting_answer 状态）**：to-agent node_run mint 后 status=`awaiting_answer`；A 吐 answer -> `answered`；A 升级问人 -> 保持 `awaiting_answer` + task awaiting_human；A fail -> `failed`。
- **A13（lifecycle invariant）**：RFC-053 invariant 扫描发现 `awaiting_answer` session 的 answerer node_run 不存在或已终态 -> 升级 session `abandoned` + warning。
- **A14（inline 模式）**：`sessionModeForAnswerer='inline'` + A.opencode_session_id 非空 -> spawn 含 `--session <id>`；缺/session-not-found -> 退 isolated + warning。
- **A15（新状态转移合法）**：`pending -> awaiting_answer`、`awaiting_answer -> answered`、`awaiting_answer -> awaiting_human`(bubble)、`awaiting_answer -> canceled/failed` 全部走 `shared/lifecycle.ts` 转移表，违反转移被 s14 守卫拒。
- **A16（WS 同步）**：tab A 看到 A 吐回答 -> tab B 收到 `clarify-to-agent.answered` + to-agent 节点状态更新。
- **A17（schema 上提）**：DB 里有旧 schema workflow -> daemon 启动 GET 返新 `$schema_version` + 字段无丢失。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-023 / 056 / 058 / 100 / 132 / 148 既有测试零退化--本 RFC 仅新增 NodeKind / 字段 / 文件 / 分支，不改既有 self-clarify / cross-clarify 现有路径。strict diff guard：`packages/shared/src/clarify.ts` 原 export 字节级不变（新增 export 不算违反）、`packages/backend/src/services/crossClarify.ts` diff = 0。
- **B3** backend tests ≥ +35（shared schemas / envelope 解析 / to-agent service / scheduler / lifecycle / REST+WS / inline，详见 design.md §6）。
- **B4** frontend tests ≥ +12（canvas drag / Inspector / 节点渲染 / 看板 chip）。
- **B5** Playwright e2e 增 1 文件 `e2e/clarify-to-agent.spec.ts` 覆盖 A1（stub-opencode：A 产 answer / B 带 answer 继续）。
- **B6** 单二进制构建包体积 / 启动时间不退化（估算 < 40KB 体积增量、+1 migration 启动时 < 30ms）。

### 回归防护

- **C1** `tests/clarify-to-agent-envelope.test.ts` 顶部注释：锁 `<workflow-clarify-answer>` envelope 解析 + reuse RFC-023 提问 schema。
- **C2** `tests/clarify-to-agent-prompt-injection.test.ts`：源代码层 grep `{{__clarify_request__}}` / `{{__clarify_request_iteration__}}` / `{{__clarify_request_questioner__}}` 三 token + `## Clarify Request` auto-append 文案。
- **C3** `tests/clarify-to-agent-escalation.test.ts`：A 升级问人时 to-agent session 保持 `awaiting_answer` + A 的 self-clarify 独立 `awaiting_human` + 人答后 A 答 B 全链。
- **C4** `tests/clarify-to-agent-multi-source.test.ts`：多 to-agent 指向同一 A，一次重跑答多组，分别回流。
- **C5** `tests/clarify-to-agent-lifecycle.test.ts`：`awaiting_answer` 新状态转移矩阵全笛卡尔积 + s14 守卫 + RFC-053 invariant。
- **C6** `tests/clarify-to-agent-validator-rules.test.ts`：枚举 9 validator 规则覆盖 happy + 各 fail/warning。
- **C7** `tests/clarify-to-agent-answerer-missing.test.ts`：运行时 to_answerer 目标找不到 -> `clarify-to-agent-answerer-missing-at-runtime` fail。

## 5. 关键技术选型理由

1. **新 NodeKind vs 扩展 RFC-056 clarify-cross-agent**：选**新 NodeKind**。回答者不同（A vs 人）、回答时机不同（A 重跑即答 vs 人 POST 后 designer 重跑）、session 等待对象不同（`awaiting_answer` vs `awaiting_human`）、A 的角色不同（回答生产者 vs 答案消费者）。强行给 cross-clarify 加 `answer-mode` 字段会把"人答路径"和"A 答路径"塞进同一节点，reject/多源汇总/abandoned 等 cross-clarify 语义对 A 答场景未必适用，单节点堆 mode 分支变胖。新 NodeKind 端口/校验/运行时路径独立，与 RFC-056 当年选新 NodeKind 的理由（proposal §5.1）同构。

2. **方式一（A 产回答回流 B）vs 方式二（A 改产出 B 重读）**：选**方式一**。方式二在"场景 X（A 觉得产出没问题、B 误解）"失效--A 不改产出则 B 重读无变化、B 无法解惑，或逼 A 改不该改的产出。方式一用独立"回答"通道，A 可只解释不改产出，且与 RFC-023 对称（`agent->人->agent` 变 `B->A->B`）。代价是要新搭 `__clarify_request__` 端口 + `<workflow-clarify-answer>` envelope + 回流路径，但这是必要投入。详见 §1.3 对比表与对话内分析。

3. **A 回答载体：新 envelope `<workflow-clarify-answer>` vs 复用 `<workflow-output>`**：选**新 envelope**。`<workflow-output>` 是 A 的正常产出（端口数据），语义是"产出物"；A 回答 B 是"对问题的针对性回答"，语义不同，混用会让 A 的产出端口被回答污染、下游节点读到混乱。新 envelope 让 A 一次重跑里"产出"和"回答"分离（A 可同时产 output port + answer envelope，answer 走 to-agent 通道回流 B，output 走正常边喂下游）。这与 RFC-023 的 `<workflow-clarify>` 提问 envelope 对称。

4. **A 一次重跑只允许一种 envelope（answer XOR clarify）**：选**互斥**。若 A 同回复同时输出 answer（答 B）+ clarify（问人），回流/park 路径会分裂（answer 要回流 B、clarify 要 park A self-clarify），时序复杂且语义混乱。v1 强制 A "先答能答的、再问不能答的"分两次重跑（A 第一次吐 answer 答能答的 + clarify 问不能答的 -> fail 互斥 -> A retry 改为只 clarify 问人 -> 人答 -> A 带 answer 答 B）。简单清晰。S5 的"一次两件事"留后续延展。

5. **新状态 `awaiting_answer` vs 复用 `awaiting_human`/`running`**：选**新状态**。to-agent 等 A 回答不是等人（A 自动答），用 `awaiting_human` 语义错（task 不该显示"等人"）。用 `running` 则掩盖"to-agent 在等 A 回答"的语义、scheduler frontier 判定会误判 to-agent 完成。`awaiting_answer` 语义清晰、scheduler 可据此正确 park frontier（awaiting_answer 的 to-agent 不算完成、不推进下游）、lifecycle 转移表显式声明合法转移。代价是加 1 个状态值 + 转移规则 + invariant，但 RFC-053 已规范化这套机制，自然落档。

6. **沿用 `clarify_rounds` unified 表加 kind=`'to-agent'` vs 新建独立表**：选**沿用**。RFC-058 unified 表已是单一事实源，self/cross 已用 kind 区分；to-agent 是第三种 clarify round，同表加 kind 最一致。新增 `answerer_node_id` / `answerer_node_run_id` 列（self/cross 时 null）。不新建表避免三表分叉。

7. **B 侧回答注入复用 flat `## Clarify Q&A` block vs 新增 `## Answer` block**：选**复用 flat block**。RFC-132/148 已把所有 clarify Q&A 统一成无角色 flat block，A 的回答作为 peer entry 进同一 block。设计意图：B 不该区分"人答的 vs A 答的"（都是 B 反问得到的答案）。若未来需要区分，再加 `answeredBy` 字段（v1 不加，避免注入面分叉）。

8. **A 升级问人复用 RFC-023 self-clarify vs 新组件内置 escalate**：选**复用 self-clarify**。A 挂 RFC-023 self-clarify 节点反问人是现成机制，零新增"问人"代码。A 的 `__clarify_request__`（输入，接 to-agent）与 `__clarify__`（输出，发 self-clarify）端口方向不同，天然不冲突。新组件内置 escalate 会重复造 RFC-023 已有的问人 UI / awaiting_human / 答案注入。

## 6. 与其它 in-flight / 已落地 RFC 的关系

- **RFC-023 self-clarify**：本 RFC 的 A 升级问人路径**完全复用**（A 挂 self-clarify 节点）。A 的 self-clarify 通道行为零差异。
- **RFC-056 cross-clarify**：拓扑相似但回答者不同（人 vs A），正交并存。同一 B 可同时挂 cross-clarify（问人）+ to-agent（问 A），两个 session 独立。multiplicity 校验：B 的 `__clarify__` 出边只能指向一个 clarify 类节点（RFC-069 既有规则），B 想既问人又问 A 需用两个 agent 节点或 RFC-056 多源设计。
- **RFC-058 unified clarify_rounds**：本 RFC 加 kind=`'to-agent'`，沿 unified 表。
- **RFC-026 inline session**：本 RFC 引入 `sessionModeForAnswerer` 字段，继承 RFC-026 fallback 机制。
- **RFC-039 ask-bias preamble**：A 作为 answerer 重跑时**不**走 ask-bias preamble（A 不是反问者，是回答者）；B 作为 questioner 若同时挂 self/cross 通道则照常走 ask-bias。
- **RFC-014 sibling cascade**：A 重跑回答后，B 由 to-agent 触发重跑（非 cascade），但 A 改产出时下游级联仍走 RFC-014。
- **RFC-053 lifecycle hardening**：`awaiting_answer` 新状态 + `to_agent_iteration` 列 + answerer node_run invariant 走 RFC-053 转移函数 + invariant 扫描。
- **RFC-100 mandatory clarify**：to-agent 通道的 B 侧 mandatory 语义（B 是否强制反问）沿用 RFC-100 gate；A 侧 answerer 不受 mandatory gate（A 必须回答或升级，无"不反问"选项）。
- **RFC-132/148 flat block 注入**：A 的回答进 B 的 flat `## Clarify Q&A` block 作 peer entry。
- **RFC-035 ux-consistency**：新按钮 / Inspector segmented / 节点渲染全走公共组件。

## 7. 风险

| 风险 | 评估 | 缓解 |
| --- | --- | --- |
| A 既不答 B 也不问人（直接产 output）导致 to-agent 永久 awaiting_answer | 中：A 忽略 Clarify Request | A6 fail `clarify-to-agent-timeout-no-answer` + retries 兜底 |
| A 一次重跑同时吐 answer + clarify 路径分裂 | 中：时序复杂 | A5 v1 互斥 fail，强制分两次重跑 |
| A 升级问人期间 to-agent 误判完成 | 中：scheduler frontier 误推 | `awaiting_answer` 显式不入 completed 集合（loadOpenClarify 扩展收集 to-agent session） |
| 多源多 to-agent 指向 A 的并发触发 race | 低：DB 单写者 + 多源汇总屏障 | 对齐 RFC-056 多源汇总 atomic 检查 |
| `awaiting_answer` 新状态与现有 lifecycle invariants 冲突 | 中：s14 守卫可能拒新转移 | A15 显式加合法转移 + invariant；C5 测试矩阵 |
| A 的 `__clarify_request__` 与 self-clarify 的 `__clarify__` 端口共存 multiplicity 误报 | 低：方向不同 | validator 明确两端口正交，不触发 `clarify-multiple-clarify-on-same-agent` |
| `<workflow-clarify-answer>` envelope 被 agent 误用（A 把产出塞进 answer） | 低：protocol block 指令约束 | 解析器校验 answer body 合法性 + 协议指令 |
| inline session 在 to-agent 路径与 self/cross 行为不一致 | 极低：独立字段封装 fallback | C7 测试守护 |

## 8. 后续可能的延展（v1 不做）

- agent-multi 作为 B 或 A（shard 级回答路由）。
- A 一次重跑同时 answer + clarify（S5，需回流/park 时序设计）。
- FlatClarifyEntry 加 `answeredBy` 字段让 B 区分人答/A 答。
- A 回答的历史 diff 视图（多轮 B->A 往返轨迹）。
- 跨 to-agent 节点的"批量回答"（多个 B 问同一 A 的问题去重）。
- A 回答的 LLM 评估（回答质量自动 gate）。
- reject 撤销 / 管理员 escape hatch。
