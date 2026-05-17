# RFC-034 技术设计

> 配套 `proposal.md`。与 `design/design.md` 冲突时，本文件就 RFC-034 引入的接口、数据流、错误码具有最终解释权；其它部分仍以 `design/design.md` 为准。

## 1. Shared schema 改动（`packages/shared/src/`）

### 1.1 `schemas/config.ts`

在 RFC-024 字段 `gitCloneTimeoutMs` / `gitFetchOnReuse` 紧邻位置追加两行：

```ts
  // --- RFC-034 git submodule recursion ---
  /**
   * Behavior when cold-cloning, warm-fetching, or worktree-launching a repo
   * that may contain `.gitmodules`.
   * - `'auto'` (default): detect `.gitmodules` and recurse only when present
   * - `'always'`: always run `submodule update --init --recursive` (idempotent
   *   no-op for repos without `.gitmodules`)
   * - `'never'`: fully disabled; equivalent to pre-RFC-034 behavior
   */
  gitRecurseSubmodules: z.enum(['auto', 'always', 'never']).optional(),
  /**
   * `--jobs <N>` for recursive clone / submodule update. Default 4. Clamped to
   * 1 when daemon detects git version < 2.13 at startup. Max 32.
   */
  gitSubmoduleJobs: z.number().int().min(1).max(32).optional(),
```

`DEFAULT_CONFIG` 同步 `gitRecurseSubmodules: 'auto'` / `gitSubmoduleJobs: 4`。`ConfigPatchSchema` 复用 `.partial()` 自动覆盖。

### 1.2 `schemas/cachedRepo.ts`

`CachedRepoSchema` 新增可空字段：

```ts
  hasSubmodules: z.boolean().nullable(),     // null = 未探测；老行落库时是 null
  lastSubmoduleSyncOk: z.boolean().nullable(),   // 最后一次 sync/update 是否成功；null=从未跑
  lastSubmoduleSyncError: z.string().nullable(), // 脱敏后的 stderr；成功时 null
```

### 1.3 `schemas/task.ts`

`StartTaskSchema` 不动。worktree 元数据走 event，不进 `tasks` 行。

### 1.4 新文件 `packages/shared/tests/config-rfc034.test.ts`

锁三个新字段的 zod 行为（含越界值、enum 反例、partial 路径）。

## 2. DB 改动（`packages/backend/src/db/schema.ts` + migration 0017）

> 编号实际 commit 前再核一次未占（CLAUDE.md 多人协作）。

```sql
ALTER TABLE cached_repos ADD COLUMN has_submodules INTEGER;             -- 0 / 1 / NULL
ALTER TABLE cached_repos ADD COLUMN last_submodule_sync_ok INTEGER;     -- 0 / 1 / NULL
ALTER TABLE cached_repos ADD COLUMN last_submodule_sync_error TEXT;     -- 脱敏 stderr 或 NULL
```

drizzle 字段类型与 zod schema 对齐（boolean 用 `integer({ mode: 'boolean' })`）。

迁移：`0017_rfc034_cached_repos_submodules.sql` + `0017_snapshot.json` + `_journal.json` idx 跟进。

老 cache 行落库时三列均 NULL；首次 refresh 后写入实际值。

## 3. 新模块 `services/gitSubmodule.ts`

纯函数 + 一个高层入口，所有 submodule 相关 git 调用都走这里，避免散在 cache / worktree 两处。

```ts
export interface SubmoduleSyncResult {
  ok: boolean
  error: string | null      // 已脱敏
  hasGitmodules: boolean    // 探测结果（caller 用来写 has_submodules 列）
}

export interface SubmoduleSyncOptions {
  mode: 'auto' | 'always' | 'never'
  jobs: number
  /** 外层传入的脱敏函数（默认 redactGitUrl）。 */
  redactStderr?: (s: string) => string
  /** Git command, for test injection. Default 'git'. */
  gitCmd?: string
}

/**
 * Idempotent. Behavior:
 * - mode='never' → returns { ok: true, error: null, hasGitmodules: false } without running git
 * - mode='auto'  → probe `<repoPath>/.gitmodules`; if missing, returns { ok: true, ..., hasGitmodules: false }
 * - mode='always' or mode='auto' with .gitmodules present → run sync + update
 *
 * Sync + update is a single best-effort call:
 *   git -C <repoPath> submodule sync --recursive
 *   git -C <repoPath> submodule update --init --recursive --jobs <N>
 * stderr from either step is concatenated, redacted, and surfaced as `error`.
 * No throws; failure is reported via `ok: false`.
 */
export async function syncSubmodules(
  repoPath: string,
  opts: SubmoduleSyncOptions,
): Promise<SubmoduleSyncResult>

/**
 * Probe-only — does NOT mutate the repo. Used by:
 * - resolveCachedRepo cold path right after `git clone` (clone already recursed,
 *   we only need to record has_submodules)
 * - refreshCachedRepo when mode='never' to keep the column accurate
 */
export async function detectSubmodules(repoPath: string): Promise<boolean>
```

实现要点：

- 用 `runGit` 包装；超时不另设，靠外层 `gitCloneTimeoutMs` 兜底（per-call 单独超时复杂度高、回报低）
- 全部 stderr 在返回前过 `redactStderr ?? redactGitUrl`
- 探测 `.gitmodules`：`statSync(join(repoPath, '.gitmodules'))`（同步，纯本地 FS）；任意异常视为不存在
- 命令行：`['submodule', 'sync', '--recursive']`、`['submodule', 'update', '--init', '--recursive', '--jobs', String(jobs)]`
- 若 daemon 启动时探测 git 版本 < 2.13 → 由 caller 把 jobs 强制为 1（不在本模块内重复探测，让上层缓存版本信息）
- never 模式 short-circuit：直接 `return { ok: true, error: null, hasGitmodules: false }`，不调用 git 也不探测 FS（用于排查路径）

## 4. `services/gitVersion.ts` 新模块（兜底）

> 单文件，<60 行。daemon 启动时 lazy 探测，结果缓存到内存。

```ts
export interface GitCapabilities {
  version: { major: number; minor: number; patch: number; raw: string } | null
  /** ≥ 2.13 才稳定支持 submodule --jobs */
  supportsSubmoduleJobs: boolean
  /** ≥ 2.5 才稳定支持 worktree + submodule 联动 */
  supportsRecurseInWorktree: boolean
}

export async function detectGitCapabilities(): Promise<GitCapabilities>
export function getCachedGitCapabilities(): GitCapabilities | null
```

服务初始化路径（`server.ts` 启动序列）跑一次 `detectGitCapabilities()` 写入模块级缓存；后续 `gitRepoCache` / `gitSubmodule` 用 `getCachedGitCapabilities()` 读。

测试：mock `runGit` 出 `git version 2.39.3 (Apple Git-145)` / `git version 2.4.0` / 解析失败三种返回，断言三 capabilities 字段。

## 5. `services/gitRepoCache.ts` 改动

### 5.1 ResolveCachedRepoResult / RefreshCachedRepoResult 字段扩展

```ts
export interface ResolveCachedRepoResult {
  cached: CachedRepo
  cold: boolean
  fetchOk: boolean
  fetchError: string | null
  defaultBranch: string | null
  // RFC-034:
  submoduleSyncOk: boolean
  submoduleSyncError: string | null
  hasSubmodules: boolean
}

export interface RefreshCachedRepoResult {
  fetchOk: boolean
  fetchError: string | null
  // RFC-034:
  submoduleSyncOk: boolean
  submoduleSyncError: string | null
  hasSubmodules: boolean
}
```

### 5.2 cold path（`:228`）改造

```ts
const caps = getCachedGitCapabilities()
const effectiveJobs = caps?.supportsSubmoduleJobs ? jobs : 1
const effectiveMode = caps?.supportsRecurseInWorktree ? mode : 'never'

const cloneArgs: string[] = ['clone']
if (effectiveMode !== 'never') {
  cloneArgs.push('--recurse-submodules', '--jobs', String(effectiveJobs))
}
cloneArgs.push(input.url, tmpDir)

const r = await spawnGit(cloneArgs)
```

cold clone 失败语义不变（`repo-clone-failed`，致命）。`--recurse-submodules` 失败被视为同一类失败——这是 RFC-024 既有契约的延续：cold 阶段必须干净落地，否则 cache 不入库。

cold clone 成功后 → `detectSubmodules(tmpDir)` 写 `has_submodules` 入 DB。**不**再额外跑 `syncSubmodules`：clone 命令本身已经递归了。

### 5.3 warm fetch（`:198`）+ refreshCachedRepo（`:354`）

```ts
if (fetchOnReuse) {
  const r = await runGit(row.localPath, ['fetch', '--all', '--prune', '--tags'])
  // ...既有逻辑...
}

const sub = await syncSubmodules(row.localPath, {
  mode: effectiveMode,
  jobs: effectiveJobs,
})
// 更新 DB：has_submodules / last_submodule_sync_ok / last_submodule_sync_error
deps.db.update(cachedRepos).set({
  hasSubmodules: sub.hasGitmodules,
  lastSubmoduleSyncOk: sub.ok,
  lastSubmoduleSyncError: sub.error,
}).where(eq(cachedRepos.id, row.id)).run()

return { ..., submoduleSyncOk: sub.ok, submoduleSyncError: sub.error, hasSubmodules: sub.hasGitmodules }
```

注意：`submoduleSyncOk=false` **不**回滚 `last_fetched_at`——父仓 fetch 仍然算成功；只有 submodule 阶段单独标记失败。

### 5.4 与 mutex 的关系

submodule sync 必须在 per-URL mutex 持有期内调用——避免同 URL 两个并发 resolve 同时 sync 撞 `.git/modules/<sub>` 锁。已有 `withUrlLock` 包住整段，无需额外锁。

## 6. `util/git.ts createWorktree` 改动

```ts
export interface CreateWorktreeResult {
  worktreePath: string
  branch: string
  baseCommit: string
  // RFC-034:
  submoduleInitOk: boolean
  submoduleInitError: string | null
}
```

在现有 `git worktree add` 成功之后追加：

```ts
const caps = getCachedGitCapabilities()
const mode = readConfigRecurseMode()    // 默认 'auto'
const jobs = caps?.supportsSubmoduleJobs ? readConfigJobs() : 1
const sub = await syncSubmodules(worktreePath, {
  mode: caps?.supportsRecurseInWorktree ? mode : 'never',
  jobs,
})
return {
  worktreePath, branch, baseCommit,
  submoduleInitOk: sub.ok,
  submoduleInitError: sub.error,
}
```

`readConfigRecurseMode` / `readConfigJobs` 通过 `services/config.ts` 现有读法获取（不直接读文件，由 server 启动期注入 settings 快照——参考 `gitFetchOnReuse` 的现有读法）。

## 7. `services/task.ts startTask` 改动

仅在 worktree 创建后追加 event 写入：

```ts
const wt = await createWorktree({...})
if (!wt.submoduleInitOk) {
  await emitEvent(deps, {
    taskId, kind: 'subagent_capture_failed' /* TODO 不要复用，新增 'submodule_init_failed' kind */,
    ...
  })
}
```

实际落地：在 `packages/shared/src/schemas/nodeRunEvents.ts` `NODE_EVENT_KIND` 数组追加 `'submodule_init_failed'` + `'submodule_sync_failed'` 两个 kind；migration 不需要（kind 是 TEXT 列）。

事件 payload 含脱敏 stderr，前端 RFC-027 SessionTab / RFC-021 详细信息 tab 都能渲染（沿用现有 event 渲染管道）。

## 8. HTTP 路由

### 8.1 `GET /api/cached-repos` 列表

response item 自动通过 `CachedRepoSchema` 序列化新字段 `hasSubmodules` / `lastSubmoduleSyncOk` / `lastSubmoduleSyncError`，前端按字段决定渲染。

### 8.2 `POST /api/cached-repos/:id/refresh` 响应扩展

```ts
{
  fetchOk: boolean,
  fetchError: string | null,
  submoduleSyncOk: boolean,
  submoduleSyncError: string | null,
  hasSubmodules: boolean,
}
```

前端 toast / UI 更新两段独立显示。

### 8.3 `POST /api/tasks` 与启动响应

不变。submodule 失败通过 event 推送 + 前端 SessionTab 渲染，不污染 task 启动的同步响应体。

## 9. 前端改动

### 9.1 `/repos` 列表（`routes/repos.tsx`）

每行新增展示：

```
github.com/foo/bar  含 submodule ⚠   ~/.agent-w...  3h 前   5   [Refresh] [Delete]
                    ↑ tooltip："最后一次 submodule 同步失败：xxx (脱敏)"
                    or ✅ "submodule 同步成功" 当 last_submodule_sync_ok=true
                    or no badge 当 hasSubmodules=false
                    or "未探测" 当 hasSubmodules=null
```

新 component `<SubmoduleBadge cached={item} />` 处理四态渲染：null / false / true(ok) / true(error)。

### 9.2 Settings 页

`Settings → Git` 区段（如果 RFC-024 没创建则新增一节）新增：

- `gitRecurseSubmodules` segmented `auto | always | never`
- `gitSubmoduleJobs` number input（1–32）

### 9.3 任务详情 / NodeDetailDrawer

`submodule_init_failed` / `submodule_sync_failed` 两 event kind 由 RFC-027 SessionTab 事件流统一渲染；本 RFC 不动 SessionTab，只在 i18n key 里追加文案：

- `events.kind.submoduleInitFailed`：`"Worktree submodule init 失败"`
- `events.kind.submoduleSyncFailed`：`"Submodule 同步失败"`

### 9.4 i18n

中英各 +~8 key（badge / settings label / event kind 文案 + refresh toast）。

## 10. 测试策略

### 10.1 Shared (`packages/shared/tests/`)

- `config-rfc034.test.ts`：3 字段 enum / 越界 / partial 行为 ~6 case
- `cached-repo-schema-rfc034.test.ts`：新 3 字段（含 null）serialize/parse ~4 case

### 10.2 Backend (`packages/backend/tests/`)

- `git-submodule.test.ts`：`syncSubmodules` 的 mode=auto/always/never 三分支 + has-`.gitmodules` / 无 `.gitmodules` 共 6+ case；stderr 脱敏锚（`https://user:tok@host/sub.git` → `https://***@host/sub.git`）
- `git-submodule-fixture.test.ts`：用真 git 子进程在 tmpdir 建一个 父仓 + 子仓 fixture，cold clone fixture URL（`file://...`）→ 断言 cache dir 里子仓有内容；refresh 后再断言；mode=never 时子仓为空壳
- `git-version-caps.test.ts`：mock `git --version` 出三种输出 → capabilities 字段
- `git-repo-cache-submodule.test.ts`：RFC-024 既有 cache test 上扩 ~6 case（cold + clone 命令行含 `--recurse-submodules` / warm fetch 后调 sync / mode=never 退化 / submodule sync 失败 fetchOk 仍 true / has_submodules 入 DB 三态）
- `worktree-submodule-init.test.ts`：mock createWorktree 路径 + 真 git fixture，断言 `.gitmodules` 存在 → submodule update 调用 + worktree 子目录有内容；不存在 → 跳过；mode=never → 跳过
- `start-task-submodule-event.test.ts`：submodule init 失败 → emit `submodule_init_failed` event，task 仍 done
- `cached-repos-http-submodule.test.ts`：list 含新字段、refresh 响应含新字段 ~4 case
- `redact-stderr-rfc034.test.ts`：源代码层 grep 兜底，确保 `services/gitSubmodule.ts` 所有 `result.stderr` 引用同函数内必有 `redactGitUrl` / `redactStderr` 调用

### 10.3 Frontend (`packages/frontend/tests/`)

- `submodule-badge.test.tsx`：4 态渲染（null / false / true-ok / true-error）+ tooltip 内容
- `repos-page-submodule-row.test.tsx`：列表行整合渲染、refresh 后 badge 状态翻转
- `settings-git-submodule.test.tsx`：segmented + number input + 持久化 mutation

### 10.4 e2e

- `main.spec.ts` 新 test `RFC-034: launch task on parent repo with submodules`：
  1. daemon 启动前 tmpdir 准备：bare 父仓 + bare 子仓 + 一个含 `.gitmodules` 的 working commit + clone 到 bare
  2. launcher → URL tab → 输入父仓 `file://` URL → Start
  3. 等任务完成 → 进任务详情 worktree diff → 断言 worktree 路径里子目录有文件
  4. 进 /repos → 行展示 "含 submodule" badge → Refresh → badge 保持 ok 态

## 11. 配置（settings.json）

新增字段：

```jsonc
{
  "gitRecurseSubmodules": "auto",  // "auto" | "always" | "never"
  "gitSubmoduleJobs": 4             // 1..32
}
```

通过 `ConfigSchema` 注册。

## 12. 安全 / 隐私

- 子仓 URL 经 `redactGitUrl` 在日志 / 事件 / API response 中脱敏；与 RFC-024 同一管道
- DB 仅存父仓 URL（已脱敏 / 原文按 RFC-024 §9 策略），子仓 URL **不**入 DB（仅在 `.gitmodules` 里，那是用户仓内容）
- submodule 鉴权失败 stderr 可能含用户 SSH 路径 / 提示语，脱敏后入事件
- mode=never 是逃生开关，用户怀疑 submodule 处理本身泄漏时一键关闭

## 13. 迁移序号 / 多人协作守则

- DB migration 编号取下一个未占（commit 前 grep `packages/backend/drizzle/` 核一次）；本文件按 0017 草拟
- 不改：`services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` / `services/skill*.ts` / `services/agentDeps.ts` / `services/upload.ts` / `services/gc.ts`
- `services/gitRepoCache.ts` 改动严格限于：cold clone 命令行 / warm fetch 后追加 syncSubmodules / refreshCachedRepo 同上 / Result 类型字段
- `util/git.ts` 改动严格限于：`createWorktree` 末尾追加 syncSubmodules + Result 字段；`gitDiffSnapshot` 完全不动
- `routes/cachedRepos.ts`：响应 body 字段新增 backward-compatible
- `repos.tsx`：行渲染新增 `<SubmoduleBadge />`，不动既有列宽 / 操作按钮
- `Settings`：在 RFC-024 已建的 Git 区段后追加（如 RFC-024 未建 Git 区段则新建一节，与其它现存 settings 区段同结构）

## 14. 后续可演进点（非本 RFC 范畴）

- per-repo submodule 策略（每个 cached_repo 独立 mode）
- shallow submodule clone / partial submodule clone
- submodule 内部未提交改动纳入 `gitDiffSnapshot`
- submodule URL 重写（用户自定义 mirror）
- LFS / annex 等其他 nested 储存机制
- `/repos` 行展开后展示子仓清单 + 各自 lastFetch 时间
