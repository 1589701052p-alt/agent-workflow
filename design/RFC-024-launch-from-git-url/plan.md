# RFC-024 实施计划

> 配套 `proposal.md` + `design.md`。每条子任务一旦完成立即勾掉，并在 PR / commit message 引用 `RFC-024-Tn`。建议**单 PR 合**，除非冲突倒逼拆分。

## 子任务

### RFC-024-T1 — shared schema + URL 纯函数

- 新文件 `packages/shared/src/git-url.ts`：`parseGitUrl` / `redactGitUrl` / `gitUrlCacheKey`
- `packages/shared/src/schemas/task.ts` `StartTaskSchema`：`repoPath` 改 optional + 新 `repoUrl` / `ref` + 互斥 superRefine
- `packages/shared/src/schemas/cachedRepo.ts`：`CachedRepoSchema` / `ListCachedReposResponseSchema`
- `packages/shared/src/index.ts` 导出新符号
- 测试：`git-url-parse.test.ts` (12 case) + `git-url-redact.test.ts` (6 case) + `git-url-cache-key.test.ts` (6 case)
- 依赖：—
- 大小：S

### RFC-024-T2 — DB schema + migration 0008

- `packages/backend/src/db/schema.ts`：`tasks.repoUrl` 列 + `cachedRepos` 表
- migration `0008_rfc024_cached_repos.sql` + `0008_snapshot.json` + `_journal.json` idx
- 测试：`migration-0008.test.ts`（fresh DB + 老 DB upgrade 两路径，包括 SELECT 老 task 行 repoUrl IS NULL）
- 依赖：T1（task 类型同步）
- 大小：S

### RFC-024-T3 — `services/gitRepoCache.ts` clone + fetch + mutex

- 新模块实现 `resolveCachedRepo` / `listCachedRepos` / `refreshCachedRepo` / `deleteCachedRepo`
- 错误码：`repo-url-invalid` / `repo-clone-failed` / `repo-fetch-warning` / `repo-cache-locked`
- 进程内 URL mutex（基于现有 util 或新增 `util/asyncMutex.ts`）
- stderr 脱敏：所有 runGit 调用穿一个 `redactStderr(url, raw)` 包装
- 配置：从 `ConfigSchema` 读 `gitCloneTimeoutMs` / `gitFetchOnReuse`，含默认值
- 测试：`git-repo-cache.test.ts`（cold / hit / fetch / concurrent same URL 仅 1 次 clone，~7 case）+ `git-repo-cache-error.test.ts`（clone fail / fetch fail / 半成品清理 / DB 行损坏自愈，~5 case）
- 依赖：T1, T2
- 大小：M

### RFC-024-T4 — `services/task.ts startTask` 分支 + URL 元数据写入

- `resolveRepoSource(deps, input)` 私函数
- `tasks` INSERT 时落 `repoUrl`
- URL 模式不调 `upsertRecentRepo`
- `createWorktree` 抛 `worktree-base-invalid` 时 URL 模式 rewrap 成 `repo-ref-not-found`（携带 "可用 refs 前 10 条" 列表，stderr 脱敏）
- multipart 路径（RFC-020）一并兼容
- 测试：`start-task-url.test.ts`（happy + ref 不存在 + 同 URL 第二次任务 cache hit 不再 clone）+ `start-task-path-regression.test.ts` 沿用既有
- 依赖：T1, T2, T3
- 大小：M

### RFC-024-T5 — HTTP 路由

- `routes/tasks.ts` 修改：StartTaskSchema 校验 + redactGitUrl in 4xx 错误体
- 新文件 `routes/cachedRepos.ts`：GET 列表 / POST `:id/refresh` / DELETE `:id`（带 `?force=1`）
- `server.ts` 注册新路由
- 测试：`tasks-http-url.test.ts`（互斥 / 单 URL / 4xx redact，~5 case）+ `cached-repos-http.test.ts`（list / refresh / delete + 409 引用守卫 + force=1，~6 case）+ `redact-url-leak.test.ts` 源代码层兜底
- 依赖：T3, T4
- 大小：M

### RFC-024-T6 — 前端 launcher Repo 来源 tabs

- 新组件 `frontend/src/components/launcher/RepoSourceTabs.tsx`
- 新纯函数 `lib/launch-repo-source.ts`：`buildLaunchBody({ source, inputs, ... })` 输出 path/url 分支 body
- `workflows.launch.tsx` 嵌入新组件 + 替换原 repoPath 表单段；URL 模式下展示"克隆中" loader（POST 等待期间）
- i18n 中英 +6 key（label / placeholder / 缓存提示 / 错误回显 …）
- styles.css +`.repo-source-tabs` 系列
- 测试：`launch-repo-source-tabs.test.tsx`（4 case 切换 + disable） + `launch-build-body-url.test.ts`（4 case 分支输出） + `launch-route-url-wiring.test.ts`（source 切换 → submit body 对应字段 + URL 提交时不写 recentRepos）
- 依赖：T1, T5
- 大小：M

### RFC-024-T7 — 前端 `/repos` 缓存管理页

- 新路由 `frontend/src/routes/repos.tsx`
- 组件：表头 + 每行 Refresh / Delete + Delete 二次确认 modal（引用任务数 + 文案）
- 加入 TopNav / Settings 入口（Settings 内嵌一个 "Cached repos" section 也可，按 RFC-021 Settings 结构）
- i18n +8 key
- styles.css +`.repos-page` `.repos-table` 系列
- 测试：`repos-page.test.tsx`（list 渲染 + Refresh 调用 + Delete 弹窗 + force=1，~5 case）+ `redact-url.client.test.ts`（URL 渲染过 redactGitUrl）
- 依赖：T5
- 大小：S-M

### RFC-024-T8 — 任务详情页 URL 显示

- `tasks.detail.tsx` "详细信息" tab 新增 "源仓库" 行：URL 模式渲染 `redactGitUrl(repoUrl)` + 缓存路径；Path 模式仅显示 repoPath（兼容）
- i18n +2 key（source-label-url / source-label-path）
- 测试：`task-detail-source-row.test.tsx`（path/url 两态渲染 + redact）
- 依赖：T1
- 大小：XS

### RFC-024-T9 — e2e

- `e2e/main.spec.ts` 新 test `RFC-024: launch task from git URL clones into cache and renders redacted URL`：
  - 启动前在 tmp 建一个 bare 仓
  - 走 launcher → 切 URL tab → 填 `file://...` URL → Start
  - 等任务完成 → 进详情 → 断言 "克隆自" 行存在 + URL 已 redact
  - 进 /repos → 断言一条记录 + Refresh 后 last_fetched_at 变化 + Delete 后列表清空
- 依赖：T6, T7, T8
- 大小：S

### RFC-024-T10 — STATE.md / plan.md 索引同步

- `design/plan.md` RFC 索引表追加 RFC-024 行
- `STATE.md` 顶部"进行中 RFC"加 RFC-024（实施完工后改 Done 并迁入"最近完成 RFC"）
- 依赖：—（与 T1 同 commit 即可）
- 大小：XS

## PR 拆分建议

默认**单 PR**（10 个子任务 + 测试），命名 `feat(scope): RFC-024 launch task from git URL with cached clones`。

仅当出现下列任一情况才拆：
- T3 mutex/clone 实现引入 worktree-add 行为偏移 → 拆 backend-only PR 让 RFC-023 / RFC-022 owner 先 review
- T7 `/repos` 页与 RFC-021 Settings 改造发生 routing 冲突 → 把 T7 单独拆后置 PR
- 任何文件超 ~600 行 diff → 评估拆

## 验收清单

- [ ] shared/`bun test` 全绿（T1 + 已有）
- [ ] backend/`bun test` 全绿（T2–T5 + 已有），新增 ~30+ case
- [ ] frontend/`bun test` 全绿（T6–T8 + 已有），新增 ~15+ case
- [ ] `bun run typecheck && bun run format:check && bun run lint` 三连绿
- [ ] e2e Playwright 全绿（macOS + ubuntu，含 RFC-024 新 case）
- [ ] CI run（`gh run list -L 1`）通过后再标 Done
- [ ] 任意涉及 URL 的日志 / event / API response / DB serialize 输出**人工肉眼**抽样检查 redact 生效
- [ ] STATE.md 顶部 "进行中 RFC" 标记移除、"最近完成 RFC" 表新增 RFC-024 行
