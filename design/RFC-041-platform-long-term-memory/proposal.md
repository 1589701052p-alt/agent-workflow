# RFC-041 — 平台长期记忆能力（Platform Long-Term Memory）

Status: Draft
Author: WangBinquan
Created: 2026-05-19

## 背景

当前平台已经具备两个高质量的"用户与 agent 反复对齐意图"的通道：

- **RFC-023 / RFC-026 / RFC-039 反问通道**：agent 在 input 不充分时通过 `<workflow-clarify>` envelope 反问，用户在 `/clarify` 列表答；RFC-039 进一步把"挂接了反问节点"的提示词措辞改为强偏向反问。这条通道每天都在产出"用户希望被这样理解 / 这个决定我希望这样定"的高密度信号。
- **RFC-005 / RFC-009 / RFC-013 review 节点**：人工评审 agent 输出、附 free-text 评语、接受 / 打回 / 重跑。这条通道每天都在产出"这一类输出应该长成什么样 / 哪些细节是审稿人不能接受的"的高密度信号。

但两条通道**只在当前 task 内闭环**：

- 一次 clarify Q&A 答完，下次同一 agent 在不同 task 跑还是从零开始问。
- 一次 review 的"打回理由"在 task done 之后没有人继续读，下个同类 review 还是同样的纠错。
- 用户在任务详情页想"留一句话给未来的我 / 团队"时，没有承载它的地方。

平台缺一个**长期记忆层**：把这些**已经发生且经过人确认**的信号沉淀成可被未来 agent 复用的小段知识，silent inject 进 agent 的 system prompt，让"已经付出过的对齐成本"形成复利。

本 RFC 不是要做向量数据库 / RAG / agent skill marketplace —— 它是一个**经过 admin 审批的、按 scope 切片的、低噪 high-signal 的提示词增强系统**。

## 目标

- (G1) **新数据层**：DB 单表 `memories`（仿 `agents`），承载所有记忆条目；附 `memory_distill_jobs`（distiller 后台调度队列）和 `task_feedback`（任务详情页留言）两张支撑表。
- (G2) **4 类 scope**：`agent` / `workflow` / `repo` / `global`。一条记忆只挂在一个 scope 下；运行时 4 类 scope 同时 active，按预算合并注入。
- (G3) **3 个信号源**：clarify_session 完成 / review 决策 / task_feedback 留言 → 入 `memory_distill_jobs` 后台异步队列，daemon 按 `(task_id, source_kind)` debounce 5s 后调 distiller 跑一次。
- (G4) **distiller = 系统模块**：`packages/backend/src/services/memoryDistiller.ts` 写死 prompt + 走 opencode subprocess + 通过 `OPENCODE_CONFIG_CONTENT` 注入 inline system agent；不进 `agents` 表、不暴露给用户改 prompt（保证一致性 / 升级路径单一）。
- (G5) **distiller 自带 dedup 责任**：每次跑会先把对应 scope 现有 approved memory 列表喂给 LLM，要求输出 `{ candidates: [{ title, body, tags, action: 'new'|'update_of'|'duplicate_of'|'conflict_with', referenceMemoryId?: string }] }`。
- (G6) **审批集中到 admin**：所有 scope 的 candidate 都进 admin 审批队列。普通用户可读所有 approved memory，但**不能写、不能审批、不能删**（write/approve/delete 仅 admin）。
- (G7) **生命周期 = immutable + supersede 链**：approved 后正文不可改；修改 = 起一条新 row、`supersedes_id` 指向旧 id、旧 row 状态转 `superseded`。archive = 状态转 `archived`（不删 row），hard delete 需二次确认。
- (G8) **silent inject**：runner 在每次 `runNode` 时按 scope（agent_id / workflow_id / repo_id / global）拉当前 approved memory，按预算（默认 agent 1500 / workflow 800 / repo 800 / global 500 tokens，settings 可调）合并到 `OPENCODE_CONFIG_CONTENT` 的 inline agent prompt 末尾，附 `## Learned context (auto-injected, advisory)` 段落 + `--- BEGIN INJECTED MEMORY ---` / `--- END INJECTED MEMORY ---` 包围符 + 行级 `- [<scope>] <title> — <body>` 列表；agent 不感知机制。
- (G9) **inject 时机 = live**：每次 runNode 拉最新 approved，不做 task-启动快照；中途新 approved 立刻对下一个节点生效（牺牲严格可重复性换"反馈复利立刻生效"）。
- (G10) **distiller body 固定英语**：所有写入 memories 的 `title` / `body_md` 都是英语，inject 时也是英语（agent 不依赖系统语言区，所有 agent 都能读）；UI 上未来可加翻译展示按钮（非 MVP）。
- (G11) **tag 治理 = distiller 优先复用 + 框架二次校验**：distiller prompt 携带"此 scope 已有 tag 池 + 使用频次"，要求优先复用；输出 schema 分 `knownTags[]` / `newTags[]` 两列；admin 在审批 UI 上看到 newTags 高亮标记，一键改写到已有 tag。
- (G12) **task-detail 留言区**：任务详情页底部一个新 `task_feedback` 留言区（comment-list 样式），任何状态都可写；每条留言独立成 event 入 `memory_distill_jobs` 队列。
- (G13) **UI 顶栏新 "Memory" 一级 tab**：默认进 "Approval Queue" 二级 tab（admin 看到 badge 数 N，普通用户看到只读列表），其它二级 tab：All Approved / By Scope (agent/workflow/repo/global) / Distill Jobs；同时 Inbox drawer 加 "Pending memory" 分组（与 clarify / review 并列），双带入口。
- (G14) **0 schema_version 改动**：workflow YAML / agent frontmatter / 其它 shared schema 完全不动；memories 表是独立外挂，老 task 升级后立刻能 inject 已有 memory（没有，初始为空，回退到 zero behavior）。

## 非目标

- **不做向量检索 / embedding 召回**：MVP 用 "按 scope + recency desc + 预算硬截" 选择策略；embedding 留到 RFC-04N 再开。
- **不做 per-user memory scope**：admin 主导写，per-user privacy 与本 RFC 治理模型不兼容（留到未来若引入"个人秘密"再开）。
- **不做 distiller plugin 化 / 多 distiller 实现可切换**：MVP 单一硬编码实现；换 LLM 走 settings 改默认 model；换 prompt 走代码 PR。
- **不让 agent 主动调 memory tool**：MVP 全部 silent inject；不开 `memory.search` / `memory.list` 这类 tool（防止 agent prompt budget 失控 + 防止 agent 误判 memory 为硬指令）。
- **不做 task 启动快照 / reproducible memory state**：inject 是 live，同一 task 重跑可能看到不同 memory（这是设计选择，不是 bug）；想复现某次跑的 context 用 `node_runs.inventory_snapshot_json`（RFC-029）即可，那张快照不含 memory body 但有 inject 时点。
- **不做 free-form taxonomy**（除了 tag）：scope 4 类已经是分桶维度；不再加 "preference / convention / decision / reference" 这种二级 type，距 user 已有 free-form tag 太近。
- **不做 inject 的多语言翻译**：MVP body 固定英语 inject；UI 译显是后续 follow-up（也由 distiller 翻一份英→中存 `body_md_zh` 字段，或者 LLM 实时翻并缓存，本 RFC 不动）。
- **不动 RFC-039 clarify-ask-bias 文案 / RFC-023 envelope 协议**：memory 是与协议正交的 prompt 层增强，envelope detection、both/neither hard-reject 全部不变。
- **不做 memory 的导入 / 导出 YAML**：MVP 仅 DB；未来如有需求按 workflow YAML import/export 套路再加。
- **不做 memory 间显式关系图（depends_on / contradicts）**：dedup 由 distiller `action` 字段 + supersede 链承载，足够 MVP；要 RAG 关系再开 RFC。

## 用户故事

- **US1（admin / 团队管理员）**：我管着团队的 agent-workflow 实例，团队跑过 50+ 任务，clarify 和 review 都积累了大量信号。打开顶栏 "Memory" tab，看到 "Approval Queue" 里有 12 条新 candidate，分别来自最近 5 个 task。每条 candidate 标着来源（clarify session #C-xx / review #R-xx / 留言 #F-xx）、目标 scope（agent: `codegen-typescript` / repo: `acme/web` / global / workflow: `bugfix-pipeline`）、distiller 给的 action（new / update_of #M-007 / duplicate_of #M-003 / conflict_with #M-011）。我点 "Approve"，candidate 入库；点 "Approve & supersede #M-007"，新 row 落 + 旧 row 状态转 superseded；点 "Reject" 直接丢弃。下一个 task 跑同 agent / 同 repo 时，approved memory 立刻进 agent 的 system prompt。
- **US2（工作流作者 / 普通用户）**：我写了一个 codegen workflow，团队跑了 30 次，agent 反复在 "tab 缩进 vs 2-space" 上问 clarify。这周 admin 把这条共识 approve 成 agent-scope memory；下次我跑同 workflow，agent 不再问这一题。我能在 顶栏 Memory tab 看到这条 approved memory（只读），但改 / 删 / 撤的权限不在我手上。
- **US3（任务发起人）**：我跑完一个任务后，发现有个细节"这次没问，但下次同类任务一定要先问"。我在任务详情页底部留言区写了一段（比如 "always confirm whether the migration needs to be backward-compatible before generating SQL"），保存。后台 5s 后 distiller 跑，出一条 candidate 进 admin 审批队列；admin approve 后这条变成 workflow-scope memory；下次同 workflow 启动时立刻生效。
- **US4（agent 作者 / 顺带的"我"）**：我维护一个 `code-reviewer` agent，看到它在 review 节点反复指出 "missing JSDoc on public exports"。这条 review 决策被 distiller 捕到，admin 审批后落成 agent-scope memory。我打开 agent 详情页 "Memories" 子 tab，能看到它现在挂着 3 条 approved memory，知道未来 agent 已经"自带"这些规约知识，写新 agent prompt 时就不用再加一遍。
- **US5（admin 处理冲突）**：distiller 给我一条 candidate 标 `conflict_with: M-019`（M-019 写的是 "default to functional components"，新 candidate 写的是 "default to class components for legacy compat"）。审批 UI 把 M-019 和新 candidate 并排展示，我可以选 (a) Approve & supersede M-019、(b) Approve as new 让两条共存（系统不阻止矛盾，inject 时按 recency desc 拉到的先）、(c) Reject 新 candidate、(d) Archive M-019 并 Approve 新 candidate。
- **US6（admin 暂停 distiller）**：发现 distiller 把无关私语也提炼成了 candidate，我在 settings 里把 `memoryDistillerEnabled = false`，全局停掉 distiller，留言 / clarify / review 还正常走，仅"自动入候选"暂停。已有 candidate 留着等手动 approve；已有 approved memory 继续 inject。

## 验收标准

1. **数据层（migration 0023）**：
   - `memories` 表存在，列：`id TEXT PK / scope_type TEXT NOT NULL / scope_id TEXT (NULL for global) / title TEXT NOT NULL / body_md TEXT NOT NULL / tags JSON NOT NULL DEFAULT '[]' / status TEXT NOT NULL CHECK (status IN (candidate, approved, archived, superseded, rejected)) / source_kind TEXT NOT NULL CHECK (source_kind IN (clarify, review, feedback, manual)) / source_event_id TEXT / source_task_id TEXT / distill_job_id TEXT / distill_action TEXT / supersedes_id TEXT / superseded_by_id TEXT / approved_by_user_id TEXT / approved_at INTEGER / created_at INTEGER NOT NULL / version INTEGER NOT NULL DEFAULT 1`；索引 `(scope_type, scope_id, status)`、`(status, created_at)`、`(supersedes_id)`。
   - `memory_distill_jobs` 表存在，列：`id TEXT PK / debounce_key TEXT NOT NULL / source_kind TEXT NOT NULL / source_event_id TEXT NOT NULL / task_id TEXT / scope_resolved_json TEXT NOT NULL / status TEXT NOT NULL CHECK (status IN (pending, running, done, failed, canceled)) / attempts INTEGER NOT NULL DEFAULT 0 / next_run_at INTEGER NOT NULL / last_error TEXT / created_at INTEGER NOT NULL / started_at INTEGER / finished_at INTEGER`；索引 `(status, next_run_at)`、`(debounce_key, status)`。
   - `task_feedback` 表存在，列：`id TEXT PK / task_id TEXT NOT NULL / author_user_id TEXT / body_md TEXT NOT NULL / created_at INTEGER NOT NULL / distilled INTEGER NOT NULL DEFAULT 0 / distill_job_id TEXT`；索引 `(task_id, created_at DESC)`。
   - migration 0023 文件名 `0023_rfc041_memories.sql`，up 含 3 张表 + 索引，无回填（initial empty）。
2. **shared schemas**（新增，不动既有）：
   - `MemoryScopeSchema` = `z.enum(['agent', 'workflow', 'repo', 'global'])`
   - `MemorySchema`（id / scopeType / scopeId / title / bodyMd / tags / status / sourceKind / sourceEventId? / sourceTaskId? / distillJobId? / distillAction? / supersedesId? / supersededById? / approvedByUserId? / approvedAt? / createdAt / version）
   - `MemorySummarySchema`（id / scopeType / scopeId / title / status / tags / approvedAt / version）
   - `MemoryCandidatePromoteSchema`（POST body：action: `approve`/`approve_and_supersede`/`reject`/`archive`、supersedeIds?: string[]、tagsOverride?: string[]）
   - `MemoryDistillJobSchema`（用于 GET 列表）
   - `TaskFeedbackSchema`（id / taskId / authorUserId / bodyMd / createdAt / distilled / distillJobId?）
   - `TaskFeedbackCreateSchema`（POST body：bodyMd 1..4000）
   - `MemoryInjectionConfigSchema`（settings 里 4 类 scope 的 token 预算，可选；默认 agent 1500 / workflow 800 / repo 800 / global 500）+ `memoryDistillerEnabled: boolean default true`。
3. **distiller 模块（packages/backend/src/services/memoryDistiller.ts）**：
   - 函数 `runDistill(jobId: string): Promise<DistillResult>`，由 daemon 后台 worker 调用。
   - 拉 `memory_distill_jobs` 行 → 决议 scope_resolved（`computeEligibleScopes(taskId)` 解算 task 关联的 agent ids / workflow id / repo id / global）→ 对每个 scope 拉当前 approved memory 列表（仅 title + body 截前 200 字符 + tags + id）→ 拼 inline system agent JSON（prompt 写死在文件内，含 `<workflow-output>` envelope + candidates JSON 协议）→ spawn opencode subprocess（cwd = OS temp 目录，避免污染 worktree，无 git 调用）→ 解析末尾 envelope 的 candidates JSON → 写入 `memories` 表（每条 status=candidate）→ job 转 done。
   - 失败：异常落 `last_error`，`attempts++`，`next_run_at = now + 2^attempts * 30s`（30s / 60s / 120s），3 次后转 `failed`，UI 上可手动 retry。
   - 单 distill 一次最多消费同 debounce_key 队列 5 个 pending event（合并），其它留到下一轮。
4. **scheduler 入队**：
   - clarify 服务：clarify_session 状态首次转 `completed` → 入 `memory_distill_jobs`（source_kind='clarify', source_event_id=session.id, task_id=session.taskId, debounce_key=`${taskId}:clarify`, next_run_at=now+5000ms）。
   - review 服务：review_doc decision 写入（accept / reject）→ 入队列（source_kind='review', source_event_id=review.id, debounce_key=`${taskId}:review`, +5s）。
   - feedback 服务：POST /api/tasks/:taskId/feedback 成功 → 入队列（source_kind='feedback', source_event_id=feedback.id, debounce_key=`${taskId}:feedback`, +5s）。
   - daemon worker：`startMemoryDistillLoop()`，1Hz 轮询 `SELECT * FROM memory_distill_jobs WHERE status='pending' AND next_run_at <= now ORDER BY next_run_at LIMIT 5`，per job 起 distill；同 debounce_key 多个 pending → 合并（在 distill prompt 里把多条 source event 都列上）后批量转 running → done。
   - daemon shutdown：把所有 running 转回 pending（worker 重启拾起）。
5. **REST 接口**（admin 守卫 = 接 RFC-036 PERMISSIONS 新增 4 个权限点）：
   - `GET /api/memories?status=&scopeType=&scopeId=&search=` → 分页列表，公开（所有 logged-in 用户）。
   - `GET /api/memories/:id` → 详情含 supersede 链。
   - `POST /api/memories/:id/promote` → admin only：body 见 schema。
   - `POST /api/memories/:id/archive` → admin only。
   - `DELETE /api/memories/:id` → admin only，需 `confirm=true` query。
   - `GET /api/memory-distill-jobs?status=` → admin only。
   - `POST /api/memory-distill-jobs/:id/retry` → admin only。
   - `POST /api/memory-distill-jobs/:id/cancel` → admin only。
   - `GET /api/tasks/:taskId/feedback` → 公开（task 可见性同 RFC-036）。
   - `POST /api/tasks/:taskId/feedback` → task 可见者均可写。
6. **WS 通道**：
   - `/ws/memories`：广播 `memory.candidate.created` / `memory.candidate.promoted` / `memory.archived` / `memory.superseded`，admin 端的 Memory tab + Inbox drawer 实时刷新 badge。
   - `/ws/memory-distill-jobs`：广播 `distill.queued` / `distill.started` / `distill.failed` / `distill.done`，admin 监控用。
7. **inject 接入点**：
   - `runner.ts::buildInlineAgentJson(taskId, nodeId, agentDef)` 末尾追加：调 `services/memoryInject.ts::loadInjectableMemories(taskId, agentId)` 拿到 4 类 scope 的 ranked & budget-clipped memory 列表 → `formatMemoryBlock(memories)` 产出 `## Learned context (auto-injected, advisory)\n\n--- BEGIN INJECTED MEMORY ---\n- [agent] title — body\n- [workflow] ...\n--- END INJECTED MEMORY ---` → append 到 inline agent JSON 的 `prompt` 字段末尾。
   - 算法：拉 scope_type IN (agent: 对该 node agent_id + dependsOn 闭包内所有 agent_id；workflow: 该 task 的 workflowId；repo: 该 task 的 repoId；global: ALL global) AND status='approved' → 同 scope 内按 created_at DESC 排 → tokenizer 估字数（粗略 4 chars ≈ 1 token） → 超预算丢尾。
   - 0 approved memory 时，整段 memory block **不出现**（不污染 prompt）。
8. **UI 路径**：
   - 新顶栏 tab "Memory"（i18n key `nav.memory` / `nav.memoryHint`）。默认子路由 `/memory/approval-queue`，4 个子 tab：`/memory/approval-queue` / `/memory/all` / `/memory/by-scope` / `/memory/distill-jobs`。
   - 普通用户进 `/memory` 看到的子 tab 只有 "All Approved" + "By Scope"（隐藏 approval-queue 和 distill-jobs），且 approve / archive 按钮 disabled。
   - 候选列表行 swipe / 按钮：[Approve] [Approve & Supersede] [Reject]；conflict_with action 行额外 [Compare] 弹窗并排展示。
   - 任务详情页底部新 section `<TaskFeedbackList />`：comment-list 样式，timeline-asc 排列，可写者顶部一个 textarea + Submit 按钮（rate-limit 客户端：3s 内禁止重复 submit）。
   - Inbox drawer（RFC-032）新 group `pending memory`（admin 可见），count = pending candidate 数。
   - Agent / Workflow / Repo 详情页新 sub-tab "Memories"（嵌入 `<MemoryScopedList scopeType="agent" scopeId={id} />`），只读浏览 + 跳转顶栏 Memory tab 操作。
9. **权限点（RFC-036 PERMISSIONS 字面量加 4 个）**：
   - `memory:read`（默认 user 和 admin 都有）
   - `memory:approve`（仅 admin）
   - `memory:archive`（仅 admin）
   - `memory:delete`（仅 admin）
   - `memory:write_feedback`（task collaborator + admin；接 RFC-036 task 可见性闭包）
10. **i18n（中英对称）**：新增 ~32 个 key（覆盖顶栏 nav + 4 子 tab + 留言区 + 审批按钮 + action 标签 + distill job 状态 + 权限拒绝提示），中英都有；`i18n-keys-symmetry.test.ts` 自动锁。
11. **测试**：
    - shared：`MemorySchema` / `MemoryCandidatePromoteSchema` / `TaskFeedbackSchema` zod 边界 case ≥ 20。
    - backend：
      - migration 0023 forward 1 case（表 / 列 / 索引存在）。
      - distiller `runDistill` 单元：mock opencode subprocess 输出固定 envelope，断言 candidates 入表 / dedup payload 含 existing memories / action 字段持久化（≥ 8 case）。
      - scheduler 入队：clarify completed / review decided / feedback created 各 1 case 断言 `memory_distill_jobs` 行写入 + debounce_key 正确 + +5000ms next_run_at（≥ 6 case）。
      - daemon worker：debounce 合并（同 key 3 个 pending → 1 个 running）/ exponential backoff / 3 attempts 转 failed / shutdown recovery（≥ 8 case）。
      - inject：`loadInjectableMemories` 按 4 scope 拉 + budget clip + 0 memory 不出 block / `formatMemoryBlock` 输出 anchor 字符串（≥ 10 case）。
      - REST：4 个 admin 守卫接口 403 非 admin / 200 admin / promote 三种 action 落 supersede 链正确（≥ 12 case）。
      - 源码层 grep 守卫：`runner.ts` 必须含 `formatMemoryBlock(` 调用；`distill prompt` 必须含 `<workflow-output>` 协议；`memoryDistiller.ts` 必须含 `OPENCODE_CONFIG_CONTENT` 关键字（≥ 3 case）。
    - frontend：
      - `<TaskFeedbackList />` 提交流 / disabled 状态 / 3s rate-limit / WS 推送追加（≥ 6 case）。
      - `<MemoryApprovalQueue />` 三种 promote action 按钮 click → 调 API mock / disabled when not admin（≥ 5 case）。
      - `<MemoryConflictCompareDialog />` 并排 diff 渲染（≥ 3 case）。
      - i18n symmetry 1 case。
      - 顶栏 nav 加 "Memory" 项的渲染 + 路由跳转 + admin / 非 admin 子 tab 可见性差异（≥ 3 case）。
    - e2e（Playwright）：1 个新 spec `memory.spec.ts` —— admin 跑一个简单 workflow / 答完 clarify / distiller mock 直接吐 1 个 candidate / admin 在顶栏 Memory tab 点 Approve / 下一个 task 启动后 stub-opencode 收到 inline JSON 含 memory block。
12. **三件套门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions 六 jobs 全绿。
13. **回归防护**：
    - `runner.ts` 不再出现 inline agent JSON 直接传出而 **不调** `formatMemoryBlock` 的路径（grep 守卫）。
    - distiller spawn 必须用 cwd=OS temp dir（防止污染 worktree git diff）：grep 守卫断言。
    - memories.body_md 字段不被前端任何路由 PATCH（immutable 守卫）：源码层 grep + REST 单测 405。
14. **零改动清单**：opencode 源码（不改）/ workflow YAML schema（不改）/ agent frontmatter（不改）/ review 节点 (RFC-005) / clarify envelope (RFC-023) / RFC-039 文案 / RFC-040 wrapper_progress / 既有 1400+ test 不退化。

## 风险与权衡

- **R1 distiller 把无关私语提炼成 memory**：用户在 task feedback 留言里写"今天心情不好"也可能被 distiller 提炼。
  - **缓解**：distiller 的 hardcoded prompt 含明确 filter（"discard candidates that are not actionable for future agent runs, not phrased as a generalizable rule, or have no clear scope binding"）；admin 审批是最后一道闸；admin 可以 settings 关 distiller。
  - **接受残留**：仍可能有低质 candidate；UI 给 admin 提供"批量 reject by source kind"按钮（v1.1 加，本 RFC 不做）。
- **R2 admin 成为审批瓶颈**：团队大、candidate 多 → admin 来不及看。
  - **缓解**：MVP 接受这个瓶颈（pending 不入注入，对 agent 行为无影响）；admin 可 settings 关 distiller 减负；未来 v1.x 可加"自动批准 confidence > 0.9 的 candidate"，但需要 distiller 报置信度（不在本 RFC）。
- **R3 inject 体积 vs opencode prompt cache**：每次 runNode inject 的 memory 内容会变（新 approve / 新 supersede），可能造成 opencode 端 prompt cache miss → 多花 LLM 钱。
  - **缓解**：MVP 接受 cache miss；UI 上 admin 可调小预算上限缓解。未来若 opencode 加 cache-aware prefix 支持，可把 memory 块前置成 stable prefix；非本 RFC。
- **R4 memory 矛盾导致 agent 困惑**：同 agent / 同 repo 可能挂 5 条互相打架的 memory（distiller 报 conflict_with 但 admin 让它们共存）。
  - **缓解**：inject 按 created_at DESC 排，"新的先 inject"自然成为隐式优先；UI 上展示 conflict 标记让 admin 知道有这种情况；接受 admin 的判断权。
  - **接受残留**：不做"自动矛盾消解"，admin 自己治。
- **R5 distiller 失败损耗 task 体验**：异步，不阻塞 task；最坏只是 candidate 没生成。
  - **缓解**：失败重试 3 次后转 failed，admin 在 UI 看到，可手动 retry；clarify / review / feedback 主流程零影响。
- **R6 与 RFC-036 多用户冲突**：admin 给 user X 写 memory 后 X 任务都受影响 — 但 admin 不一定知道 X 的细节偏好。
  - **缓解**：scope 是 4 类（agent / workflow / repo / global），不绑定到 user；admin 写的都是组织级共识，自然不和私人偏好冲突。
  - **设计取舍**：本 RFC 不引 per-user scope；想要个人偏好的用户走 task feedback → admin 审批走 workflow 或 global scope。
- **R7 distiller 多 LLM 调用 cost 飙升**：每次 clarify / review / feedback 都跑一次 distiller，团队节奏快时成本可观。
  - **缓解**：debounce 5s 同 task 同 source_kind 合并 + 一次最多消费 5 个 pending；admin 可 settings 关 distiller；distill model 用 cheap 的（settings 可配 distill 专用 model，不与生产 agent 共用）。
- **R8 immutable + supersede 链让审批 UI 变复杂**：每条 memory 可能有多级 supersede 链，审批 conflict 时要展示链路。
  - **缓解**：supersede 链一般 ≤ 3 层；UI 用 "→ supersedes #M-007 → supersedes #M-002"线性 chevron 展示；archive 也走相似 chip。

## 与已落地 / 进行中 RFC 的关系

- **RFC-005 / RFC-009 / RFC-013（review 节点）**：本 RFC 把 review_doc decision 作为 distiller 信号源消费，**只读**，不改 review 状态机 / decision 字段 / WS 协议。
- **RFC-022 / RFC-028 / RFC-031（agent dependsOn 闭包）**：inject 时 agent-scope memory 需要拉"该 node agent + dependsOn 闭包内所有 agent"的合集；复用 `services/agentClosure.ts` 已有的闭包算法，零改动。
- **RFC-023 / RFC-026 / RFC-039（clarify 通道）**：本 RFC 把 clarify_session completed 作为信号源消费，**只读**，不改反问协议 / inline session resume / ask bias 文案。
- **RFC-024（远端仓导入）**：scope 中的 repo_id 直接复用 RFC-024 的 `cached_repos.id`；删 cached repo 时本 RFC 不级联（memory 软挂在 scope_id 上，cached_repos 即便删了 memory 仍可读，只是 inject 时没有 task 路由到那个 scope_id 就不会 inject — 自然过期）。
- **RFC-027（node session view）**：task 详情页底部新 `<TaskFeedbackList />`，与节点详情 drawer 平级（drawer 不动）。
- **RFC-029（runtime inventory）**：本 RFC 不把 memory 内容写入 `node_runs.inventory_snapshot_json`；inventory 仍只快照 agent / skill / mcp / plugin 四类，不快照 memory（防止 inventory.json 体积膨胀；想审计某 run 用过哪条 memory 走未来 v1.x 的 `node_runs.memory_injected_ids` 列，本 RFC 不加）。
- **RFC-032（顶栏导航）**：本 RFC 在 RFC-032 的顶栏分组里新增"Memory"一级 tab（位置：业务三组之后 / 设置之前）；Inbox drawer 新增 "Pending memory" 分组（admin 可见）。
- **RFC-035（UX 一致性）**：审批 UI 复用 `<StatusChip>` / `<EmptyState>` / `<LoadingState>` / `<Dialog>` / `<DetailLayout>` 共享组件；不引新设计 token。
- **RFC-036（多用户）**：权限点新增 5 个挂到 PERMISSIONS 字面量；admin role 自动拿到 4 个写权限；feedback 写权限随 task 可见性闭包；普通用户在顶栏看到 Memory tab 但 approve/archive/delete 按钮 disabled + 隐藏 approval-queue 子 tab。
- **RFC-037（任务名）**：审批 UI 的 candidate 行显示 `task.name`（已有字段）作为来源回链，零改动 RFC-037。
- **RFC-040（wrapper await bubble）**：完全正交，本 RFC 不动 wrapper scope / scheduler / node_runs.wrapper_progress_json；migration 取 0023（0022 已被 RFC-040 占用）。
- **RFC-038（agent deps autodetect）**：完全正交。
