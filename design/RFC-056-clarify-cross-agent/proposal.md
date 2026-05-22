# RFC-056 Proposal — 跨 agent 反问（Cross-Agent Clarify）：反问 agent 反向反馈给设计 agent

> 状态：Draft（2026-05-22）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-023 agent-clarify](../RFC-023-agent-clarify/proposal.md)、[RFC-026 clarify-inline-session](../RFC-026-clarify-inline-session/proposal.md)、[RFC-039 clarify-ask-bias](../RFC-039-clarify-ask-bias/proposal.md)、[RFC-014 sibling cascade](../RFC-014-iterate-sibling-regen/proposal.md)、[RFC-053 lifecycle hardening](../RFC-053-node-run-lifecycle-hardening/proposal.md)

## 1. 背景

RFC-023 落地的反问澄清节点（clarify）解决的是 **agent 自己反问自己**：单个 agent 在产出前发现缺关键信息 → 吐 `<workflow-clarify>` envelope → 人答 → 同一个 agent 重跑。整条链路只有一个 agent。

实战中真实场景比这复杂一层：

- 用户工作流形如 `input → designer → reviewerOrChecker`。designer 已经吐出一版设计文档，**下游有另一个 agent**（典型是审计 / 评审 / 批判性 agent，下文统称 questioner / 反问 agent）来读这份设计文档。
- 这个下游 agent 看完文档，**不是直接出 verdict / 直接修正，而是想"对设计文档提一组结构化问题"**——典型问题："这段缓存策略你为什么选 Redis 而不是 Memcached？""你提到的限流 100 QPS 是按 P50 还是 P99？"
- 这些问题最好由**用户来回答**，并且回答完之后**让 designer 自己去把答案织进文档**——而不是让 questioner 越俎代庖去改 designer 的产出。

这就是本 RFC 要落的 **跨 agent 反问环**：questioner agent 产出 `<workflow-clarify>` envelope → 人选答 → 答案**反馈给上游的 designer agent** 让它带着 Q&A 重跑去更新文档；如果人觉得 questioner 问得不对，可以直接拒绝（reject），让 questioner 闭嘴、走到下游正常 output。

把 RFC-023 和本 RFC 放一起类比：

| 维度       | RFC-023 self-clarify                                                       | RFC-056 cross-agent clarify                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提问者     | designer 本身                                                              | 下游 questioner（独立 agent）                                                                                                                                        |
| 重跑对象   | designer 本身                                                              | 上游 designer（不是 questioner 自己）                                                                                                                                |
| 反馈通道   | designer.\_\_clarify\_\_ ↔ clarify.questions / clarify.answers             | questioner.\_\_clarify\_\_ → newNode.questions ／ newNode.to_designer → designer.\_\_external_feedback\_\_（manual） ／ newNode.to_questioner → questioner.\_\_clarify_response\_\_（auto） |
| 端口数     | 1 input + 1 output                                                         | 1 input + 2 outputs                                                                                                                                                  |
| 问题数上限 | 1-5                                                                        | 1+（无上限）                                                                                                                                                         |
| 人决策选项 | submit answers（无 reject）                                                | submit answers ／ reject（"让 questioner 别再问"）                                                                                                                   |

## 1.1 为什么要现在做

- RFC-023 / 026 / 039 已经把 envelope 协议 / `<workflow-clarify>` JSON schema / awaiting_human 状态机 / Form UI / inline sessionMode / STOP CLARIFYING anchor 全部铺好；本 RFC 90% 的代码量是在既有原语上加一层"换个目标 agent 重跑"的胶水。
- 真实工作流编排里"自反问"和"互查反问"是两种正交模式：自反问的强项是 designer 在拿到模糊需求时主动收敛；互查反问的强项是审计性 agent 把"我看不懂 / 觉得有问题的点"摆给人。两者并存能让一条工作流同时处理"input 维度的不确定"与"产出维度的不确定"。
- RFC-014 sibling cascade 已经把"上游 doc 重跑 → 下游级联重置 pending"的状态机跑通，本 RFC 直接复用。
- RFC-053 node-run lifecycle hardening 已经把 `nodeRuns.status` 状态机化 + invariant 扫描搭好，本 RFC 新增的 awaiting_human / answered / abandoned 状态走同套 helper 自然落档。

## 1.2 本 RFC 不动哪些地方

- **不动** RFC-023 clarify 节点的运行时（envelope 解析 / clarify_sessions 表 / ClarifyForm 组件 / awaiting_human 状态 / clarify_iteration 计数）；本 RFC 是 8 大 NodeKind 之外**新增的第 9 类节点**。
- **不动** RFC-026 sessionMode 在 RFC-023 self-clarify 节点上的语义；本 RFC 引入的是 cross-clarify 节点专属的 `sessionModeForDesigner` / `sessionModeForQuestioner` 两个独立字段。
- **不动** RFC-039 STOP CLARIFYING / KEEP CLARIFYING anchor 文案与 envelope 协议块；本 RFC reject 路径 reuse 同一 anchor 文案。
- **不动** RFC-014 sibling cascade 触发机制；designer 被外部反馈重跑后下游级联走同一套 `rollbackBeforeRetry` helper。
- **不动** 现有 8 类节点（agent-single / agent-multi / input / output / wrapper-git / wrapper-loop / review / clarify）的拓扑语义；本 RFC 新增第 9 类叶子节点 `clarify-cross-agent`。
- **不动** workflow $schema_version v3 的 clarify 节点定义；本 RFC bump v4 仅追加 cross-clarify 节点形态，v3 → v4 透明上提（v3 工作流不带本 RFC 节点，零迁移风险）。
- **不动** RFC-053 lifecycle 转移函数；本 RFC 仅追加新合法转移（pending → awaiting_human、awaiting_human → answered / abandoned）到 `shared/lifecycle.ts` 已有矩阵。

## 2. 目标

### 2.1 做

1. **新 NodeKind `clarify-cross-agent`**：叶子节点，**1 个 input 端口** `questions` + **2 个 output 端口** `to_designer` / `to_questioner`，画布上不允许用户增减端口。Palette 在已有 "Human" 分类下与 RFC-023 `clarify` 节点并列。

2. **反向拖动两条边**（沿用 RFC-007 / RFC-023 机制）：用户从 cross-clarify 节点 input handle 反向拖到任意 **agent-single** 节点（v1 仅 agent-single） → 框架自动建：
   - `questioner.__clarify__ → newNode.questions`
   - `newNode.to_questioner → questioner.__clarify_response__`
     两条边形态、视觉、handle 高亮均与 RFC-023 反向拖动行为对齐。

3. **手动连第三条边到 designer**：用户从 cross-clarify 节点的 `to_designer` output handle 拖到任意上游 agent-single 节点 → 框架在该 agent 上动态注册**系统级 target 端口** `__external_feedback__`（不进入 agent.outputs / 不写 DB / 仅存于 workflow.definition）。该端口仅当被 ≥1 个 cross-clarify 节点 manual-edge 指向时画布可见。

4. **envelope 协议（reuse RFC-023）**：questioner agent 用 `<workflow-clarify>` envelope 出问题，**JSON schema 完全沿用 RFC-023**——每题 `id / title / kind / recommended / options`，`options` 至少 2 至多 4，单选 / 多选规则相同，第 5 行人工自定义输入框规则相同（单选互斥 / 多选并存）。**唯一差异：问题数上限从 5 放开到 1+（无上限）**。runner 的 envelope 解析器对 cross-clarify 节点关联的 agent 应用宽松的问题数上限（cross-clarify 模式下不截断、仅 self-clarify 模式仍 ≤ 5 截断）。

5. **人工反馈 UI（复用 /clarify 路由）**：
   - 路由 `/clarify/:nodeRunId`、侧栏 Clarify tab、列表项均**复用 RFC-023**。
   - 列表项加 chip 区分 `self` / `cross`（CSS class + i18n 标签）。
   - 详情页内部按 NodeKind 分支：cross-clarify 节点底部加 **Reject 按钮**（与 Submit 并列、不同色）。
   - **Reject 二次确认 modal**：标题 "确认拒绝反问？"，正文 "反问 agent 将不再在本 task 产生问题，不可撤销，确定继续？"，按钮 "取消" / "确认拒绝"。
   - Submit / Reject **都要求先填完推荐题**（与 RFC-023 submit 同约束；reject 不是"逃避答题"按钮）。
   - **多源等待 banner**：若 task 中其他 cross-clarify 节点 awaiting_human 且都指向同一个 designer，则 submit 后顶部显示黄色 banner "已提交。等待另 N 个新节点处理完 designer 才会重跑"，附跳转链接。

6. **submit 时序（多源汇总）**：
   - 单次 submit **不立刻**触发 designer 重跑。runtime 检查"所有指向该 designer 且 directive='continue' / 处于 awaiting_human 的 cross-clarify 节点是否都已 submit 或 reject"。
   - 全部解决后，触发**一次** designer 重跑：External Feedback 段把所有 directive='continue'（即 submit）来源的 Q&A 按 `source.nodeId` 字典序拼接为子段。directive='stop'（reject）的来源**不**进入 designer 的 External Feedback。
   - questioner agent 不在 submit 路径主动重跑——designer 重跑结束、RFC-014 sibling cascade 把 questioner 级联到 pending、questioner 自然按原 input 边重读 designer 新 doc 推进。

7. **reject 时序与持久性**：
   - 单次 reject 立刻触发**对应 questioner agent** 重跑一次（不等其他 cross-clarify 节点）。
   - questioner prompt = 全量历史 Q&A（含本次 reject 时人填的 answers）+ STOP CLARIFYING 强指令（reuse RFC-039 anchor "## User directive: STOP CLARIFYING" + "your output must be `<workflow-output>`"）。
   - **reject 持久性**：cross_clarify_sessions 表记 `directive='stop'`；该 cross-clarify 节点后续任何 cascade rerun（包括其他 cross-clarify 触发的 designer 重跑级联）发生时，questioner prompt 永远带 STOP CLARIFYING + 全量历史 Q&A，且该 cross-clarify 节点**不重新进 awaiting_human**——即便 questioner 仍输出 `<workflow-clarify>` envelope，runtime 视为协议违反（fail node_run + warning），不创建新 session。
   - reject 路径**不**触发 designer 重跑（即使该 cross-clarify 是指向 designer 的最后一个 awaiting 节点，只要本节点是 reject 而非 submit，designer 不收 Q&A）。

8. **designer 重跑后下游级联（RFC-014）**：designer 被外部反馈重跑后，downstream 全部节点（含 questioner、sibling reviews / outputs / 其它节点）一并 reset 为 pending 并重新调度。复用 `rollbackBeforeRetry` helper 与 sibling cascade 已有路径。被 reject 持久化的 cross-clarify 节点**不**重新进 awaiting_human（持久 stop 优先于 cascade reset）。

9. **wrapper-loop 内的部分持久语义**：
   - reject 跨 iter 永久（被拒过的 questioner 整个 loop 不再问、prompt 跨 iter 都带 STOP CLARIFYING + 该 cross-clarify 的全史）。
   - Q&A 历史每 iter 起始复位（cross_clarify_sessions 按 (loop_iter, cross_clarify_iteration) 维度隔离；下一 iter 的 designer 重跑 External Feedback 仅含该 iter 内 directive='continue' 的 Q&A 子段）。
   - cross_clarify_iteration 每 iter 从 0 重新计。

10. **inline session（RFC-026 扩展）**：cross-clarify 节点新增 2 字段：
    - `sessionModeForDesigner: 'isolated' | 'inline'`（默认 isolated）：designer 被外部反馈重跑时的 opencode session 处理策略。
    - `sessionModeForQuestioner: 'isolated' | 'inline'`（默认 isolated）：questioner 被 reject + sibling cascade 重跑时的 opencode session 处理策略。
    - 两个字段都继承 RFC-026 inline 失败回退机制：sessionId 缺失 / opencode 报 session-not-found → 本轮透明退为 isolated + node_run_events warning `inline-cross-clarify-fallback-to-isolated`（带 subreason）。

11. **designer prompt 注入（新增 builtin token + auto-append）**：
    - 新增对称 builtin token（与 RFC-023 4 token 同地位）：
      - `{{__external_feedback__}}` — 渲染所有 source 来源的当轮 Q&A markdown 块（按 source.nodeId 字典序，每段冠以 `### From '{questionerNodeId}' (round {cross_clarify_iteration})`）。
      - `{{__external_feedback_iteration__}}` — designer 当前 cross_clarify_iteration（0 = 首次跑还没被外部反馈过 / 1 = 被反馈 1 次此轮是答完后第一次重跑 / ...）。
      - `{{__external_feedback_sources__}}` — 当前批次的 source nodeId 列表（逗号分隔，便于 designer 在 prompt 模板里引用 "你被 N 个反问者反馈了"）。
    - 未引用时框架自动 auto-append `## External Feedback` 段（与 RFC-023 `## Clarify Q&A` auto-append 同套机制）。
    - **designer 同时挂 RFC-023 self-clarify 通道**时：prompt 两段分开——`## Self Clarify Q&A`（RFC-023 path，含历史 self-clarify Q&A）+ `## External Feedback`（本 RFC path，仅本轮汇总）。两段独立递增各自的 iteration 计数（`clarify_iteration` vs `cross_clarify_iteration`）。

12. **questioner prompt 注入（reuse RFC-023 + reject 扩展）**：
    - questioner 是反问 agent，envelope 与 RFC-023 self-clarify 同；其 prompt 模板用 `{{__clarify_questions__}}` / `{{__clarify_answers__}}` / `{{__clarify_iteration__}}` 等 RFC-023 token，**作用于本 cross-clarify 节点的 Q&A 历史**（全量历史 Q&A，含已 reject 那轮人填的 answers）。
    - reject 路径在 prompt 末尾追加 `## User directive: STOP CLARIFYING`（reuse RFC-039 anchor 文案 + "your output must be `<workflow-output>`" 强指令）。
    - submit 路径下 questioner cascade rerun 走 RFC-039 引入的 ask-bias preamble（hasClarifyChannel=true → "默认你应当先反问；除非已无歧义"）；reject 路径下完全切到 STOP CLARIFYING 文案，覆盖 ask-bias preamble。

13. **DB schema 变更**：
    - migration **0029**：
      - 新表 `cross_clarify_sessions`（schema 详见 design.md §3.2）：questions JSON / answers JSON / directive enum 'continue'|'stop' / status enum 'awaiting_human'|'answered'|'abandoned' / iteration / 关系列 `cross_clarify_node_run_id` / `source_questioner_node_run_id` / `target_designer_node_run_id` / `task_id` / `loop_iter` / `created_at` / `answered_at`。
      - `node_runs` 表新列 `cross_clarify_iteration INTEGER NOT NULL DEFAULT 0`。
    - workflow `$schema_version` 从 3 升到 4；v3 GET 路径透明上提（v3 工作流不带 cross-clarify 节点，行为零差异）。

14. **abandoned 状态**：当 designer cascade 耗尽 retries / task fail 时，未被消费的 cross_clarify_sessions（status='answered' 且 directive='continue' 且 target_designer_node_run_id 不存在 done node_run）升级为 `abandoned`。UI 详情页 chip "反馈未送达" + i18n 提示 + tooltip 解释原因。RFC-053 lifecycle invariants 加 1 条 cross-clarify 专用 invariant 在 daemon 启动 + 每小时扫一次，自动升级。

15. **Workflow validator 7 项静态校验扩展**（沿用 RFC-023 风格）：
    - `cross-clarify-input-source-missing` — input 未接任何 agent → **fail**（拒启动）。
    - `cross-clarify-target-not-agent-single` — input 端对端不是 agent-single → **fail**（v1 严格限制）。
    - `cross-clarify-has-downstream` — cross-clarify 节点有 outgoing 边（除两个合法 output port）→ **fail**。
    - `cross-clarify-manual-edge-missing` — `to_designer` 未连接 → **warning**。
    - `cross-clarify-target-not-ancestor` — `to_designer` 端对端节点不是 questioner 的上游祖先 → **warning**。
    - `cross-clarify-auto-edge-deleted` — `to_questioner` → questioner.\_\_clarify_response\_\_ 边被手动删 → **warning**。
    - `cross-clarify-self-review-warning` — designer 端 manual-edge target 的 agent 与 questioner 是同一 agent 定义 → **warning** "可考虑改用 RFC-023 self-clarify"。

16. **WS 事件**：`/ws/workflows` 加 4 个 event（与 RFC-023 `clarify.*` 并列）：
    - `cross-clarify.created`（envelope 解析完成、新节点进 awaiting_human）
    - `cross-clarify.answered`（人 submit）
    - `cross-clarify.rejected`（人 reject）
    - `cross-clarify.designer-rerun-batched`（多源等待结束、designer 即将重跑）

17. **i18n + 错误码全集**：所有 cross-clarify UI 文案 zh-CN + en-US；错误码：
    - 协议级（reuse RFC-023）：`clarify-and-output-both-present`
    - 解析级（新增）：`cross-clarify-questions-malformed` / `cross-clarify-options-too-few` / `cross-clarify-options-too-many` (warning)
    - 拓扑级（新增）：`cross-clarify-input-source-missing` (fail) / `cross-clarify-target-not-agent-single` (fail) / `cross-clarify-has-downstream` (fail) / `cross-clarify-manual-edge-missing` (warning) / `cross-clarify-target-not-ancestor` (warning) / `cross-clarify-auto-edge-deleted` (warning) / `cross-clarify-self-review-warning` (warning)
    - 运行时（新增）：`cross-clarify-designer-target-missing-at-runtime` (fail) / `cross-clarify-questioner-emit-after-stop` (warning) / `inline-cross-clarify-fallback-to-isolated` (warning, 含 subreason: missing-session-id / session-not-found / unsupported-opencode-version)

### 2.2 不做

- **不做** 反问轮次 cap（按 Round 1 Q2 决议）：v1 不在节点上设上限，依赖人工 reject 兜底；wrapper-loop 内借 `max_iterations` 自然限制 loop 外周期数，但单 iter 内的反问轮数不限制。
- **不做** agent-multi（fan-out）作为 questioner 或 designer：v1 严格限定 agent-single；agent-multi 涉及 shard 级 session 路由、多 shard 答题 UI、shard 级 cascade 等增量复杂度，**留给后续 RFC**。validator 给 fail（不是 warning）防止用户误用。
- **不做** 部分提交（与 RFC-023 一致）：cross-clarify 节点的题要么一起 submit、要么 reject；不允许逐题 submit。
- **不做** 用户在 UI 上追加自由问题（与 RFC-023 一致）：用户只能回答 questioner agent 提出的问题（含可选 custom_text）。
- **不做** 跨 task 反馈持久化：cross_clarify_sessions 绑 task，task 删除时级联清。
- **不做** YAML 导入路径下的 schema v3 → v4 自动迁移：v3 YAML 含 cross-clarify 节点拒导（v3 本来就没这个节点）。
- **不做** 跨 task 续 opencode session（与 RFC-026 一致）：本 RFC inline 限定为同一 task 同一 node_run 链路。
- **不做** "reject 撤销" 按钮：reject 是终局决策；改主意必须重启 task。
- **不做** 修改 review 节点（RFC-005）路径任何代码；本 RFC 与 review 完全并列。
- **不做** 自动检测 designer 是否真的把 Q&A 写进了 doc——designer 输出质量靠 review 节点把关，不是本 RFC 职责。
- **不做** 单条边视觉特化：cross-clarify 三条边在画布上沿用 RFC-023 反向反馈边的视觉风格（虚线 / 弧线），不引入新视觉语言。

## 3. 用户故事

**S1（happy path：单源 cross-clarify + 1 轮）**
工作流：`input(requirement) → designer(agent-single) → questioner(agent-single, role='auditor') → reviewDesign(review)`。在 questioner 节点上从一个新拖来的 cross-clarify 节点的 input handle 反向拖向 questioner → 框架自动建 2 条边（questioner.\_\_clarify\_\_ → newNode.questions / newNode.to_questioner → questioner.\_\_clarify_response\_\_）。用户再手动拖 newNode.to_designer → designer 节点 → 框架在 designer 上动态注册 `__external_feedback__` 端口。

Launch task → designer 跑出 v1 设计文档 → questioner 跑出 `<workflow-clarify>` envelope 3 题（"为什么选 Redis 不是 Memcached？"等）→ cross-clarify 节点进 awaiting_human → task 顶层 awaiting_human。

用户进 `/clarify/{nodeRunId}` 答题（chip "cross"）→ 点 Submit → 唯一一个指向该 designer 的 cross-clarify 已 submit → 触发 designer 重跑（cross_clarify_iteration=1）→ designer prompt 含 `## External Feedback` 段 + 1 个 source 子段 → designer 跑出 v2 doc（把答案织进缓存策略段）→ RFC-014 sibling cascade 把 questioner reset pending → questioner 第二轮跑出 `<workflow-output>` envelope（认为本轮已足够、不再反问）→ workflow 走到 reviewDesign → 人 approve → task done。

**S2（多源 cross-clarify + 等待汇总）**
工作流：`input → designer → securityQuestioner → securityCross(cross-clarify)` 和 `input → designer → uxQuestioner → uxCross(cross-clarify)`，两个 cross-clarify 节点的 to_designer 都 manual-edge 指向同一个 designer。

第一轮 designer 跑完 → securityQuestioner + uxQuestioner 各自跑出 `<workflow-clarify>` envelope（securityQuestioner 4 题、uxQuestioner 3 题）→ 两个 cross-clarify 节点都进 awaiting_human → task 顶层 awaiting_human、Clarify tab 列两条 awaiting 项。

用户先答 securityCross 点 Submit → 顶部黄 banner "已提交。等待另 1 个新节点（uxCross）处理完 designer 才会重跑" + 跳转链接。用户点 banner 跳到 uxCross 答完 → 此时所有指向同一 designer 的 cross-clarify 都已 submit → 触发 designer 重跑（cross_clarify_iteration=1）→ designer prompt 的 `## External Feedback` 段包含两个 source 子段（按 nodeId 字典序：securityCross 在前、uxCross 在后）→ designer 跑出 v2 doc → cascade reset 两个 questioner + 两个 cross-clarify → 两个 questioner 都跑出 `<workflow-output>` → workflow 继续。

**S3（reject 路径）**
同 S1，但用户进 `/clarify/{nodeRunId}` 后觉得 questioner 提的 3 题没意义（譬如设计上根本没用 Redis）→ 先**填完所有推荐题**（Submit / Reject 都要求）→ 点 "Reject" 按钮 → 二次确认 modal "反问 agent 将不再在本 task 产生问题，不可撤销，确定继续？" → 用户确认。

cross-clarify 节点状态 → answered（directive='stop'），questioner 节点立刻 cascade reset pending 重跑一次（不等其他节点）→ questioner prompt 含全量 Q&A（含 reject 那次的 answers）+ `## User directive: STOP CLARIFYING` 强指令（reuse RFC-039 anchor）→ questioner 第二轮直接跑出 `<workflow-output>` envelope → workflow 走到 reviewDesign。**designer 不被触发重跑**。

后续即便其他 cross-clarify 节点 submit 触发 designer 重跑 + sibling cascade，被 reject 持久化的 cross-clarify 节点和 questioner 仍走 STOP CLARIFYING 路径——不再 awaiting_human。

**S4（wrapper-loop 内部分持久）**
工作流：`input → wrapper-loop[ designer → questioner → cross(cross-clarify) ](max_iterations=5)`。loop iter 1：designer 跑 → questioner 跑出 clarify env → 人 submit → designer 重跑 → cascade reset questioner → questioner 第二轮跑出 output → loop iter 1 结束。

loop iter 2：designer 重跑（fresh node_run, cross_clarify_iteration=0）→ questioner 重跑出 clarify env 2 题 → 人 **reject** → 持久化 directive='stop'。

loop iter 3：questioner 跑（沿用 reject 持久性）prompt 含 STOP CLARIFYING + 全量历史（从 reject 那刻起的累积，本 iter 起始时 Q&A 列表也复位）→ 直接 output → loop iter 3 结束。loop iter 4 / 5 同。loop done。

**S5（designer === questioner 同 agent 定义 → validator warning）**
用户错拼工作流：`input → reviewer(agent-single 'reviewer.md') → reviewer2(agent-single 'reviewer.md') → cross(cross-clarify)`，且 cross.to_designer 指向 reviewer（自己）。validator 给 warning `cross-clarify-self-review-warning`：编辑器 ValidationPanel 显示黄色 "你把同一 agent `reviewer.md` 同时用作 designer / questioner、可考虑是否只需要 RFC-023 self-clarify"。task 仍可启动。

**S6（多源 + 部分 reject）**
S2 的延伸：用户在 securityCross 点 Reject、uxCross 点 Submit。runtime：

- securityCross 立刻触发 securityQuestioner 重跑（STOP CLARIFYING）→ securityQuestioner 跑出 output → workflow 在 securityQuestioner 下游继续；
- uxCross 已 Submit、且本节点已是该 designer 唯一剩余 awaiting 项（securityCross 已 answered=reject 但不计入 designer 重跑触发条件——只有 directive='continue' 的 session 才计入 designer External Feedback）→ 触发 designer 重跑，External Feedback 仅含 uxCross 的 Q&A 子段。
- designer 重跑 done → cascade reset uxQuestioner + uxCross；securityQuestioner 已被 stop 持久化、不重新 awaiting。

**S7（abandoned session）**
S1 happy path 中途出岔：人 submit → designer 重跑 → 跑到中途 retries 用光仍失败 → task=failed。此时 cross_clarify_sessions.status 从 'answered' 升级为 'abandoned'；UI 详情页 chip "反馈未送达 (abandoned)" + tooltip 提示原因。task resume 时不会重发该反馈（已视为 abandoned）。

**S8（inline 模式 + designer / questioner 独立配）**
工作流：cross-clarify 节点配 `sessionModeForDesigner='inline'` + `sessionModeForQuestioner='isolated'`。

- designer 第一轮跑出 sessionId=`opc_d1` 落 node_runs.opencode_session_id。
- questioner 第一轮跑出 sessionId=`opc_q1`。
- 人 submit → designer 重跑带 `--session opc_d1`（inline）→ 利用 opencode session 续接看到自己之前 thinking + 工具调用历史 → token 高效。
- 后续 reject 触发 questioner 重跑 → 走 isolated（不带 `--session`）→ 全量历史 Q&A + STOP 注入 prompt。

**S9（inline 失败回退）**
sessionModeForDesigner='inline' 但 designer 第一轮 opencode 进程异常退出没采到 sessionId → 第二轮重跑时 source.opencode_session_id=NULL → 自动回退 isolated + node_run_events warning `inline-cross-clarify-fallback-to-isolated: missing-session-id`。task 不 fail。

**S10（v3 → v4 transparent upgrade）**
DB 里有 v3 workflow（含 RFC-023 clarify 节点、不含本 RFC 节点）→ daemon 启动 GET workflow 返 `$schema_version: 4` + 节点定义零字段丢失。新写入永远落 v4。导入 v3 YAML 含 cross-clarify 节点（其实不可能，但是防御性）拒导。

**S11（agent-multi 拒绝 v1）**
用户拖 cross-clarify 节点 input 反向连接到 agent-multi 节点 → validator 立刻给 fail `cross-clarify-target-not-agent-single`、ValidationPanel 显示红色 + task 拒启动。

**S12（designer self-clarify + cross-clarify 同时挂）**
designer 既挂了自己的 RFC-023 self-clarify 通道（designer.\_\_clarify\_\_ → selfClarify(clarify) 节点），又被本 RFC cross-clarify 节点 manual-edge 指向。designer 第一轮跑出 `<workflow-clarify>` self envelope → selfClarify 进 awaiting_human → 人答 → designer 重跑（clarify_iteration=1, cross_clarify_iteration=0）→ 跑出 doc → questioner 提 cross-clarify env → 人答 → designer 重跑（clarify_iteration=1, cross_clarify_iteration=1）→ prompt 含 `## Self Clarify Q&A`（1 轮历史）+ `## External Feedback`（本轮 cross） → 跑出 v3 doc → workflow 继续。两个 iteration 字段独立递增、prompt 段独立渲染、互不污染。

## 4. 验收标准

### 功能

- **A1（S1 happy path e2e）**：4 节点工作流单源 cross-clarify happy path → designer 重跑带 External Feedback → questioner 二轮 output → review approve → task done，全程 e2e 通过。
- **A2（External Feedback 注入）**：designer 重跑 prompt 文本含完整 `## External Feedback` 段 + source 子段（按 nodeId 字典序）+ Q&A + framework synthesis；断言级覆盖单选 / 多选 / custom 三种 case。
- **A3（多源等待）**：2 个 cross-clarify 指向同一 designer，submit 第一个后 designer **不**重跑；submit 第二个后 designer 重跑一次、External Feedback 含两个 source 子段。
- **A4（reject 触发 questioner stop）**：reject 后 questioner 立刻重跑、prompt 含 `## User directive: STOP CLARIFYING` + 全量历史 Q&A（含 reject 那次的 answers）；designer **不**重跑。
- **A5（reject 持久性）**：reject 后即便 cascade reset 多次，被 stop 的 cross-clarify 节点不重新 awaiting_human、questioner prompt 永远带 STOP CLARIFYING。
- **A6（wrapper-loop 部分持久）**：loop iter 1 reject → iter 2 起 questioner 跑都带 STOP；iter 2 reset 时 Q&A 历史复位、cross_clarify_iteration 重置为 0；reject directive='stop' 仍跨 iter 持久。
- **A7（互斥 envelope）**：questioner 同回复同时含 `<workflow-output>` + `<workflow-clarify>` → node_run failed + reuse RFC-023 错误码 `clarify-and-output-both-present`；retries 配 > 0 → 新 retry。
- **A8（问题数无上限）**：questioner 给 7 题 / 20 题 → 全量入 cross_clarify_sessions（不再截至 5 题）；UI 列表正常渲染 N 题。
- **A9（选项数仍上限 4）**：questioner 给某题 5 option → 截到 4 option + node_run_events warning `cross-clarify-options-too-many`（reuse RFC-023 截断逻辑）。
- **A10（schema 校验：options < 2）**：questioner 给 options=1 → node_run failed + `cross-clarify-options-too-few`。
- **A11（v3 → v4 上提）**：DB 里有 v3 workflow + daemon 启动后 GET 返 `$schema_version: 4` + 字段无丢失。
- **A12（cross_clarify_iteration 与 clarify_iteration 正交）**：designer 同时挂 self-clarify + 被 cross-clarify 触发重跑时，clarify_iteration / cross_clarify_iteration 各自独立递增；prompt 含 `## Self Clarify Q&A` + `## External Feedback` 两段。
- **A13（agent-multi 拒）**：cross-clarify 节点 input 连接到 agent-multi → validator fail `cross-clarify-target-not-agent-single`，task 拒启动。
- **A14（同 agent 自审 warning）**：designer 与 questioner 是同一 agent 定义 → validator warning `cross-clarify-self-review-warning`，task 可启动。
- **A15（abandoned 状态）**：designer cascade 耗尽 retries / task fail → 未消费的 cross_clarify_sessions 升级为 'abandoned'；UI chip "反馈未送达"。
- **A16（inline 模式 happy）**：sessionModeForDesigner='inline' + source.opencode_session_id 非空 → spawn 命令行含 `--session <id>` + prompt 走精简版（不再注入完整 External Feedback 历史协议块、仅当轮内容 + 协议短指令）。
- **A17（inline 回退）**：sessionId 缺 / opencode session-not-found → 透明退 isolated + warning `inline-cross-clarify-fallback-to-isolated: <subreason>`；task 不 fail。
- **A18（manual edge 缺 warning + 运行时 fail）**：cross-clarify 节点 to_designer 未连 → validator warning `cross-clarify-manual-edge-missing`，task 可启动；运行时 submit 时 designer rerun trigger 找不到 target → node_run_events 加 error `cross-clarify-designer-target-missing-at-runtime`。
- **A19（多 tab WS 同步）**：tab A 答 cross-clarify 第一个题 + 点 submit → tab B 收到 `cross-clarify.answered` event + 切只读 + 顶部 toast。
- **A20（cross 与 self 列表 chip）**：/clarify 列表混排 RFC-023 self-clarify 与本 RFC cross-clarify awaiting 项 → 列表项 chip 正确区分 self / cross + i18n。
- **A21（reject 后 questioner 仍 emit clarify → 协议违反）**：reject 持久化后 cascade rerun 出现 questioner 仍输出 `<workflow-clarify>` envelope → runtime fail node_run + warning `cross-clarify-questioner-emit-after-stop`，retries 兜底；不创建新 awaiting session。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-023 / RFC-026 / RFC-039 / RFC-014 既有测试零退化——本 RFC 仅新增 NodeKind / 字段 / 文件 / 分支，不改既有 self-clarify / review / sibling cascade 现有路径；strict diff guard：`packages/shared/src/clarify.ts` 原 export 字节级不变（新增 export 不算违反）、`packages/backend/src/services/review.ts` diff = 0。
- **B3** backend tests **≥ +40**：
  - shared schemas 6（cross-clarify node + cross_clarify_sessions + workflow $schema v4 migrate + envelope schema reuse 断言 + 问题数 1+ / 选项数 ≤ 4 + answers JSON 同 RFC-023）
  - envelope 解析 4（happy + 问题数无上限 + 选项截断 reuse 警告 + 互斥 envelope 互斥 reuse）
  - cross-clarify service 12（createCrossClarifySession + commitAnswers submit + commitAnswers reject + 多源 await 触发条件 + designer rerun External Feedback 拼接 + reject directive persistence + abandoned 状态升级 + same agent self-review warning + ancestor-not-found warning + loop iter Q&A reset / directive persistence / cross_clarify_iteration reset 三 case + cascade reset 不重置 directive）
  - scheduler 8（awaiting_human dispatch + designer rerun trigger 多源汇总 + reject 触发 questioner 重跑独立 + cross_clarify_iteration 递增 + cascade reset 全下游 + abandoned 升级 + loop max_iterations + 持久 stop 在 cascade 后仍生效）
  - REST + WS 6（GET list + GET detail cross / self 混排 + POST answers submit + POST answers reject + cross-clarify.created broadcast + cross-clarify.designer-rerun-batched broadcast）
  - inline 4（happy spawn args + 缺 sessionId 回退 + session-not-found 回退 + sessionModeForDesigner / ForQuestioner 独立配）
- **B4** frontend tests **≥ +18**：
  - /clarify 列表 / 详情 chip / Reject 按钮 6（chip 渲染 self vs cross + Reject 按钮仅 cross 渲染 + Reject 二次确认 modal + Submit / Reject 都要求填完推荐题 + 多源等待 banner + banner 跳转链接）
  - canvas drag 5（反向拖动建两条边 cross-clarify ↔ questioner + 手动拖 to_designer 建第三条 + 自动注册 \_\_external_feedback\_\_ 系统端口 + 删 to_questioner 边后注入仍正常的源码层断言 + cross-clarify 输出禁下游）
  - Inspector 字段 4（sessionModeForDesigner segmented + sessionModeForQuestioner segmented + 默认 isolated + workflow PUT 落字段）
  - shared utils 3（buildExternalFeedbackBlock 单源 / 多源拼接 / 空 source 边界）
- **B5** Playwright e2e 增 1 个新文件 `e2e/cross-clarify.spec.ts`（fixture stub-opencode：designer 第一轮 output、questioner 第一轮 cross-clarify env、人 submit、designer 第二轮 output 含 External Feedback 注入断言、questioner 第二轮 output、review approve → task done），覆盖 A1。
- **B6** 单二进制构建包体积 / 启动时间不退化（估算 < 50KB 体积增量、+1 migration 启动时 < 30ms）。

### 回归防护

- **C1** `tests/cross-clarify-envelope-reuse.test.ts` 顶部注释：锁 envelope 解析 reuse RFC-023 schema（问题数上限是 cross-clarify 节点 attach 时关 / 节点未 attach 时仍 ≤ 5）；防 envelope schema 在 cross-clarify 路径上误漂移。
- **C2** `tests/cross-clarify-prompt-injection.test.ts`：源代码层 grep `{{__external_feedback__}}` / `{{__external_feedback_iteration__}}` / `{{__external_feedback_sources__}}` 三 token 在 `packages/shared/src/prompt.ts`、grep `## External Feedback` auto-append 文案在 `packages/shared/src/clarify-cross.ts`，防 token rename 静默破坏。
- **C3** `tests/cross-clarify-multi-source-wait.test.ts`：构造 3 个 cross-clarify 指向同 designer，部分 submit 部分仍 awaiting，断言 designer **不**重跑；全部 resolve 后才重跑一次。
- **C4** `tests/cross-clarify-reject-persistence.test.ts`：reject 后构造多种 cascade reset 场景（其他 cross-clarify submit / designer 自反问 review iterate），断言被 stop 的 cross-clarify 永不 awaiting_human + questioner prompt 始终带 STOP CLARIFYING。
- **C5** `tests/cross-clarify-loop-partial-persistence.test.ts`：wrapper-loop 内 iter 1 reject → iter 2 起 questioner prompt 永带 STOP；iter 2 Q&A 历史 / cross_clarify_iteration 复位但 directive='stop' 跨 iter 持久。
- **C6** `tests/cross-clarify-validator-rules.test.ts`：枚举 7 validator 规则（必阅 3 / warning 4）覆盖 happy + 各 fail / warning case。
- **C7** `tests/cross-clarify-inline-fallback.test.ts`：sessionModeForDesigner='inline' 缺 sessionId / session-not-found 各自回退断言。
- **C8** `tests/cross-clarify-cascade-isolation.test.ts`：同 task 同 designer 同时被 RFC-023 self-clarify + 本 RFC cross-clarify 反馈时两个 iteration 字段独立递增、prompt 两段独立渲染。
- **C9** `tests/cross-clarify-abandoned-invariant.test.ts`：RFC-053 invariant 扫描在 task=failed 时把未消费的 cross_clarify_sessions 升级 abandoned；扫描幂等。

## 5. 关键技术选型理由

按 RFC 规范交代几个我做的判断与理由：

1. **新 NodeKind vs 扩展现有 clarify**：选**新 NodeKind**。端口数（1+2 vs 1+1）、问题数上限（1+ vs 1-5）、UI（reject 按钮）、跨 agent 注入逻辑都不同，强行复用 clarify 节点要堆 mode 分支让单点节点变成胖节点；新 NodeKind palette 独立 + 代码路径独立，未来扩展不绊。
2. **沿用 RFC-023 envelope vs 新 envelope tag**：选**沿用**。`<workflow-clarify>` envelope schema 已稳定、agent 已习惯输出；改 tag 名（如 `<workflow-cross-clarify>`）只是给 agent 增加心智负担、无技术收益。仅在 cross-clarify 节点 attach 时把问题数上限关掉。
3. **多源汇总：等所有解决 vs 单源即触发**：选**等所有解决**。产品意图是 designer "一次性看到所有来源的反馈再修文档"，避免多轮 designer 重跑级联 / token 浪费 / 多源 cascade race。但 reject 不阻塞 designer——reject 的 questioner 独立去 STOP，不进 designer 触发条件。
4. **reject 跨轮持久 vs 仅本轮**：选**跨轮持久**。reject 的产品语义是"我不想再被这个反问者打扰"，跨轮持久是该意图的天然延伸；仅本轮会让 cascade reset 后用户在 iter 2 又被同一组问题骚扰。
5. **builtin token vs auto-append only**：选**两者都做**。auto-append 是默认兜底（agent 模板没引用时自动注入到 user prompt 末尾倒数第二段）；builtin token 给 agent 模板作者精确控制位置（譬如希望把 External Feedback 注入到自己模板某 section 之间）。与 RFC-023 4 token 设计对称、未来扩展点明确。
6. **inline session 独立配 designer / questioner vs 一个开关**：选**独立配**。designer 多轮重跑续 session 收益大（保留它思考 caching strategy 的全部上下文），questioner 续 session 收益小（每次任务是"看完新 doc 提新问题"，session 历史可能反而拖累）。两个角色场景不一样、独立配最贴合。
7. **abandoned 状态 vs 保持 answered**：选**abandoned**。task fail 时未送达的反馈应该有明示状态、不靠用户跨表 join 推断；session resume / 事后排查时 "answered + abandoned + designer_failed" 比 "answered + 隐含 designer 没跑" 干净。配 RFC-053 invariant 自动升级。
8. **agent-single 限定 vs 早期 multi 支持**：选**严格限定**。多 shard fan-out 同时反问的语义复杂度（每 shard 各自 session / 多 shard 答题 UI / 部分 shard reject / 全 shard 汇总到 designer）需要单独 RFC 收敛；本 RFC 先把单 agent 单 designer 单 questioner 跑通。
9. **loop 内部分持久（reject 持久 + Q&A 复位）vs 全持久 vs 全复位**：选**部分持久**。loop 的产品语义是"重新跑一轮 body"，Q&A 历史复位与之自洽；但 reject 是用户对**反问者本身**的态度表达，与 loop iter 边界无关、应跨 iter 持久。两条规则源自两个不同语义维度，合并到部分持久是最符合产品直觉的折中。

## 6. 与其它 in-flight / 已落地 RFC 的关系

- **RFC-023 self-clarify**：本 RFC 的直接基础。所有 RFC-023 envelope / Form / clarify_iteration / `## Clarify Q&A` token / 协议块在 cross-clarify 路径**完全 reuse**；本 RFC 仅在并列处加 cross-clarify 自己的等价路径（cross_clarify_iteration / `## External Feedback` / Reject 按钮等）。
- **RFC-026 inline session mode**：本 RFC 引入 `sessionModeForDesigner` / `sessionModeForQuestioner` 两个新字段，继承 RFC-026 inline 失败回退机制；RFC-026 原 `sessionMode` 字段在 RFC-023 self-clarify 节点上行为零差异。
- **RFC-039 ask-bias preamble + STOP CLARIFYING anchor**：本 RFC reject 路径 reuse RFC-039 STOP CLARIFYING 文案；questioner agent 在 cross-clarify 通道下也复用 RFC-039 引入的 ask-bias preamble（"挂了反问通道 = 默认应先反问"）。
- **RFC-014 sibling cascade**：本 RFC designer 被外部反馈重跑后下游级联 reset 直接 reuse RFC-014 路径；reject 持久性在 cascade 中通过 cross_clarify_sessions.directive='stop' 优先级覆盖天然不冲突。
- **RFC-053 node-run lifecycle hardening**：本 RFC 新增 abandoned 状态 + cross_clarify_iteration 列 + 重跑触发条件，全部走 RFC-053 已规范化的 lifecycle 转移函数 + invariant 扫描；abandoned 状态对应一条 invariant "answered session + parent task failed → abandoned"，加入 daemon 启动 + 每小时扫描循环。
- **RFC-021 task-detail-tabs**：cross-clarify 节点的 node_run 在 task 详情页"节点运行"tab 里复用 awaiting_human 状态色 + chip "cross"；本 RFC 不抢 RFC-021 的 UI 范围。
- **RFC-035 ux-consistency**：本 RFC 新加按钮 / Inspector segmented / Reject modal 全部走公共组件（`<Button variant='danger'>` / `<Segmented>` / `<Dialog>`），不自写 DOM chrome。

## 7. 风险

| 风险                                                                     | 评估                                              | 缓解                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| 多源等待引入死等：用户漏答某个 cross-clarify 节点导致 designer 永不重跑  | 中：用户体验上"为什么我提交了 designer 还没动"   | A18 顶部 banner + 跳转链接 + Clarify tab badge 数                     |
| reject 持久性误判：reject 后用户后悔                                     | 低：UI 二次确认 modal + 文案明示"不可撤销"；改主意需重启 task | 二次确认 + i18n 文案                                                  |
| 同 agent 既 designer 又 questioner 误用                                  | 低：validator warning 引导                        | A14 warning + S5 文档                                                 |
| External Feedback prompt 体量大                                          | 低：每轮仅最新 Q&A、designer 不带历史；多源 5 个 cross-clarify × 5 题 ≈ 5KB 文本 | 不做特别处理                                                          |
| inline session 在 cross-clarify 路径下与 RFC-026 inline 在 self-clarify 路径下行为不一致 | 极低：两套字段独立、各自封装 fallback           | C7 测试守护                                                           |
| reject 后 questioner 仍继续 emit clarify envelope                        | 低：STOP CLARIFYING 强指令 + envelope 解析器拒绝建新 session（warning 记录） | C4 测试 + protocol block 增强 + A21 验收                              |
| 多 cross-clarify 并发 submit race                                        | 低：DB 单写者 + scheduler 多源等待原子检查        | If-Match 乐观锁 + DB 事务                                             |
| designer cascade 耗尽 retries 留 abandoned session                       | 中：用户混淆"我答了为什么没生效"                | A15 abandoned UI chip + i18n hint + RFC-053 invariant 自动升级        |
| wrapper-loop 内 reject directive 跨 iter 持久 vs Q&A 历史每 iter 复位 双语义共存让人困惑 | 中：产品文档需要清晰阐述                        | RFC design.md + 用户故事 S4 双向覆盖                                  |

## 8. 后续可能的延展（v1 不做）

- agent-multi 作为 questioner / designer：fan-out 多 shard 反问、多 shard 答题 UI、shard 级 cascade 与汇总。
- cross-clarify 历史 diff 视图：让用户看历史 N 轮反问问题变化轨迹。
- 跨 cross-clarify 节点的"批量答题"模式：当多个 cross-clarify 节点提的题部分重叠时一次答覆盖。
- review 节点也支持触发 designer 重跑（"review reject + 反问"复合）。
- LLM 生成 framework synthesis 智能化（v1 是确定性纯函数）。
- 跨 task 续 opencode session：task 失败后用户启新 task 续会话。
- reject 撤销：管理员级 escape hatch（譬如 admin 后台改 directive 重启 task）。
