# RFC-044 — 人工编辑记忆的 scope / tags / title / body

## 1. 背景

RFC-041 落地后，平台的"长期记忆"完全由 distiller agent 自动产出：

- `scope_type` / `scope_id` 由 distiller 模型自己判定（agent / workflow / repo / global 四选一 +
  对应 id），写入 `memories.scope_type/scope_id`。
- `tags` 由 distiller 从"当前 scope 已用 tag 池"里挑 / 偶尔提新 tag。
- `title` / `body_md` 由 distiller 写英语自然语言。

admin 在 `/memory` → Approval Queue 的能力今天只有 4 个：approve / approve_and_supersede /
reject / archive。其中 approve / approve_and_supersede 允许 `tagsOverride`——这是**唯一**的"人
工修改"入口，且只在 promote 那一刻生效；scope_type、scope_id、title、body_md 一律不能手改。
approved 后行被产品文 §G7 明确锁死：「approved 后正文不可改；修改 = 起一条新 row 走 supersede
链」，proposal §P143 还为 `body_md` 加了"任何 PATCH 都被 grep 守卫挡住"的 5xx 测试。

这套设计在 distiller 推断准时成立，但实际跑下来三类问题反复出现：

1. **scope 错位**：distiller 经常把一条普适规则推成"agent: senior-engineer"——admin 想把它
   提升到 global，或者反过来收窄到具体 workflow，**没有任何操作可以做到**。她唯一的选择是先
   reject 这条候选，然后手动 POST 一条 `source_kind='manual'` 的新候选（创建路径走的是
   `createManualCandidate`，但用户也得自己重写 title/body），再去 approve。链路冗长且丢失了
   原 distiller 的推理上下文。
2. **tag 拼写 / 命名漂移**：distiller 间歇会把同义 tag 写成不同 case（如 `git-workflow` vs
   `git_workflow`），或起一个 newTag 但 admin 想合并进现有池。tagsOverride 只能在 promote
   时纠一次，approved 后这条记忆的 tag 永久错位。
3. **正文措辞偏离**：distiller 偶尔把 review 决策概括得过于绝对（"never X" 而 admin 觉得应该
   是"prefer not X unless Y"）。今天 admin 要么 reject 重写 + 重新经过 distiller debounce，要
   么 approve 一条措辞不准的记忆容忍它注入到运行时 prompt。

后两类（tag / 正文）尤其磨人，因为 RFC-041 §G7 的"approved immutable"约束本意是保证 supersede
链可审计——但 admin 修个错字也走 supersede 链会让链路在第一年内就膨胀到上百节。

## 2. 目标

放开 4 个字段的人工编辑能力，覆盖 candidate 与 approved 两类行，**显式 supersede RFC-041 §G7
"approved 后正文不可改"** 的约束。

### 2.1 必须做到

- **可编辑字段**：`scope_type`、`scope_id`、`tags`、`title`、`body_md` 全部支持人工修改。
  - 跨 `scope_type` 编辑允许（global ↔ agent / workflow / repo 任意组合），由 admin 自己
    保证 scope_id 与 scope_type 配套。后端 schema 校验照旧（global 必 null、其余必非空）。
  - tags 不限制必须从"已用 tag 池"挑，仍受 `MemorySchema` 的 16 条上限 + 单 tag 40 字节。
- **状态覆盖**：`status ∈ {candidate, approved, archived}` 三类行都能改。`superseded` /
  `rejected` 不能改（已经是终态，改它没有任何运行时副作用，且会把 supersede 链搞乱）。
- **原地修改 + version 自增**：approved 行的编辑**不**起新 row、**不**写 supersede 链，直接
  UPDATE 同 row 并 `version += 1`。runner 的 inject 走 live read（RFC-041 PR3 已落），下一次
  `runNode` 自然读到新值。
- **审计可见**：每次编辑写一条 WS 广播 `memory.updated`，前端订阅者刷新；后端 log 一条
  `memory-edited` 含 `editedBy` / `fieldsChanged`，便于事后排查。
- **权限新增 `memory:edit`**：与 `memory:approve` 解耦。仍只发给 admin 角色（与 RFC-036
  既有 5 个 memory:* 位的发放策略一致）。
- **UI 入口**：
  - Approval Queue 卡片（candidate）增加"编辑"按钮，开内联编辑面板（field-level 编辑 → save
    → 卡片就地刷新）。
  - 全部 / by-scope / scope-detail 三类列表的 row 增加"编辑"按钮，仅在 status ∈
    {candidate, approved, archived} 显示，开同一编辑面板（独立 dialog 形态）。
- **immutable 守卫拆除**：RFC-041 proposal §P143 那条"`body_md` 不被任何 PATCH"的 grep 守卫
  改成"`body_md` 仅由 `PATCH /api/memories/:id`（permission=`memory:edit`）和 `promoteCandidate`
  写"，保留 grep 但允许新路由名出现。
- **测试覆盖**：schema 单元（5 字段独立 PATCH / 跨 scope_type 边界 / tag 上限）+ service 单元
  （version bump / WS 广播 / 状态终态拒绝）+ route 单元（permission / 404 / 422 / 409）+
  frontend EditDialog 测试（form 校验 / save 后刷新）+ e2e 1 spec（admin 进 Approval Queue
  改 scope + tag，approve，verify approved row 用新 scope/tag）。

### 2.2 非目标（v1 不做）

- 不引入历史编辑表 / changelog。version 字段只是"行级心跳"，不维护每次改动的 before/after
  快照。如未来要做审计回放，单独走 RFC。
- 不改 supersede 链的语义。supersede 仍只在 `approve_and_supersede` 的 promote 路径产生；
  PATCH 不写 supersede。
- 不改 `source_kind` / `source_event_id` / `source_task_id` / `distill_job_id` /
  `distill_action` / `approved_by_user_id` / `approved_at` 这些来源字段——它们是"这条记忆怎么
  来的"的不可变记账，admin 编辑不应抹掉。
- 不放开 `superseded` / `rejected` 行的编辑。这两类是终态。
- 不批量编辑——v1 只支持单条编辑。
- 不通过本 RFC 解决 distiller 推 scope 不准的根因（distiller prompt 优化是独立工作）。

## 3. 用户故事

### S1：admin 把过窄 scope 调成 global
distiller 产了一条 candidate：scope=agent/senior-engineer，title="prefer trailing-comma JSON
configs"。admin 觉得这条对所有 agent 都成立，她在 Approval Queue 候选卡片点"编辑"，下拉切到
`global`，scope_id 自动置 null，点 Save。卡片刷新成"global / [no tags]"，她按 Approve。
之后任何 agent 跑 runNode 都会注入这条。

### S2：admin 修 tag 拼写
distiller 给一条 approved memory 打了 `git_workflow`，admin 想统一成 `git-workflow`（与其他
12 条记忆对齐）。她进 `/memory` → All → 该 row 点"编辑"，tags 输入框删旧加新，Save。
WS 广播 `memory.updated`，列表当场更新；下一次 runNode 注入的 tag 已经是新值。

### S3：admin 修正过度绝对的措辞
review 决策被 distiller 概括成"never auto-merge after CI green"，admin 想改成"prefer manual
merge after CI green unless the PR is a chore/docs change"。她进编辑面板改 body_md，Save。
版本号从 v1 → v2，approved_by_user_id / approved_at 不变（不是新 approval，是 metadata 编辑），
WS 触发订阅者刷新。

### S4：超出范围的尝试都被拒绝
- admin 试图把一条 `superseded` 的旧记忆改回 active，PATCH 返 409 `memory-terminal-status`。
- admin 试图把 scope_type 改成 'global' 但忘了清空 scope_id（前端 bug），后端 422 schema 拒绝。
- 非 admin（无 `memory:edit`）试图调 PATCH，403 `permission-denied`。

## 4. 验收标准

- 新接口 `PATCH /api/memories/:id`：
  - 接受部分 update（任一字段可选，至少一个非空）。
  - 接受 `{scopeType, scopeId, title, bodyMd, tags}` 的子集，**显式忽略**其他字段（不会因为
    body 带 `version: 99` 就 bump 到 99）。
  - 校验 schema（global vs scope_id 互斥 / tags 16 条 / title 1-120 / body 1-4000 字节）。
  - 校验 status：terminal 状态（superseded / rejected）→ 409 `memory-terminal-status`。
  - 不变更：`source_*`、`distill_*`、`approved_*`、`supersedes_id` / `superseded_by_id` 字段。
  - 成功：`version += 1`，WS 广播 `memory.updated`，返回 `{ memory: Memory }`。
- 新权限位 `memory:edit` 加入 PERMISSIONS 常量；admin 角色默认拥有；user 角色无。
- WS 协议增加 `memory.updated` 离散类型。
- 前端：
  - 新组件 `MemoryEditDialog`（受控 form + zod 校验）。
  - Approval Queue 候选卡片新增 row-level "编辑"按钮，仅 candidate 显示。
  - All / by-scope / scope-detail 三处 `MemoryRow` 新增"编辑"按钮，仅 `{candidate, approved,
    archived}` 显示。
  - 编辑 dialog Save 后通过 invalidateQueries 刷新列表；订阅 WS 的列表会因 `memory.updated`
    自动 refetch。
- 不退化：现有 RFC-041 4 个 promote action / archive / unarchive / delete 路径全部不变；
  inject 的 live read 在编辑后下一次 runNode 立刻生效（RFC-041 PR3 §6 已保证，无需新代码）。
- RFC-041 proposal §G7 显式更新一行：「approved 后**body_md / title / scope / tags 由
  RFC-044 放开人工编辑**；supersede 链仍保留用于"语义性替换"，不为"修正错字"承担职责」。

## 5. 与既有 RFC 关系

- **RFC-041**：本 RFC 显式 supersede §G7 一句话约束，其余（distiller / dedup / inject / WS /
  权限分发）全部沿用。`body_md` 的 grep 守卫从"任意路由禁止 PATCH"放宽到"仅
  `memory:edit` + promote 可写"，仍 grep 锁。
- **RFC-043**：详情页里若展示一条本次 distill 产出的 candidate，admin 在详情页"候选区"也可
  点击跳 Approval Queue 编辑——本 RFC 不在详情页内嵌编辑入口（避免一个 dialog 在两个路由各开
  一份）。
- **RFC-036**：新权限位 `memory:edit` 走 RFC-036 的 permissions 中间件 + admin 默认发放；
  非 admin 命中 403。
- **RFC-039 / RFC-040 / RFC-042**：完全正交，不触碰 runner / scheduler / wrapper / clarify。
