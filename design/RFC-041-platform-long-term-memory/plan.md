# RFC-041 — 任务分解 & PR 拆分

## 全景

RFC-041 = 平台第一次落 **新业务域**（不是局部增强），改动面横跨 migration / shared schemas / backend services / backend routes / daemon worker / frontend routes + components / i18n / e2e / styles。一次性单 PR 太大、review 难、回滚痛。

拆 **5 PR**，前后约束 = 严格依赖链（前一个不落 / 不绿，后一个不能合）。每个 PR 自带测试 + typecheck + format:check + GitHub Actions 六 jobs 全绿才合。

```
PR1: migration + shared schema + memories CRUD skeleton (无 distiller / 无 inject)
  └─ PR2: distiller + 后台调度 + 信号入队（candidate 能产出）
       └─ PR3: inject 接入 runner（approved memory 进 system prompt）
            └─ PR4: 顶栏 Memory tab 全 UI + Inbox 集成 + 任务详情留言区
                 └─ PR5: agent / workflow / repo 详情页 Memories sub-tab + 收尾
```

每 PR commit 前缀：`feat(memory): RFC-041 P{N} <短描述>`。

---

## PR1 · 数据层 + REST skeleton（无 distiller / 无 inject）

**目标**：表存在，admin 能在 UI（直接 fetch API 或 curl）手动 POST `/api/memories` 创建一条 candidate / promote 成 approved；其它任何 runtime 行为零变化。

**子任务**

- **T1.1**：迁移 `0023_rfc041_memories.sql` —— 3 表 + 索引 + CHECK 约束。
- **T1.2**：drizzle schema 加 `memories` / `memoryDistillJobs` / `taskFeedback` 模型，barrel re-export。
- **T1.3**：shared `schemas/memory.ts` + `schemas/taskFeedback.ts` 全套（含 ws msg union）+ barrel。
- **T1.4**：shared `schemas/config.ts` 加 `memoryDistillerEnabled` / `memoryDistillModel` / `memoryInjectionBudget` 三字段（默认值见 design §3.3）。
- **T1.5**：backend `services/memory.ts` —— `createCandidate` / `promoteCandidate` / `archiveMemory` / `unarchiveMemory` / `deleteMemory` / `listMemories(filter)` / `getMemoryById`。
- **T1.6**：backend `routes/memories.ts` 6 个接口 + RFC-036 权限点接入。
- **T1.7**：backend `auth/permissions.ts` 加 5 个 PERMISSIONS + admin / user ROLE_PERMISSIONS。
- **T1.8**：backend `ws/broadcaster.ts` + `server.ts` 加 `/ws/memories` 通道（仅 memory.* 4 个事件，distill 事件下一 PR 加）。
- **T1.9**：测试：
  - shared (`memory-schema.test.ts` / `task-feedback-schema.test.ts` / `memory-ws-schema.test.ts`) 共 ≥ 18 case
  - backend (`migration-0023.test.ts` 1 + `memory-promote.test.ts` 6 + `routes-memory.test.ts` 8) 共 ≥ 15 case
- **T1.10**：三件套全绿 + GitHub Actions 六 jobs 全绿。

**PR1 验收清单**

- [ ] 3 表 + 索引按 design §2 落地
- [ ] CHECK 约束（global scope_id null / 非 global scope_id 非 null）写入越界 → SQLite 拒绝
- [ ] PERMISSIONS 加 5 项；非 admin 调 4 个写接口 → 403
- [ ] admin POST `/api/memories` 创建 candidate / POST `/api/memories/:id/promote` 转 approved / 列表过滤 status 正确
- [ ] supersede 链事务原子：A.supersedes_id=B AND B.superseded_by_id=A AND B.status='superseded' 同 transaction
- [ ] `/ws/memories` 推送 4 个 memory.* 事件正确
- [ ] 测试 +33 一次过；既有 1400+ 测试零退化
- [ ] STATE.md 顶部"进行中 RFC"行更新

**不在 PR1 范围**：distiller / 调度 / 信号入队 / runner 注入 / 前端 UI / i18n。

---

## PR2 · distiller + 后台调度 + 信号入队

**目标**：clarify session 完成 / review 决策 / feedback 留言 → 5s debounce → distiller spawn opencode subprocess → candidates 自动入库。**仍然不 inject** 到 runtime（admin 能在 PR1 UI 看到自动产出的 candidate，但 agent 行为零变化）。

**子任务**

- **T2.1**：backend `services/memoryDistiller.ts` —— `DISTILLER_AGENT_NAME` 常量 + `DISTILLER_SYSTEM_PROMPT` 常量（写死英语 prompt，按 design §5.1）+ `runDistill(job, siblings)` + `buildDistillerUserPrompt` + `parseDistillerOutput` + `validateAndPersistCandidate`。
- **T2.2**：backend `services/memoryDistillScheduler.ts` —— `enqueueDistillJob` + `computeEligibleScopes(taskId)` + `startMemoryDistillLoop` 1Hz tick + shutdown recovery（running → pending）。
- **T2.3**：backend `services/clarify.ts` —— `completeClarifySession` 末尾 `enqueueDistillJob({sourceKind:'clarify', sourceEventId, taskId})`。**只在状态首次转 completed 时**入队（防重）。
- **T2.4**：backend `services/reviews.ts` —— `recordReviewDecision` 末尾入队 review job（同 PR-2.3 防重）。
- **T2.5**：backend `services/taskFeedback.ts` —— `createTaskFeedback` 写表 + 入队 feedback job。
- **T2.6**：backend `routes/taskFeedback.ts` —— GET / POST 接口（task 可见性接 RFC-036）。
- **T2.7**：backend `routes/memoryDistillJobs.ts` —— GET 列表 / retry / cancel 3 接口（admin only）。
- **T2.8**：backend `ws/broadcaster.ts` 加 `/ws/memory-distill-jobs` 通道 + 4 个 distill.* 事件。
- **T2.9**：backend `cli/start.ts` —— daemon startup 调 `startMemoryDistillLoop()` + graceful shutdown stop。
- **T2.10**：测试：
  - backend `memory-distiller.test.ts` 8 case（mock spawnOpencode）
  - backend `memory-distill-scheduler.test.ts` 10 case（enqueue / debounce / exp backoff / shutdown recovery）
  - backend `clarify-enqueues-distill.test.ts` 2 case（completed 入队 / 非 completed 不入队）
  - backend `review-enqueues-distill.test.ts` 2 case
  - backend `routes-task-feedback.test.ts` 6 case（POST 入队 / GET 可见性 / 非 collaborator 403）
  - backend `routes-distill-jobs.test.ts` 4 case
  - backend `daemon-distill-loop.test.ts` 3 case（tick / shutdown / disabled flag 关闭 worker）
  - grep guards: `memoryDistiller.ts` 必含 `OPENCODE_CONFIG_CONTENT` + `mkdtemp` (2 case)
- **T2.11**：三件套 + GitHub Actions 全绿。

**PR2 验收清单**

- [ ] clarify session 完成 5s 后 candidate 自动出现在 admin approval queue
- [ ] 同 task 同 source_kind 多次 event 在 debounce 窗口内合并为单次 distill
- [ ] distill 失败 3 次后 job 转 failed，admin UI 可手动 retry 转回 pending
- [ ] memoryDistillerEnabled=false 时 enqueue 仍写表（audit），worker 不消费；切回 enabled 时积压全部 drain
- [ ] distiller cwd = OS temp dir（grep guard 守卫）
- [ ] 任务 done 后仍可 POST 留言（status 不限制）
- [ ] 测试 +37 一次过；既有零退化

**不在 PR2 范围**：runner 注入 / 顶栏 UI / 任务详情留言区 UI。

---

## PR3 · runtime inject

**目标**：approved memory 自动注入到每次 runNode 的 inline agent JSON，agent system prompt 末尾出现 `## Learned context` 段；inject 后既有 task 行为发生实质改变。

**子任务**

- **T3.1**：backend `services/memoryInject.ts` —— `loadInjectableMemories(taskId, agentId)` + `formatMemoryBlock(set)` + `clipByBudget` + `estimateTokens`（粗粒度 chars/4）。
- **T3.2**：backend `services/runner.ts` —— `buildInlineAgentJson` 末尾调 `formatMemoryBlock`，非 null 时 `${prompt}\n\n${block}` append。
- **T3.3**：backend `services/agentClosure.ts`（如有）—— 复用既有 dependsOn 闭包；如无单独函数，从 RFC-022/028/031 的 runner inline 合并代码里抽出公共函数。
- **T3.4**：测试：
  - backend `memory-inject.test.ts` 14 case：
    - 0 approved → 返 null，inline JSON 不含 memory block
    - 4 scope 各 1 条 approved → block 含 4 行
    - agent closure 闭包覆盖 dependsOn agent 的 memory
    - budget=0 时该 scope 行 0 出现
    - budget 切片：第 N 条超预算被丢
    - superseded memory 不入注入
    - archived memory 不入注入
    - global memory 总是 inject 不论 task scope
    - inject 后 inline JSON 末尾含 BEGIN/END 包围符（字符串断言）
    - 同 agent 多 dependsOn 时去重（同 memory 不被注入两次）
    - repo scope id 不在该 task 范围时该 scope 行 0
    - 多 scope 时按 scope 顺序排（agent / workflow / repo / global）
    - block 内每行 `- [scope] title — body` 格式精确
    - 4 scope budget 总和不超 settings.memoryInjectionBudget 总和（合理性 sanity）
  - backend grep guards:
    - `runner.ts` 必含 `formatMemoryBlock(` 调用
    - `memoryInject.ts` 必含 `BEGIN INJECTED MEMORY` / `END INJECTED MEMORY`
  - backend `runner-inject-integration.test.ts` 3 case：跑一个最简 workflow，断言 spawnOpencode 收到的 inline JSON 含 memory block（mock spawn）
- **T3.5**：三件套 + GitHub Actions 全绿。

**PR3 验收清单**

- [ ] 跑 task 时 mock opencode 接收的 inline JSON 包含 `## Learned context (auto-injected, advisory)` 段
- [ ] 0 approved memory 时 inline JSON 与 PR2 前完全一致（无干扰）
- [ ] budget 默认 agent 1500 / workflow 800 / repo 800 / global 500，admin 可在 /settings 改
- [ ] inject live：admin 任意时刻 approve 后下次 runNode 立即看到（无快照）
- [ ] grep guard 锁住 runner 必调 formatMemoryBlock，防回归
- [ ] 测试 +19 一次过；既有零退化

**不在 PR3 范围**：前端 UI。

---

## PR4 · 顶栏 Memory tab 全 UI + Inbox + 任务详情留言区

**目标**：admin 能在浏览器完整走"看到 candidate → 比对 → 审批 / 驳回 / 覆盖"的闭环；任务详情页底部有可写留言区；非 admin 在顶栏看到只读 Memory tab。

**子任务**

- **T4.1**：frontend routes —— `/memory/*` 5 个文件（layout + 4 子 tab + index redirect）。
- **T4.2**：frontend hooks —— `useMemoryWs` / `useMemoryDistillJobWs` 复用 RFC-024 `useWebSocket` pattern。
- **T4.3**：frontend lib —— `lib/memory.ts` 纯函数：`promoteActionToLabel(action, refId)` / `groupCandidatesByScope(rows)` / `formatMemoryRow(memory, locale)`。
- **T4.4**：frontend components/memory/ —— `<MemoryApprovalQueue />` / `<MemoryRow />` / `<MemoryConflictCompareDialog />` / `<MemoryDistillJobsTable />` / `<MemoryByScopeBrowser />`。
- **T4.5**：frontend components/tasks/ —— `<TaskFeedbackList taskId />`（含提交 textarea + rate-limit + WS 追加）。
- **T4.6**：frontend `routes/tasks/$taskId.tsx` 底部 mount `<TaskFeedbackList />`。
- **T4.7**：frontend shell —— 顶栏 nav 加 Memory 项 + badge（admin 显示 pending count）。
- **T4.8**：frontend `components/shell/InboxDrawer.tsx` —— admin 时加 "Pending memory" group。
- **T4.9**：i18n —— `zh-CN.ts` / `en-US.ts` +约 32 key（design §10）+ Resources 接口同步扩展。
- **T4.10**：styles.css —— `.memory-*` / `.task-feedback-*` 命名空间（接 RFC-035 设计 token，零新 token）。
- **T4.11**：测试：
  - `task-feedback-list.test.tsx` 6
  - `memory-approval-queue.test.tsx` 5
  - `memory-conflict-compare-dialog.test.tsx` 3
  - `nav-memory-tab.test.tsx` 3
  - `inbox-pending-memory-group.test.tsx` 3
  - `lib-memory.test.ts` 5
  - `use-memory-ws.test.tsx` 3
  - `i18n-keys-symmetry.test.ts` +1（自动锁 32 新 key）
- **T4.12**：三件套 + Playwright 不退化。

**PR4 验收清单**

- [ ] admin 登陆首屏顶栏看到 Memory tab + badge 实时数字
- [ ] 非 admin 进 /memory 自动重定向到 /memory/all，approve 按钮 disabled
- [ ] 任意 status 的 task（running / done / failed / canceled）详情页都能提交留言
- [ ] 提交留言后 3s 内重复点 submit 被前端阻止
- [ ] WS 推送：admin 端 candidate 出现 / promote / supersede 实时刷新无需 F5
- [ ] action=conflict_with 行点 [Compare] 弹出并排 dialog
- [ ] supersede 链路在 admin 详情页线性显示 chevron
- [ ] i18n 中英对称 + 38 key 完整
- [ ] 测试 +29 一次过

**不在 PR4 范围**：agent / workflow / repo 详情页的 Memories sub-tab；e2e。

---

## PR5 · 各资源详情页 Memories sub-tab + e2e + 收尾

**目标**：agent / workflow / repo 详情页有 read-only Memories sub-tab；完整 e2e 闭环；STATE.md / design/plan.md 落 Done；收尾文案 / hint / 守卫。

**子任务**

- **T5.1**：frontend `<MemoryScopedList scopeType scopeId />` 通用组件。
- **T5.2**：frontend `routes/agents/$id.tsx` / `routes/workflows/$id.tsx` / `routes/cached-repos/$id.tsx`（或同等路径）—— 加 "Memories" sub-tab，嵌入 `<MemoryScopedList />`。
- **T5.3**：frontend `routes/settings.tsx` —— 加一个 section "Memory" 配三个字段：`memoryDistillerEnabled` toggle + `memoryDistillModel` select + 4 个 budget number input。
- **T5.4**：e2e `stub-opencode-memory-distiller.sh` —— echo 固定 candidate envelope。
- **T5.5**：e2e `e2e/tests/memory.spec.ts` —— design §13.4 描述的端到端 5 步。
- **T5.6**：根目录 `STATE.md` 顶部"进行中 RFC"段移除 RFC-041 行，加入"最近完成 RFC（已 push）"段。
- **T5.7**：`design/plan.md` RFC 索引表 RFC-041 行状态 Draft → Done，描述补完工日期 + commit short SHA + CI run id。
- **T5.8**：CLAUDE.md 不动（无需新规则）；如发现新 grep guard 应在 design.md / 测试里加，不进 CLAUDE.md。
- **T5.9**：测试：
  - `memory-scoped-list.test.tsx` 3
  - `routes-settings-memory.test.tsx` 4
  - `i18n-keys-symmetry.test.ts` 跟随 settings 段 i18n key 补
  - e2e 1 spec（含 5 步全链路）
- **T5.10**：三件套 + GitHub Actions 六 jobs 全绿（Playwright 含新 spec）。

**PR5 验收清单**

- [ ] agent 详情页 Memories sub-tab 列出该 agent + dependsOn 闭包所有 approved memory
- [ ] workflow / repo 详情页 sub-tab 类似
- [ ] settings → Memory section：toggle / model select / 4 budget 输入框完整 + 保存 PUT 落 config + 热生效
- [ ] e2e 1 个新 spec 跑通；不破坏既有 6 e2e jobs
- [ ] STATE.md / design/plan.md 落 Done
- [ ] 整 RFC 测试增量统计：shared +约 20 / backend +约 50 / frontend +约 30 / e2e +1 spec

---

## 总测试增量预算

| 层 | 新增 case 估算 |
|---|---|
| shared | ≈ 20 |
| backend | ≈ 75 (含 grep guard + integration) |
| frontend | ≈ 30 |
| e2e | 1 spec (含 5 步) |
| **合计** | **≈ 126** |

合 PR5 后既有套件 1400+ 升至 ≈ 1530，三件套预计仍 < 90s（本地）/ < 6 min（CI）。

## 依赖图

```
PR1 (schema/CRUD)  ←  独立
  ↓
PR2 (distiller/scheduling) ← 依赖 PR1 表 + CRUD
  ↓
PR3 (runtime inject) ← 依赖 PR1 memories 表（approved 行已能从 PR1 手动 POST 产生测试）
  ↓
PR4 (主 UI) ← 依赖 PR1/PR2/PR3 全部 backend
  ↓
PR5 (sub-tab + e2e) ← 依赖 PR4 全部组件
```

任一 PR 失败不阻塞前序 PR 已合的部分；前序 PR 单独跑也是稳定态（参见各 PR "PR{N} 验收清单"）。

## 与并发工作的协调（CLAUDE.md 多人协作）

- `STATE.md` / `design/plan.md` 修改仅追加自己 RFC-041 相关条目，不删别人加的行；PR 末尾如检测到他人未追踪文件 / modified 文件，不主动 `git add`。
- `services/clarify.ts` / `services/reviews.ts` 是热文件（RFC-023 / RFC-026 / RFC-039 / RFC-040 都改它）；只追加 `enqueueDistillJob` 调用一行，不改既有函数体；冲突时优先保留他人逻辑、调整自己 hook 位置。
- `routes/__root.tsx` / shell / Inbox 是 RFC-032 / RFC-035 / RFC-036 共享文件；改动严格按"加 1 个 nav 项 / 加 1 个 inbox group"两个最小局部，不重排 tab 顺序、不调既有 group 排序。
- 迁移 0023 占位前先 `ls packages/backend/db/migrations/` 二次确认 0022 仍是 RFC-040；若被他人抢占 0023，本 RFC 顺延 0024 + design.md / migration filename 全部对齐。

## 回滚路径

参见 design.md §14。简短版：
- 任一 PR 单独 revert（按 commit SHA）；前序 PR 落地的功能仍正常工作（系统在每一步都处于可用稳定态）。
- 5 PR 全回滚顺序：PR5 → PR4 → PR3 → PR2 → PR1（最后 drop tables）。
- 紧急关停："admin 在 /settings 改 memoryDistillerEnabled=false" 立即关掉自动产出 candidate；"清空 memories 表 status='approved'" 立即关掉 inject。两动作均不需 revert PR。
