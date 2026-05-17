# RFC-034 实施计划

> 配套 `proposal.md` + `design.md`。每条子任务一旦完成立即勾掉，并在 PR / commit message 引用 `RFC-034-Tn`。建议**单 PR 合**，除非冲突倒逼拆分。

## 子任务

### RFC-034-T1 — shared schema + 配置字段

- `packages/shared/src/schemas/config.ts`：新增 `gitRecurseSubmodules` / `gitSubmoduleJobs` 字段 + `DEFAULT_CONFIG` 同步
- `packages/shared/src/schemas/cachedRepo.ts`：`CachedRepoSchema` 新增 `hasSubmodules` / `lastSubmoduleSyncOk` / `lastSubmoduleSyncError` 三个 nullable 字段
- `packages/shared/src/index.ts` 若需导出新符号则补
- 测试：`config-rfc034.test.ts`（6 case enum / 越界 / partial） + `cached-repo-schema-rfc034.test.ts`（4 case nullable serialize/parse）
- 依赖：—
- 大小：S

### RFC-034-T2 — DB schema + migration 0017

- `packages/backend/src/db/schema.ts` `cachedRepos` 表追加 3 列（boolean mode）
- migration `0017_rfc034_cached_repos_submodules.sql` + `0017_snapshot.json` + `_journal.json` idx 跟进
- commit 前 grep `packages/backend/drizzle/` 核一次未占编号；如冲突按 RFC-024/030 让号惯例递增
- 测试：`migration-0017-cached-repos-submodules.test.ts`（fresh DB + 老 DB upgrade 两路径，包括 SELECT 老 cached_repos 行三列均 NULL）
- 依赖：T1
- 大小：S

### RFC-034-T3 — `services/gitVersion.ts` 版本能力探测

- `detectGitCapabilities()` 解析 `git --version` → `{ version, supportsSubmoduleJobs, supportsRecurseInWorktree }`
- 模块级缓存（首次调用初始化），`getCachedGitCapabilities()` 仅读不写
- daemon 启动序列（`server.ts` 或 init 钩子）调一次 `detectGitCapabilities`
- 测试：`git-version-caps.test.ts`（解析 `git version 2.39.3 (Apple ...)` / `git version 2.4.0` / 解析失败三种 fixture → 三 capabilities 字段，~5 case）
- 依赖：—
- 大小：S

### RFC-034-T4 — `services/gitSubmodule.ts` 核心

- `syncSubmodules(repoPath, opts)` / `detectSubmodules(repoPath)` 两入口
- mode='never' short-circuit；mode='auto' 探测 `.gitmodules`；mode='always' 强制
- 全部 stderr 过 `redactStderr ?? redactGitUrl`
- 命令行：`submodule sync --recursive`、`submodule update --init --recursive --jobs <N>`（jobs 由 caller 按 caps 钳到 1 或 N）
- 测试：`git-submodule.test.ts`（mode 三分支 × hasGitmodules 两态 + stderr 脱敏锚，~8 case，spy 上 runGit 验命令行）+ `redact-stderr-rfc034.test.ts`（grep 兜底）
- 依赖：T1
- 大小：M

### RFC-034-T5 — `services/gitRepoCache.ts` cold/warm 改造

- cold path（`:228`）：`['clone']` 后按 effectiveMode 追加 `--recurse-submodules --jobs N`；clone 成功后调 `detectSubmodules` 写 `has_submodules`
- warm fetch（`:198`）：fetch 后调 `syncSubmodules`，结果更新 cached_repos 三列；`submoduleSyncOk=false` 不回滚 `last_fetched_at`
- `refreshCachedRepo`（`:354`）：同 warm fetch 处理
- ResolveCachedRepoResult / RefreshCachedRepoResult 扩展 `submoduleSyncOk` / `submoduleSyncError` / `hasSubmodules` 三字段
- 配置读取：`gitRecurseSubmodules` / `gitSubmoduleJobs` 通过 deps 注入（caller 从 settings 读取并把 caps 钳到合法值后传入），保持模块纯度
- 测试：`git-repo-cache-submodule.test.ts`（~6 case：cold clone 命令行含 `--recurse-submodules` / warm fetch 后调 sync / mode=never 退化 / submodule sync 失败 fetchOk 仍 true / has_submodules 三态入 DB / 同 URL 并发只跑一次）+ `git-submodule-fixture.test.ts`（真 git 子进程 fixture，父+子两个 bare 仓，cold→worktree→refresh 全链路）
- 依赖：T1, T2, T3, T4
- 大小：M

### RFC-034-T6 — `util/git.ts createWorktree` 追加 submodule init

- `worktree add` 成功后调 `syncSubmodules`（mode/jobs 同样从 settings 读取，caps 钳值）
- `CreateWorktreeResult` 新增 `submoduleInitOk` / `submoduleInitError`
- 调用方 `services/task.ts`（path/url 模式都通过 startTask 走 createWorktree）零行为变化，仅在 `submoduleInitOk=false` 时 emitEvent
- 测试：`worktree-submodule-init.test.ts`（真 git fixture：父仓含 .gitmodules → worktree 子目录有文件；不含则跳过；mode=never 跳过 ~5 case）
- 依赖：T3, T4
- 大小：S-M

### RFC-034-T7 — event kind 扩展 + startTask emitEvent

- `packages/shared/src/schemas/nodeRunEvents.ts` `NODE_EVENT_KIND` 数组追加 `'submodule_init_failed'` + `'submodule_sync_failed'`（DB kind 是 TEXT 列，**无需** migration）
- `services/task.ts startTask`：worktree.submoduleInitOk=false 时 emitEvent，payload 含脱敏 stderr
- `services/gitRepoCache.ts` resolveCachedRepo 调用方：URL 模式 task 启动路径检测 `submoduleSyncOk=false` 同样 emitEvent
- 测试：`start-task-submodule-event.test.ts`（init 失败 → event 入库 + task 仍 done，~3 case）
- 依赖：T5, T6
- 大小：S

### RFC-034-T8 — HTTP 路由响应扩展

- `routes/cachedRepos.ts`：GET 列表 item 自动经 schema 序列化新字段；`POST /:id/refresh` 响应 body 扩展 `submoduleSyncOk` / `submoduleSyncError` / `hasSubmodules`
- 测试：`cached-repos-http-submodule.test.ts`（list 含新字段 + refresh 响应含新字段 + 老行 hasSubmodules=null 序列化兼容，~4 case）
- 依赖：T2, T5
- 大小：XS

### RFC-034-T9 — 前端 `<SubmoduleBadge />` + `/repos` 行渲染

- 新组件 `frontend/src/components/SubmoduleBadge.tsx`：四态（null / hasSubmodules=false / ok / error）渲染 + tooltip 含脱敏 stderr
- `routes/repos.tsx` 表格行注入 badge；refresh 响应回写 query cache 让 badge 翻转
- styles.css +`.submodule-badge{,--ok,--error,--unknown}` 系列
- 测试：`submodule-badge.test.tsx`（4 态 + tooltip ~5 case）+ `repos-page-submodule-row.test.tsx`（列表整合 + refresh 后翻转 ~3 case）
- 依赖：T8
- 大小：S

### RFC-034-T10 — Settings UI

- Settings 页 Git 区段（如 RFC-024 未建则新建）追加 `gitRecurseSubmodules` segmented + `gitSubmoduleJobs` number input
- i18n 中英各 +~6 key（label / description / segmented options / event kind 文案）
- 测试：`settings-git-submodule.test.tsx`（segmented + number 持久化 mutation ~4 case）+ `i18n-rfc034-keys.test.ts` 对称
- 依赖：T1
- 大小：S

### RFC-034-T11 — e2e

- `e2e/main.spec.ts` 新 test `RFC-034: launch task on parent repo with submodules`：
  - tmpdir 建父+子 bare 仓 fixture
  - launcher URL tab → 输入父仓 `file://` URL → Start
  - 等任务完成 → 任务详情 worktree diff 区域 → 断言子目录有内容
  - 进 /repos → 行展示 "含 submodule" badge → Refresh → badge 仍 ok
- 依赖：T5, T6, T9
- 大小：S

### RFC-034-T12 — STATE.md / plan.md 索引同步

- `design/plan.md` RFC 索引表追加 RFC-034 行（落档时同步登记 Draft，commit 时改为 In Progress / Done）
- `STATE.md` 顶部 "进行中 RFC" 追加 RFC-034；实施完工后改 Done 并迁入 "最近完成 RFC（已 push）"
- 依赖：—（与 T1 同 commit 即可；落档阶段先做 Draft 登记）
- 大小：XS

## PR 拆分建议

默认**单 PR**（12 个子任务 + 测试），命名 `feat(scope): RFC-034 auto-recurse submodules in cache/clone/worktree paths`。

仅当出现下列任一情况才拆：
- T5 cache 改造与 RFC-033 批量导入合并发生 `services/gitRepoCache.ts` 行冲突 → 把 T1–T8 backend 单 PR 先合，T9–T11 前端 + e2e 后置
- T6 worktree 改动引入 `util/git.ts` 行偏移让 RFC-027 / RFC-030 测试红 → 把 T6 单独后置 PR
- 任何单文件超 ~600 行 diff → 评估拆

## 验收清单

- [ ] shared/`bun test` 全绿（T1 + 已有）
- [ ] backend/`bun test` 全绿（T2–T8 + 已有），新增 ~30+ case
- [ ] frontend/`bun test` 全绿（T9–T10 + 已有），新增 ~12+ case
- [ ] `bun run typecheck && bun run format:check && bun run lint` 三连绿
- [ ] e2e Playwright 全绿（macOS + ubuntu，含 RFC-034 新 case）
- [ ] CI run（`gh run list -L 1`）通过后再标 Done
- [ ] 任意涉及子仓 URL 的日志 / event / API response / DB serialize 输出**人工肉眼**抽样检查 redact 生效
- [ ] mode=never 全链路回归测试通过（行为字节级等同于 RFC-024 + 现 worktree）
- [ ] STATE.md 顶部 "进行中 RFC" 标记移除、"最近完成 RFC" 表新增 RFC-034 行
- [ ] migration 编号实际取值经 commit 前最后一次 grep 核对（与 RFC-029 / RFC-030 / RFC-033 不冲突）
