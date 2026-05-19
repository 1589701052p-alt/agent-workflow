# RFC-046 — Session 页签展示本 node_run 注入的 memory 快照

## 1. 背景

RFC-041 PR3 在 `runner.ts:320-341` 通过 `injectMemoryForRun` 把当前 task 命中
四类 scope（agent closure / workflow / repo / global）的 approved memory 拼成
一段 `## Learned context (auto-injected, advisory)` block，**append 到 primary
agent 的 inline prompt 末尾**注入到 opencode 子进程。

这条路径是**纯 live read，零落库**：

- 注入完成后 runner 只把整段 prompt 序列化进 `OPENCODE_CONFIG_CONTENT`，**没有**任何字段记录"这次 runNode 注入了哪些 memory id / 当时版本 / 当时正文"。
- `node_runs` 表 `prompt_text` 字段虽然存了**最终用户 prompt**（即 `renderUserPrompt` 的输出），但 memory block 是拼在 **system / agent prompt** 里、不在 user prompt 里，因此连"间接快照"都没有。

带来的实际问题：

1. **黑盒注入**：admin 在 `/memory` 改了一条记忆后，无法回答"我刚跑的那个 task 里到底用上没？用上的是 v1 还是 v2？"——只能去 grep events / 翻 distill 日志 / 重放，对支持调试极其不友好。
2. **审计回放断链**：RFC-043 已经把 distiller subprocess 完整对话录下了（`memory_distill_events`），反过来"目标 agent 在 session 中接收到的 inject"却仍是黑盒，跟 distill 详情页割裂。
3. **后续修复的归因困难**：一条 review 决策 / clarify 答复要回溯"这一轮 agent 是带着哪条记忆跑的"，目前没有任何运行时证据；后续如果做"memory 注入回归测试"或"按 memory 命中度做 distill 优先级排序"，都需要这层落库当输入。
4. **inject 行为变更 silent**：RFC-041 §G4 已经计划未来按 `disabledScopes` 关掉部分 scope；当用户把 global 关了，没有任何方式让她在某次 task 里**看到** "本次 inject 缺了 global scope"——只能信文档。

## 2. 目标

让 task 详情页 → agent 节点 drawer → Session 页签**自带一块"本 session 注入的 memory"展示区**，把 RFC-041 的隐式注入显式化。

### 2.1 必须做到

- **粒度**：以 `node_run` 为最小单位。同一节点的 attempts / 多 shard 子 run / loop / review / clarify iteration 各自独立（沿用 RFC-005 / 014 / 022 / 023 既有 attempt 切换器）。
- **持久化形态**：在 `node_runs` 新增 `injected_memories_json` 列（nullable）存储**完整快照**——`[{ id, version, scopeType, scopeId, title, bodyMd, tags, sourceKind, approvedAt }]`——而不是只存 `[id]`。原因：
  - approved memory 在 RFC-045 落地后会允许人工原地编辑 + bump version；只存 id 会让历史 session 看到当前最新值，丢掉"当时注入了什么"。
  - 让一条 memory 被 archive / superseded / delete 后，历史 task 详情仍可如实回放（不退化成"已删除"灰条）。
- **何时写入**：在 `injectMemoryForRun` 内部完成 memory 集合解析、刚要 `formatMemoryBlock` 之前——把要喂进 block 的同一份 `MemorySet` 序列化（按 budget 裁剪**之后**的最终集合，不是裁剪前的全量），交给 runner 写回当前 `node_runs.id` 行。
- **envelope-followup 同 session 续跑**（runner.ts:320 `opts.envelopeFollowup === true` 时整段 inject 被跳过）：**沿用第一次 attempt 的注入记录**——这条 attempt 的 `node_runs` 行 `injected_memories_json` 直接 copy 自该 (node_id, iteration, shardKey, reviewIteration, clarifyIteration) 下 `retry_index = 0` 那一行；这样前端 attempt 切换器切到 followup 时仍看得到完整记忆列表，与"opencode session 里其实还带着这一块 prompt"的事实一致。
- **空集合显式 null**：注入返回 `null`（block 未拼出来，prompt 字节级零变更）时，列写 `NULL` 而不是 `'[]'`；前端区分"未注入过"vs"注入了空集合"。今天 RFC-041 的 `injectMemoryForRun` 在四 scope 全空时返回 null，正是该路径。
- **UI**：Session 页签**顶部、attempts 切换器下方**插入一个 `<details>` 折叠卡片，标题 `Injected memories (N)`，默认折叠；展开后是按 scope 分组的列表，每条显示 title（左）+ scope chip（agent/workflow/repo/global + scope name）+ tags + `v{N}` + `…body 前 N 字符省略` 预览，单击展开看 body_md 全文（受 inline markdown 渲染）。N=0 时显示一行灰色 "No memories injected" 兜底（区别于"运行时跳过"和"老行未捕获"两种 NULL 态）。
- **NULL 态文案三分**：
  - `injectedMemoriesJson === null` 且 `kind` 为 agent 且 attempt 完整跑过：**老行兼容**——显示 "Inject record not captured (pre-RFC-046 run)"。
  - `kind` 不是 agent（input / output / wrapper / review / clarify）：**整块隐藏**（这些 run 本就不走 inject 路径）。
  - envelope-followup attempt：显示 "Inherited from attempt 0"（带跳转锚点）+ 列表内容。
- **WS 一致性**：本次不引入新的 WS 消息类型。现有 `node.update` 在 `node_runs.injected_memories_json` 写入时一并触发（写入发生在 runner 末段、跟 `tokTotal` 等列同一批落库）。
- **权限**：注入记录不附加新权限位。能看见 task 详情 / node_run 详情的人就能看见。**body_md 已经是 admin 审批通过的内容，且本来就以"system prompt 一部分"喂进了模型**——把它原文展示给 task 可见用户与现状等价。
  - 如果 RFC-045 / RFC-036 后续把 memory body 视作 admin-only 资源（目前未要求），届时本 RFC 已经在 schema 里携带了 `scopeType`，前端 / 后端可以按权限位裁剪到只显示 title + scope chip，body 折成 "•••"。本 RFC v1 不预先做这层裁剪。

### 2.2 非目标（v1 不做）

- 不做"注入命中 memory → 跳转 memory 详情页"双向链接（RFC-043 / RFC-041 已经有 `/memory/$id`，前端简单加一个外链锚点就够了，不当作 v1 验收硬指标）。
- 不做注入命中度统计（"过去 30 天哪些 memory 注入了多少次"——独立 RFC）。
- 不做注入 diff（attempt 0 vs attempt 1 的 inject 差异高亮——独立 RFC，理论上 envelope-followup 沿用 attempt 0 就不存在 diff）。
- 不动 RFC-041 `formatMemoryBlock` 文本格式、不动 inject 行为：仅在 inject 已经决出最终集合后顺手落库。
- 不引入回填 migration（历史 node_runs 行 `injected_memories_json` 永远 NULL），不重跑 inject 决策。

## 3. 用户故事

### S1：admin 在 task 详情里核对刚批的 memory 是否被注入

admin 在 `/memory` 批了一条 `scope=workflow/code-review` 的新记忆。她跑了一个用 code-review workflow 的 task，等节点 done，在 task 详情进 agent 节点的 Session 页签——`Injected memories (3)` 卡片就在 attempts 切换器下方。她展开，看到这条记忆赫然在列，scope chip 显示 `workflow / code-review`，version `v1`。如果列表里**没**，她立刻知道 inject 链路出了问题（而不是模型没听话）。

### S2：跟踪 envelope-followup 的注入

agent 第一次 envelope 解析失败被 RFC-042 拉回重跑，attempt 1 的 Session 页签 attempt 切换器切到 attempt 1，`Injected memories (3)` 标题旁多了一个小灰色标签 `Inherited from attempt 0`，点击锚点跳到 attempt 0 同位置——证明 followup 没有重新触发 inject，但模型 session 里仍带着这段。

### S3：老 task 回看

打开一个 RFC-046 落地之前完成的 task，节点 Session 页签照常显示对话，顶部卡片折叠态显示 `Injected memories (—)`，展开后是一条灰色 "Inject record not captured (pre-RFC-046 run)"——区别于 "0 条注入"，让 admin 知道这是历史兼容数据。

### S4：memory 在事后被改了

admin 跑完 task 一周后回去看，发现注入卡片里某条 memory body 末尾标着 `v2`，与今天 `/memory/$id` 上的 `v3` 不一致——证明这条记忆事后被 RFC-045 改过，但本 task 当时跑的是 v2 的内容；正文区域显示的是 v2 的 body_md（来自 `injected_memories_json` 快照），不是当前最新值。可选地附一个 `Updated since this run` 的小 chip 提醒 admin。

### S5：非 agent 节点不显示

打开 input / wrapper-git / clarify 节点的详情，Session 页签**没有**这块卡片（这些节点本就不调 `injectMemoryForRun`），UI 保持现状不引入误导。

## 4. 验收标准

- **DB 列新增**：`node_runs.injected_memories_json TEXT NULL`，migration 0026（按落地时实际编号；与 RFC-043 / RFC-045 落地顺序协调）。
- **写入路径**：`injectMemoryForRun` 改造为同时返回 `{ block: string | null, snapshot: InjectedMemorySnapshot[] | null }`；runner 在 `node_runs` 落库 path 一并写 `injectedMemoriesJson`。`opts.envelopeFollowup === true` 时 runner 不调 inject，但在落 `injectedMemoriesJson` 时 SELECT 同 (task / node / iteration / shard / reviewIter / clarifyIter) 下 `retryIndex=0` 的行复制其 `injectedMemoriesJson` 写到当前行（NULL 安全：复制 null 仍写 null）。
- **shared 新 schema** `InjectedMemorySnapshotSchema`：`{ id: string, version: number, scopeType: 'agent'|'workflow'|'repo'|'global', scopeId: string | null, title: string, bodyMd: string, tags: string[], sourceKind: string, approvedAt: number }`；定义在 `packages/shared/src/schemas/memory.ts` 末段（与 `MemorySchema` 同文件）；`NodeRunSchema` 加可选字段 `injectedMemories: InjectedMemorySnapshot[] | null`。
- **后端 API**：`GET /api/tasks/:taskId/node-runs/:nodeRunId` / `GET /api/tasks/:taskId` 嵌套 `runs[]` 把 `injectedMemoriesJson` parse 后回 `injectedMemories`。`/api/tasks/:taskId/node-runs/:nodeRunId/session`（RFC-027 已落）的 envelope **不**强制把列表搬进来——前端 Session 页签可以独立查 node_run 行拿到这块。
- **前端**：
  - 新组件 `<InjectedMemoriesCard run={nodeRun} attempt={number} firstAttemptRun?={NodeRun} />` 放在 `SessionTab.tsx` 顶部、attempts 切换器之下、`ConversationFlow` 之上。
  - kind 非 agent 时返回 null（不渲染壳）。
  - `injectedMemories === null` 三态分支（pre-RFC-046 / envelope-followup-inherit / 真正注入）。
  - 列表渲染：按 `scopeType` 分组 group，每条单行 chip + title + version + tags + body preview（200 字符 + ellipsis），点行展开 body_md 全文（直接 `<MarkdownRenderer>`，复用既有组件）。
  - 折叠态：`<details>` 半透明边框 + `Injected memories (N)` 标题；N=0 + 注入路径走过 → 显示 `Injected memories (0)`；N=null + agent kind → `Injected memories (—)`。
- **i18n**：中英新增 ~10 key（`nodeSession.injectedMemoriesTitle / Empty / NotCaptured / InheritedFromAttempt0 / Group_{agent,workflow,repo,global} / SourceKindDistill / SourceKindManual / Version / UpdatedSince`）。
- **测试**：shared 5 case（schema round-trip / nullable scope_id / tags 上限同 MemorySchema / 错 scope_type → reject / NodeRunSchema 可选字段）；backend 12 case（runner 写入快照含全字段 / budget clip 后才落库 / four scope 全空 → 列写 NULL / non-agent kind 不写 / envelope-followup 继承 attempt 0 写入 / 老行回 NULL / API 端点 parse / API 错误 JSON → 不抛错回 null + warn / migration 0026 / runner 不触碰其他列 / `formatMemoryBlock` byte-for-byte 不变 / `injectMemoryForRun` 返回新签名向后兼容）；frontend 10 case（card 三态渲染 / scope group 排序 / kind=input/wrapper/output/review/clarify 不渲染 / version chip / tags 渲染 / body preview 长度 / body 展开 / followup 锚点跳转 / pre-RFC-046 文案 / i18n key 双语对齐）。

## 5. 与既有 RFC 关系

- **RFC-041**（长期记忆）：本 RFC 是**纯加性 follow-up**，零改 distiller / dedup / scope 决策 / promote / archive / inject 行为，只在 inject 决出最终集合后顺带落库。`formatMemoryBlock` 的字节级输出守恒（grep 守卫不动）。
- **RFC-027**（node session view）：本 RFC 的 UI 接入点是 RFC-027 已经存在的 `SessionTab.tsx`，仅在顶部插一个新组件，**不**改 `ConversationFlow` / `parseSessionTree` / event 落库路径。
- **RFC-042**（envelope-followup recover）：本 RFC 显式继承 attempt 0 的 inject 快照——与 RFC-042 跳过 inject 的事实保持物理一致（opencode session 里其实还带着第一轮的 block）。
- **RFC-043**（distill job detail）：本 RFC 反向闭环——RFC-043 让 admin 看 distiller 怎么产 memory，本 RFC 让 admin 看 memory 怎么被 inject 进目标 agent。两侧 `<MarkdownRenderer>` / `<details>` 组件复用一致。
- **RFC-045**（manual memory edit，draft）：RFC-045 落地后 approved memory body 会原地编辑 + bump version；本 RFC 快照机制天然兼容——历史 task 看的是当时的 version + body，不会被 RFC-045 的 PATCH 影响。可选的 `Updated since this run` chip 由前端做"本行快照 version vs 当前 `/memory/$id` version 比较"得出。
- **RFC-036**（多用户协作 + 权限）：本 RFC 不引入新权限位，沿用既有 task 详情可见性。如果未来需要把 memory body 视作 admin-only 资源，再在前端按 `permissions.has('memory:read')` 裁剪 body 字段。
- **RFC-029**（inventory snapshot）：列名 / 写入时机与 `inventory_snapshot_json` 平行，两者均由 runner 在子进程结束后落库；互不耦合。
