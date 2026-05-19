# RFC-043 — 记忆提炼任务详情页

## 1. 背景

RFC-041 引入了"长期记忆"能力：clarify 完成 / review 决策 / task-detail 留言三类事件作为信号，
后台 daemon 1Hz worker 每 5s debounce 一次，spawn 一个内嵌 distiller agent 的 opencode 子进程
（cwd = OS 临时目录，跑完 `rm -rf`），把候选记忆 parse 后写入 `memories` 表，admin 在
`/memory` → Approval Queue 审批。

admin 视角的现状：
- `/memory` → Distill Jobs tab（`MemoryDistillJobsTable`）只能看到 `status / attempts / next_run_at /
  last_error` 几列，行级有 retry / cancel 按钮。
- distiller 子进程的 stdout / stderr / 真实对话过程在 `runDistill` 内存里 parse 完候选**就丢弃**了
  （`packages/backend/src/services/memoryDistiller.ts:704` `rm(cwd, { recursive, force })`）。
- 一次 distill 到底"喂了 distiller 哪些事件 / 看到了哪些已批准记忆作为 dedup 上下文 / 模型回了什么 /
  最终生成的哪些候选成立"，**全部不可追溯**。失败 job 只剩一条 `last_error` 字符串。

这导致几个具体问题：
1. **审批难判断**：admin 在 Approval Queue 看到一条候选 `update_of <某条已有>`，但无法回溯 distiller
   是基于哪条 source event 推导的，也看不到模型的 raw reasoning，只能凭候选 title/body 拍脑袋。
2. **failed/timeout job 难诊断**：`last_error` 是顶层抓的 `Error.message`，看不到 stderr 全文、看不
   到模型实际回了什么（envelope 缺失？格式错？hallucination？），导致 RFC-042 那种"模型回了内容
   但格式错"的 case 完全黑盒。
3. **零空 candidate 的 job 不可解释**：跑了一次但 `candidatesCreated=0`，admin 无法知道是 distiller
   主动判定"无值得记忆的事"、还是所有候选都 zod 校验失败被静默跳过、还是模型根本没理解 prompt。
4. **没有信号闭环**：用户在 task 留言区写"这次的反问应该再激进点"，提交后没有任何反馈链路告诉用户
   这条留言被消费成了哪些候选 / 是否被合并了，连 admin 也只能在 Approval Queue 看候选不知道源头。

## 2. 目标

给 distill job 增加一个 admin-only 的详情页，把一次 distill 的全过程做到**可还原、可审计**。

### 2.1 必须做到

- **完整对话回放**：复用 RFC-027 的 `ConversationFlow` 组件——distiller opencode 子进程的 user
  prompt / assistant text / tool_use / tool_result 全部按时间线渲染，和 worker 节点的 Session
  Tab 视觉一致。
- **侧信息四块齐全**：
  - **本次新生成的候选记忆列表**：每条 row 显示 title / scope chip / distillAction badge /
    当前 `memories.status`（候选 / 已批准 / 已驳回 / 已 archive），点击跳 Approval Queue 锚定该行。
  - **本次消费的源事件**：列出本 job 与同 debounce_key 合并进来的 sibling jobs，每行 `sourceKind`
    + `sourceEventId` + 一句话摘要 + 深链（clarify → `/clarify/$id`，review → `/reviews/$id`，
    feedback → `/tasks/$taskId#feedback-$id`）。
  - **解析的 scope + 当时的 dedup 快照**：scope chip（agent ids / workflow / repo / global）
    + distiller 当时看到的"已批准记忆"列表（用于判断它产 `update_of` / `duplicate_of` /
    `conflict_with` 时的依据）。
  - **失败诊断**：`exitCode` / `lastError` / `stderr` 摘要 / 重试次数；成功 job 这块折叠。
- **新独立路由 `/memory/distill-jobs/$jobId`**：admin only；非 admin 命中走 403 兜底；
  `MemoryDistillJobsTable` 每行整行点击跳此路由（行内 retry/cancel 按钮 stopPropagation）。

### 2.2 非目标（v1 不做）

- 不重做 distiller 调度逻辑（仍是 5s debounce、daemon 1Hz worker、exp backoff、tmpdir 隔离）。
- 不重做候选审批流程（仍走 Approval Queue 现有 UI / 现有 PERMISSIONS 五点）。
- 不提供 distill job 的"重放"功能（不支持基于历史 prompt 再跑一次给新 model）。
- 不做"批量诊断报表" / "提炼成功率周报"等 BI 视图，详情页只服务单 job 排查。
- 不做用户端可见性（普通 user 仍看不到 distill 过程；feedback 提交后给到用户的反馈仍只是
  "Sent to distiller" chip，由 RFC-041 已实现）。
- 不为 v1 多个 attempt 之间做 inline merge（每个 attempt 独立 session，详情页用 attempt 选择器，
  类似 RFC-011 / RFC-027 节点重试切换器）。

## 3. 用户故事

### S1：admin 在审批 Queue 看候选拿不准源头
admin 打开 `/memory` → Approval Queue，看到一条 `update_of` 候选 "always run `bun run typecheck`
before push, not just `bun run test`"，标的是 `agent:senior-engineer` scope，dedup 指向某条已有
"`bun run test` is enough"。她不确定是不是真的应该 supersede 旧的——可能模型只是基于一次
偶发 feedback 而过拟合。

她从 Approval Queue 行的候选 metadata 看到 `sourceRefs: [{kind: feedback, id: tf_01...}]`，点击
打开 distill job 详情页（admin-only 路由）。在详情页她看到：
- 源事件区：那条 task feedback 的全文（"二改之后 commit 又被 hook 挡了，每次都忘 typecheck"）。
- 对话区：distiller 模型把 feedback 上下文 + 当时的 4 条 senior-engineer scope 已批准记忆
  全摆出来，明确说"这条 feedback 提到了 typecheck 而旧记忆只提了 test，应该 update_of 而不是 new"。
- 候选区：本次生成的 1 条候选，状态仍是 `candidate`。

她确认推理合理，回 Approval Queue 点 Approve / supersede 旧条。

### S2：failed job 排错
distill job 连续 attempts=3 失败，`last_error = "distiller subprocess exited with code 1: ..."`，
被 backoff 推到 next_run_at = +120s。admin 进详情页：
- 失败诊断区显示 exitCode=1，stderr 摘要 = `"OpenCode SDK: model auth failed for anthropic/claude-haiku"`。
- 对话区为空（子进程根本没产生 message）。
她判定是 model 配错，去 `/settings` 改 distiller model，回详情页点 Retry。

### S3：feedback 作者想知道留言走向（间接）
S3 不直接走详情页（普通用户进不去），但 RFC-041 已实现的 `tasks.feedback.distilled` chip 配合
本 RFC 的 `MemoryDistillJobsTable` 行级跳转，让 admin 能从 chip 反查到具体 job 详情，对 task
作者的关切给出"这条已经产了候选 / 已被 admin 批准"的答复闭环。

## 4. 验收标准

- /memory/distill-jobs/$jobId 路由对 admin 渲染；对非 admin 返回 "Admin only" 占位（与
  Distill Jobs tab 现有非 admin 占位一致）。
- 任意一个 status ∈ {done, failed, canceled, running, pending} 的 distill job，进详情页都不报错：
  - done 且有 conversation：对话区渲染 ConversationFlow，attempt 选择器显示 1..N（N=attempts+1）。
  - done 且零候选：候选区显示 EmptyState "No candidates emitted"，对话区仍可看模型推理。
  - failed：失败诊断区显示 exitCode / lastError / stderr 摘要，对话区按可用程度渲染（可能为空）。
  - pending / running：状态 chip + spinner，对话区显示 "Conversation will appear once the run
    completes"，侧信息四块按已知信息显示。
- 失败的诊断信息 redact：stderr 摘要走现有 `redactGitUrl` + `clipAndRedact`（RFC-033 / RFC-024
  既有工具）。
- 详情页的 candidates / sourceEvents 链接全部走现有路由，无新增端点收敛。
- 现 Distill Jobs tab 单行 retry / cancel 行为不变；新增整行点击跳详情页，行内按钮 stopPropagation。
- distiller 子进程的对话过程必须能被 BFS 捕获：把 distiller spawn 时的 opencode session id
  抓住，存到 `memory_distill_jobs.opencode_session_id`，跑完调 `captureChildSessions`（与
  RFC-027 完全一致的代码路径，只是 owner 从 nodeRun 改为 distill job）。
- 一次 distill 的 dedup 上下文（"distiller 当时看到的已批准记忆 id 列表"）作为 snapshot 落库，
  避免后续 approve/archive 改了 memories 之后详情页"再算"会算出和当时不一致的快照。
- 失败 job 不阻塞: 整个详情页所有侧信息查询全部各自 `Promise.allSettled`，单块失败显示局部
  error box，其它块仍展示。
- 测试：详情页页面 + 5 个子组件单测齐全；session 捕获扩展的 backend 服务有单元 + 集成；不退化
  现有 1697 frontend + ~1411 backend + e2e 全部。

## 5. 与既有 RFC 关系

- **RFC-041**：本 RFC 是它的 follow-up，依赖 PR1/PR2/PR3 已落地的 `memory_distill_jobs` 表 +
  `runDistill` orchestrator。**不改** PR1 落地的候选 / 注入 / 审批语义；**不延后**它的 PR5
  detail sub-tab（彼此正交）。
- **RFC-027**：完全复用 `ConversationFlow`、`SessionTab` 内的对话渲染 + attempt 选择器交互；
  复用 `sessionCapture.ts::captureChildSessions` + `transcodeOpencodeRowsToEvents`。
- **RFC-029**：distiller 子进程 cwd 是 OS tmpdir，**不**注入 inventory plugin（distiller 是
  pure-prompt agent，无 tools / skills / mcp / plugin），所以 Runtime Inventory 区在详情页里
  不渲染。
- **RFC-036**：路由 + 接口加 `memory:read_distill_jobs` 权限点（admin only，与已有
  `memory:read_distill_jobs` 对齐——实际是 RFC-041 已加的 distill jobs 读权限点）；非 admin 命中
  路由返回 "Admin only" 占位（前端） + 403（后端，复用 requirePermission 中间件）。
- **RFC-042**：distiller subprocess 不走 follow-up 重试路径（distiller 没有 envelope follow-up
  概念，envelope 缺失就是 distiller 模型协议错误，直接计 job 失败、走 RFC-041 的 exp backoff）；
  RFC-043 不修改这个判断。
