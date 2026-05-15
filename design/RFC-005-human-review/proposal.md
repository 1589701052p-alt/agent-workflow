# RFC-005 Proposal — 设计文档人工评审节点 + Markdown 渲染 / 评审意见 / 历史版本与 Diff

> 状态：Draft（2026-05-15）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

v1 把"全自动 Code → Audit → Fix"的编排骨架打通了：用户在 canvas 上拼出 input → agent → … → output，点 Launch，agent 进程按 DAG 跑，落 `<workflow-output>` envelope，task done。这是**机器对机器**的完整链路。

但**软件设计 / 业务设计**类工作流的真实形态是**人和 AI 协作**：

1. agent_designer 产出 `design.md`（架构、接口、数据流）。
2. 人审，提"这里的事务边界应在 Service 层不是 Repo 层""section §3.2 的 sequence 缺 retry 分支"等具体意见，或者直接打回"整体方向错了，重做"。
3. agent_designer 拿到意见**继续迭代**，最多回炉数轮后落地。

当前 v1 缺三类能力：

- **缺工作流原语**：没有"人工评审节点"。能让 agent 输出 markdown，但无处给人评、无法把评审意见**结构化地**反馈回 agent 进入下一轮生成。
- **缺渲染面**：用户在 UI 上拿到的 markdown 只是一段文本字段，没有渲染（list / table / mermaid / plantuml 全是裸文本）。设计文档里大段 mermaid 时序图、PlantUML 类图根本看不了。
- **缺历史与对比**：每轮迭代 agent 重新跑、新 md 覆盖旧 md，**无法对比"上一轮你写的"和"这一轮你改的"**，反审者只能凭记忆判断 agent 是否真的改了。

这正面挡掉了"用 platform 跑设计评审循环"的整条产品愿景。

### 1.1 为什么要现在做

- v1 路线图已 81/81 收尾，进入 RFC-only 增量演化阶段；RFC-001 ~ RFC-004 把 runtime / agent form / canvas 边连接 / 输入端口契约打磨完，下一道墙就是"workflow 里没有人参与的位置"。
- 用户故事直接卡在"我想用这个跑 PRD/技术设计评审"——没有这个能力 platform 在设计评审场景一行业务跑不起来。
- 用户已经明确表达了完整需求列表（见本 RFC 第 3 节"用户故事"），无歧义。

### 1.2 本 RFC 不动哪些地方

- **不动**现有 agent-single / agent-multi / wrapper-git / wrapper-loop / input / output 六类节点的运行时语义；review 节点是**第七类**叶子节点，新增的字段都加在 review 自己上。
- **不动**现有 `<workflow-output><port name="">…</port></workflow-output>` envelope 解析（K1）；review 通过 agent frontmatter `outputs[i].kind`（`markdown` / `markdown_file`）做"内容形态"区分。
- **不动** RFC-003 的 catch-all handle / RFC-004 的 `syncInputDefs`；review 节点的输入端走的就是 RFC-003 catch-all 那条路径。
- **不动**现有 retry 的 `pre_snapshot` git stash 机制；review 的 reject 重跑就是它的"由审批触发的版本"。
- **不动** worktree / task GC / events archive 已有路径；history 存档跟着 task 走，task 删时一并清。
- **不内嵌 PlantUML jar**（避免 GPL 合规 + 不要求用户装 java）：改为可配置外部 HTTP 渲染端点（kroki / plantuml-server 兼容）。

## 2. 目标

### 2.1 做

1. **新 NodeKind `review`**：叶子节点，单输入端（接上游某个 `outputs.kind=markdown[_file]` 的 port），三出口语义：`approve` / `reject` / `iterate`。Canvas 左侧 palette 新增 "Human" 分类容纳它。
2. **Agent outputs 加 `kind` 字段**：`outputs[i]` 由原 `string`（端口名）扩为 `{ name: string, kind?: 'string' | 'markdown' | 'markdown_file' }`，默认 `'string'` 向后兼容。`markdown` = envelope 文本就是 md 正文；`markdown_file` = envelope 文本是 worktree 内相对路径，框架读盘。
3. **任务状态新增 `awaiting_review`**：顶层 `tasks.status` + 子级 `node_runs.status` 都加这个枚举值。task 上只要任一 node 处于 `awaiting_review`，task 顶层就显示 `awaiting_review`。该状态不占并发名额（idle）。
4. **`review_iteration` 字段**：`node_runs` 加 `review_iteration INTEGER NOT NULL DEFAULT 0`，与现有 `retry_index` 解耦——技术重试（process crash / 超时）走 retry_index、审批驱动的重生走 review_iteration。
5. **`doc_versions` 表 + 文件系统快照**：每个 review 节点每个 awaiting_review 轮次的 md + 当时全部评审意见 JSON + decision + 触发 prompt 一并落档；md 正文以文件存 `~/.agent-workflow/runs/{task-id}/review/{node-id}/{port}/v{n}.md`，DB 仅持索引。
6. **`review_comments` 表**：评审意见独立表，按 `doc_version_id` 关联，含复合 anchor（章节面包屑 + 段落 idx + 段内 offset + 选中原文 + 前后各 30 字上下文 + occurrence_index），保证 AI 重跑时能在多次重名片段中精确定位被点评的那一处。
7. **重跑模板槽位**：agent prompt 模板支持 `{{__review_rejection__}}`（reject 原因）和 `{{__review_comments__}}`（迭代意见列表，框架渲染为 markdown 列表）；未引用时框架自动追加到 user prompt 末尾。
8. **三出口运行时行为**：
   - **approve**：review 节点产出 `approved_doc`（透传 md）+ `approval_meta`（decision/decided_at/iteration_count）两 port；下游可达。
   - **reject**：按 review 节点上配置的 `rerunnable_on_reject`（默认 = 直接上游 + 上游所有可达上游）回滚到 `pre_snapshot`，重跑生成新 doc_version_v(n+1)，review 节点自动回到 `awaiting_review`。**默认还原文件**。同一上游的 sibling review 节点（其它 port 上的 review）一律作废重审。
   - **iterate**：按 `rerunnable_on_iterate`（默认 = 仅直接上游）重跑。**默认不还原文件**。Agent 仍输出全部 port，但框架在 doc_version 合并阶段**只接受 target port 的变动**，其它 port 沿用上一版本——保证"提意见微调 portA"不会副作用打到 portB。
9. **评审 UI（Markdown 渲染面 + 评审侧栏）**：
   - md 渲染：GFM（table / footnote / task list / strikethrough）+ shiki 代码高亮 + KaTeX 数学 + 客户端 Mermaid + 外部 PlantUML 端点（可配置）。
   - 选词触发：拖选任意文本（跨段落但不跨标题）→ 浮出评审框 → 写文本 → 提交 = 即不可编辑 / 取消 = 丢草稿；草稿期间 IndexedDB 持久化（关 tab 不丢）。
   - 右侧评审侧栏：按文档位置排序，与正文 scroll 双向联动（正文滚到 anchor → 侧栏高亮 + 自动滚到可见；点侧栏 → 正文跳并高亮 anchor）；评审框可删。
   - 三按钮在右上角：**通过 / 返回修改 / 重新生成**，分别绑 approve / iterate / reject；按下 reject/iterate 弹只读 modal，列出"本次将回滚并重跑：[节点 A → 节点 B]"，回滚集合由 workflow 配置承载，审批者不可调。
   - 审批者点 approve 时若 sidebar 还有未提交 draft，提示 modal："还有 N 条未提交评论，approve 将丢弃"，需用户二次确认。
10. **左栏新增 Reviews 标签 + task 内嵌评审面板**：
    - 全局 Reviews tab：列所有 task 的 review 项，按 task 分组、组内按节点拓扑顺序；segmented filter "待评审 / 已通过 / 已拒绝 / 全部"，默认"待评审"；未读数量 badge。
    - task 详情页内同款 panel，便于"看 task 状态时立刻审"。
11. **Diff view**：审过一轮 reject/iterate 后再开同一 review，顶部出现 "对比上一版" 切换；左侧 = 上一被拒/迭代版本 + 当时评审意见（只读）、右侧 = 当前版本（可写新评审）；以 markdown 标题路径联动滚动；diff 粒度可在 "词 / 行 / 节点" 三档间切换（默认词级，使用 `Intl.Segmenter` 处理 CJK）。Diff toggle 在 v1（首版）时禁用。
12. **历史归档**：每次 reject/iterate 触发新一版生成前，把当前版本完整快照（md 正文 + 评审意见 JSON + decision 详情 + 触发本次生成时的 prompt 快照）落 `doc_versions` 表 + 文件系统；用户可在 review 详情翻历史版本下拉。
13. **WebSocket 多 tab 同步**：复用现有 `/ws/workflows`，新增 `review.created` / `review.decision_made` / `review.comment_added` / `review.comment_deleted` 事件，让多 tab / 多设备的评审面板实时同步。
14. **可配置外部 PlantUML 端点 + 客户端 Mermaid**：Settings 新增 "Rendering" tab，输入 `plantumlEndpoint`（默认空 → fallback 渲染源码 + 提示）；走 kroki 风格 `GET {endpoint}/plantuml/svg/{deflate-base64}`，POST raw source 作为 fallback；可选 `plantumlAuthHeader`。
15. **i18n + 键盘快捷键全集**：所有 review UI 文案走 zh-CN + en；快捷键：`A` approve / `R` reject / `I` iterate / `J/K` 跨评审跳转 / `Ctrl+1/2/3` 切 diff 粒度 / `Ctrl+Enter` 提交评审。
16. **schema bump v2 + 自动 migrator**：`$schema_version: 2`，老 workflow（v1）GET 时透明上提（不带 review 节点的工作流上提没风险）。

### 2.2 不做

- **不做**评审线程 / 回复 / 多用户审批工作流（v1 单用户，schema 预留 `author / assigned_to` 字段但不暴露）。
- **不做**评审决策上限。`review_iteration` 不设 cap，由人节制。框架只记录、不强制截断。
- **不做**部分 port 重生（reject 永远全 port 重生；iterate 由框架在合并层过滤变动，agent 侧仍跑全 port）。
- **不做** worktree 锁。`awaiting_review` 期间用户用 IDE 改 worktree 不阻止；只 watch mtime，UI 顶部出现 "worktree 自最近一版本生成后被改动" banner。
- **不做** plantuml.jar 内嵌（GPL + java 探测）。改为可配置外部 HTTP 端点；用户没填 → 源码渲染 + 一行提示。
- **不做** YAML 导入路径下的 review 节点新形态向后兼容；YAML 是 user-authored 产物，要求和 canvas 一致，schema v2 不满足直接拒导。
- **不做** worktree GC 改造；history 文件落 `~/.agent-workflow/runs/{task-id}/review/…`，跟 task 一起被现有 GC 路径回收，不引入额外清理周期。

## 3. 用户故事

**S1（happy path：approve）**
用户拼工作流：`input(requirement) → designer(agent-single, outputs: [{name: 'design', kind: 'markdown'}]) → reviewDesign(review, input.source=designer.design)`。点 Launch → designer 跑完产出 `design.md` → reviewDesign 进入 `awaiting_review` → task 顶层 `awaiting_review` → 左栏 Reviews 出现待评审项。用户进评审页：md 渲染（含 mermaid 时序图）、读完 → 点"通过"→ task 继续，下游节点（如果有）开始跑。

**S2（reject path）**
同样工作流。用户读完认为方向跑偏 → 点"返回修改"→ modal 提示"将回滚并重跑：[designer]"→ 确认 → 输入拒绝原因 "需求方向应聚焦 B2B，目前文档写成了 B2C" → 提交。daemon 把 designer 的 `pre_snapshot` stash 还原，把 `{{__review_rejection__}}` 渲染为 "需求方向应聚焦 B2B..."，重跑 designer → 新 doc_version_v2。reviewDesign 自动回到 awaiting_review。用户复审，发现确实改对了 → 点通过 → 同 S1。

**S3（iterate path）**
用户读完认为整体可以但有 3 个具体问题：在"## 接口设计"下面拖选"`POST /api/v1/orders/cancel`"→ 浮出评审框 → 写"取消操作应该是幂等的，需要带 idempotency_key"→ 提交。再在"## 数据模型"段选"`order_status` enum"→ 写"枚举值需要包含 partially_refunded"→ 提交。在"## 时序图"段选"步骤 3 调用 PaymentSvc"→ 写"应该是异步消息，不是同步 RPC"→ 提交。三条意见都进右侧侧栏。点"重新生成"→ daemon 把这三条意见结构化注入 `{{__review_comments__}}`（每条带章节面包屑 + 选中原文 + 上下文）→ designer 跑出新版本。reviewDesign 进 awaiting_review v3。用户开 review 页：顶部多了"对比 v2"按钮，点开 diff view，左侧 v2 + 三条意见（只读）、右侧 v3。三条都改对了 → 点通过。

**S4（multi-port one node）**
designer agent 一次产出三份 md：`outputs: [{name:'proposal', kind:'markdown'}, {name:'design', kind:'markdown'}, {name:'plan', kind:'markdown'}]`。canvas 拉三个独立 review 节点：reviewProposal / reviewDesign / reviewPlan。三个并行 awaiting_review。用户先 approve proposal、再 approve design、点 reject plan 写理由"plan 缺成本估算"。daemon 触发 designer 重跑（A2/L2：reject = 全 port 重生），新 v2 三份 md 全更新。三个 review **都重回 awaiting_review**（A2 你的决定：sibling 一同作废）。用户复审三份新版，分别 approve。

**S5（multi-process fan-out）**
工作流：`input → analyzer(agent-multi, sourcePort='git_diff', outputs:[{name:'review', kind:'markdown'}]) → reviewShard(review)`。analyzer 对 diff 按 per-file 分片，跑出 7 个 shard，每个产出一份 markdown 风格 review。reviewShard 节点在 runtime 自动 fanout 成 7 个 `awaiting_review` 实例（A4）。用户在 Reviews tab 看到这 7 项分组在同一 task / 同一节点下，按 shard_key（文件路径）字典序排列。逐个审；其中两个 reject 触发 analyzer 对那两个文件的 shard 单独重跑（不是整批），其它 5 个不受影响。

**S6（wrapper-loop 嵌套）**
工作流是个迭代闭环：`input → wrapper-loop[ designer → reviewDesign ](max_iterations=5, exit_condition=approval)`。每轮 designer 写文档、reviewDesign 审；用户点 reject 或 iterate 走重跑直接进入 loop 下一 iteration（A5 允许嵌套）。点 approve 触发 exit_condition 命中，loop 退出。loop 每个 iteration 产出独立 doc_version 历史。

**S7（历史对比 + 找回）**
S3 跑了 4 轮后用户最终 approve。事后用户想回看"v2 时我提了哪些意见、v3 改了哪些"。进 review 详情 → 顶部历史下拉切到 v2 vs v3 → diff view，左侧 v2 + 当时三条意见（只读）、右侧 v3，可在标题层级联动滚动；切粒度到"行"或"节点"看不同视角。

**S8（worktree 被外部改动）**
用户在 awaiting_review 期间用 VSCode 打开 worktree 改了某个文件。review 页顶部立刻出现 banner "worktree 自该版本生成后被外部修改" + "查看 diff" 链接。用户决定 approve 时弹 modal 二次确认"worktree 已变动，approve 后下游节点会基于变动后状态运行，继续？"。

**S9（PlantUML 端点未配置）**
用户的 md 含 plantuml 代码块。Settings 中 plantumlEndpoint 为空。md 渲染面把 plantuml 块降级为 `<pre>` 源码 + 顶部一行 muted "未配置 PlantUML 渲染端点（Settings → Rendering 可配 kroki 或 plantuml-server URL）"。不阻断评审流程。

## 4. 验收标准

### 功能

- **A1（S1 happy path e2e）**：拖 input + designer agent + review 三节点连边，launch → designer 跑完 → review 进 awaiting_review → UI 显示 md 渲染（mermaid svg）+ 三按钮 → 点 approve → task done。
- **A2（reject 回滚）**：reject 后 daemon 调用 `worktreeRestoreSnapshot(node.preSnapshot)`、designer 重跑、新 doc_version_v2 入库、review 重新 awaiting_review；旧 v1 评审意见归档但 v2 不带；旧 worktree 文件已还原。
- **A3（iterate 部分接受）**：designer 输出 portA + portB 两 md；iterate 只评 portA；agent 重跑输出 portA' + portB'；框架 doc_versions 落库时 portA 写新值、portB 沿用 v1；review 仅对 portA。
- **A4（multi-process fanout）**：analyzer per-file 分片 5 个，5 个 review 实例并行 awaiting_review。
- **A5（评审 anchor 精度）**：md 里"order_status"出现 3 次，用户选第 2 次出现的那一处写意见、提交，重跑后 prompt 渲染出的 `{{__review_comments__}}` 包含 occurrence_index=2 + 上下文，agent 能从 prompt 单义辨认。
- **A6（diff view 滚动联动）**：在 v2/v3 diff 视图中，左侧滚到 "## 数据模型" → 右侧自动同步滚到同标题；切到节点粒度时按 paragraph 颗粒 diff。
- **A7（评审侧栏双向联动）**：md 滚动 → 侧栏当前 anchor 项高亮且自动滚到可见区；点侧栏意见 → md 跳到 anchor 高亮 2s。
- **A8（PlantUML 端点）**：Settings 填 `https://kroki.io/`，plantuml 代码块渲染出 svg；端点超时 → toast + 该块 fallback 为源码；未配置 → 直接源码 + muted 提示。
- **A9（Reviews 全局 tab）**：跨 task 列待评审项；segmented filter 切到"全部"显示已审历史；左栏 nav 项有未读 badge。
- **A10（多 tab WS 同步）**：开两 tab，A tab 提交评审意见 → B tab 侧栏立刻新增该意见；A approve → B 顶部状态从 awaiting_review 变 approved。
- **A11（schema v2 migrator）**：DB 里有 v1 workflow + 新启 daemon，GET workflow 返回 `$schema_version: 2` + 字段无丢失；老 task / node_run 不受影响。
- **A12（draft 持久化）**：写一半评审 → 关 tab → 重开 → 草稿恢复到选中区。
- **A13（worktree 外部修改 banner）**：awaiting_review 期间 `touch <worktree>/foo.md` → review 页顶部 banner 出现；approve 触发二次确认 modal。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** RFC-001 ~ RFC-004 既有测试不退化；尤其 RFC-004 的 `tests/input-port-contract.test.ts` / `sync-input-defs.test.ts` 不动。
- **B3** backend tests 至少 +25（新 schema migration 1 + node_runs 状态机 5 + review decision 处理 6 + doc_versions 落档 4 + sibling review 作废 2 + multi-process fanout review 2 + iterate 部分接受 3 + envelope kind 解析 2）。
- **B4** frontend tests 至少 +30（markdown 渲染纯 helper 6 + anchor 复合定位 8 + diff 粒度切换 3 + scroll-spy 双向 4 + draft IndexedDB 持久化 3 + Reviews tab 过滤排序 3 + plantuml 端点 fallback 3）。
- **B5** Playwright e2e 增 1 个新文件 `e2e/review.spec.ts` 覆盖 S1 全链路（fixture 用 stub-opencode 多次返不同 envelope 模拟 reject → iterate → approve）。
- **B6** 单二进制构建包体积 / 启动时间不退化（PlantUML 不内嵌即天然达成）。

### 回归防护

- **C1** `tests/review-anchor-disambiguation.test.ts` 顶部注释链回本 RFC + 注"locks in B2 anchor precision contract; 红了说明 anchor schema 已破裂，AI 无法在重名片段中单义定位"。
- **C2** `tests/review-iterate-partial-merge.test.ts` 顶部注释：锁定 L2 决定"agent 输出全 port 但框架只合并 target port"，红了立刻去检 doc_version 合并代码。
- **C3** `tests/review-sibling-invalidation.test.ts` 顶部注释：锁定 A2 sibling review 重 awaiting_review 行为，防有人后续把它改成"只重审 reject 那一个"。
- **C4** 源代码层兜底断言：`grep -q "{{__review_rejection__}}" packages/backend/src/services/prompt.ts` + `grep -q "{{__review_comments__}}"` 在 `tests/review-prompt-injection.test.ts` 里以源码文本断言形式保留——防止 token name 被静默重命名（这俩名字写进 RFC 是用户期望的 stable contract）。
