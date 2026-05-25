# RFC-068 — 技术设计

## 改动点速览

| 模块                                | 文件                                                     | 改动                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| URL 模式 fast-forward               | `packages/backend/src/services/gitRepoCache.ts`          | warm path 内新增 `fastForwardBranch()`；冷 clone 不需要                                                                         |
| Base ref 类型判别                   | `packages/backend/src/util/git.ts`                       | 新增 `classifyBaseRef(repoPath, base): 'branch' \| 'remote-tracking' \| 'tag' \| 'sha' \| 'unknown'`                            |
| startTask 串接                      | `packages/backend/src/services/task.ts`                  | `resolveRepoSource` 后追加 `syncBaseRefIfPossible()` hop（URL 模式自动；path 模式按 opt-in 开关）                               |
| Path 模式 opt-in fetch              | `packages/backend/src/services/repo.ts`（新增 helper）   | `fetchPathRepoBeforeLaunch(repoPath)`，仅跑 `git fetch --all --prune --tags`，永不 `pull` / `merge` / `checkout`                |
| StartTask schema                    | `packages/shared/src/schemas/task.ts`                    | 加 `fetchBeforeLaunch?: boolean`（默认 false）字段                                                                              |
| Launcher 前端                       | `packages/frontend/src/routes/tasks/launch.tsx` 等       | 路径模式下加一个 `<Switch>`「启动前 fetch 远端 ref」，URL 模式不显示（始终自动）                                                |
| WS / events                         | `packages/backend/src/services/task.ts`                  | 新增 `taskEvent.fetchWarn` 事件（fetch / FF 降级）便于任务详情显示                                                              |

零 DB schema / migration 改动；零 scheduler / runner / worktree
lifecycle 改动；零 frontend 路由 / 数据模型改动（只是表单加一个开关
field）。

## 数据流（URL 模式）

```
launcher POST /api/tasks
  → startTask(input, deps)
    → resolveRepoSource(input, deps)
        → resolveCachedRepo(...)                # cached_repos row + cacheDir
            ├─ cold:  git clone <url>           # 拉到 origin/<default>=最新
            └─ warm:  withUrlLock(hash):
                       git fetch --all --prune --tags
                       (NEW) for each baseBranch in {input.baseBranch ?? defaultBranch}:
                          syncBranchToRemote(cacheDir, baseBranch)   # FF
        → returns { repoPath: cacheDir, baseBranch, repoUrl }
    → materializeWorktree({ repoPath, baseBranch, ... })
        → createWorktree(...)
            → git rev-parse <baseBranch>        # 现在拿到 FF 之后的新 sha
            → git worktree add -b agent-workflow/{taskId} <wt> <baseCommit>
```

关键：FF 必须在 `withUrlLock(hash)` 内部执行，与 fetch 串联，保证：

1. 不和另一个并发同 URL task 的 fetch race。
2. baseCommit 解析与 FF 是原子序列对 caller 可见。

`rev-parse` 现在仍在 lock 外（`createWorktree` 没在 lock 内）——可接受，
因为：rev-parse 时如果另一个 task 又前进了 ref，结果只会"更新一点"，不
会破坏既有 worktree（worktree 物化时绑的是 commit object，ref 后续移动
不影响）。

## 模块详细设计

### `util/git.ts` 新增 `classifyBaseRef`

```ts
export type BaseRefKind = 'branch' | 'remote-tracking' | 'tag' | 'sha' | 'unknown'

export async function classifyBaseRef(repoPath: string, ref: string): Promise<BaseRefKind> {
  // refs/heads/<ref> 存在 → branch
  // refs/remotes/<ref> 存在 → remote-tracking（已经是远端跟踪，FF 无意义）
  // refs/tags/<ref> 存在 → tag
  // /^[0-9a-f]{4,40}$/i 命中且 rev-parse 成功 → sha
  // 否则 unknown（fallthrough，按 branch 试一把）
}
```

实现细节：先一次性 `git for-each-ref --format='%(refname)'
refs/heads/<ref> refs/remotes/<ref> refs/tags/<ref>`，根据 stdout 含哪
个前缀分类；sha 用 `git rev-parse --verify <ref>^{commit}` 兜底。整条
函数纯只读、零副作用。

### `services/gitRepoCache.ts` 新增 `syncBranchToRemote`

```ts
/**
 * Fast-forward refs/heads/<branch> to refs/remotes/origin/<branch> in a
 * mirror cache repo. Caller MUST hold withUrlLock(hash) for the cacheDir.
 *
 * Skips silently when:
 *   - origin/<branch> does not exist (branch is local-only — should not
 *     happen for mirrors but cheap to guard).
 *   - <branch> is already at or ahead of origin/<branch> (no-op).
 *
 * Returns { advanced, fromSha, toSha, warning } so callers can emit a
 * task event when interesting.
 *
 * Implementation: `git update-ref refs/heads/<branch> refs/remotes/origin/<branch>`.
 * Mirror's working tree is NEVER touched (we don't checkout) — that's
 * exactly the point: workers use worktrees, not the mirror's checkout.
 */
export async function syncBranchToRemote(
  cacheDir: string,
  branch: string,
): Promise<{ advanced: boolean; fromSha: string | null; toSha: string | null; warning: string | null }>
```

边界：
- branch 含 `/` 完全合法（如 `feature/foo`），透传即可，`update-ref` 接
  受嵌套 ref 名。
- branch 名是 `HEAD` / 空字符串 → caller 不该调用，但函数内有 guard 返
  回 noop。
- update-ref 失败（divergence、permission、ref lock 抢占）→ 不抛，返回
  warning 字段，caller WARN 后继续。

### `services/task.ts` 串接

`resolveCachedRepo` 内部加 FF（warm path 内、URL lock 内）。`resolveRepoSource`
需要拿到 input.baseBranch（如果用户指定），传给 `resolveCachedRepo` 让
它知道要 FF 哪个 branch（默认是 cache 的 defaultBranch）。

伪代码：

```ts
async function resolveRepoSource(input, deps) {
  if (input.repoPath) {
    // path mode
    if (input.fetchBeforeLaunch === true) {
      await fetchPathRepoBeforeLaunch(input.repoPath)  // 失败 → WARN，不抛
    }
    return { repoPath: input.repoPath, baseBranch: input.baseBranch, repoUrl: null }
  }
  // URL mode
  const resolved = await resolveCachedRepo(
    { db: deps.db, appHome, syncBranches: [input.ref].filter(Boolean) },
    { url: input.repoUrl }
  )
  const baseBranch = input.ref ?? resolved.cached.defaultBranch ?? undefined
  return { repoPath: resolved.cached.localPath, baseBranch, repoUrl: input.repoUrl }
}
```

`resolveCachedRepo` 接收 `syncBranches?: string[]` 选项；warm path 内
fetch 完后对每个 branch 调 `classifyBaseRef` + `syncBranchToRemote`：

```ts
for (const ref of opts.syncBranches ?? [defaultBr]) {
  const kind = await classifyBaseRef(cacheDir, ref)
  if (kind !== 'branch' && kind !== 'unknown') continue  // tag/sha/remote-tracking 跳过
  const res = await syncBranchToRemote(cacheDir, ref)
  if (res.warning !== null) {
    log.warn('rfc068/ff-failed', { url: redacted, branch: ref, warning: res.warning })
    // 收集到 ResolveCachedRepoResult.ffWarnings 透传给 startTask
  }
}
```

### Path 模式 `fetchPathRepoBeforeLaunch`

新建薄包装：

```ts
export async function fetchPathRepoBeforeLaunch(repoPath: string): Promise<{
  ok: boolean
  error: string | null
}> {
  const r = await runGit(repoPath, ['fetch', '--all', '--prune', '--tags'])
  if (r.exitCode !== 0) return { ok: false, error: r.stderr.trim() || 'git fetch failed' }
  return { ok: true, error: null }
}
```

要点：
- 永远不跑 `pull` / `merge` / `checkout`。
- 失败不抛——caller 决定 WARN + 继续还是直接 fail。`resolveRepoSource`
  内部按 WARN + 继续处理（任务能起，base ref 还是用户当前 branch）。
- 与 `nonInteractiveGitEnv()` 复用 `runGit`，避免 SSH 提示挂住 daemon。

### StartTask schema 扩展

`packages/shared/src/schemas/task.ts`：

```ts
export const StartTaskSchema = z.object({
  // ... 既有字段 ...
  fetchBeforeLaunch: z.boolean().optional(),  // RFC-068: path 模式 opt-in
})
```

URL 模式忽略此字段（自动 FF）。Path 模式：true → fetch + WARN-on-fail；
false / undefined → 不 fetch。

### Launcher 前端

`packages/frontend/src/routes/tasks/launch.tsx`（或多仓 RFC-066 落地后
的 `RepoSourceRow`）：

- URL 模式行：无新 UI，标题旁加一个静态提示「启动前自动同步到远端最
  新」（i18n key `launcher.repo.urlAutoSync`）。
- Path 模式行：新增 `<Field>` 包 `<Switch>`「启动前 fetch 远端 ref（不
  会 pull / merge 当前 branch）」（i18n key `launcher.repo.pathFetch`），
  默认 off。
- 上次选择记到 localStorage 键 `agent-workflow.launcher.pathFetch`，下
  次默认带入。

公共组件遵守 CLAUDE.md「Frontend UI consistency」原则：使用现有
`<Field>` + `<Switch>` + `.segmented` / `.btn` 体系，不写新 CSS。

## 失败模式表

| 场景                              | 行为                                                                              | 任务状态 |
| --------------------------------- | --------------------------------------------------------------------------------- | -------- |
| URL fetch 网络失败                | WARN `rfc068/fetch-failed`；继续 FF 跳过；rev-parse 用 fetch 前 ref                | running  |
| URL FF 因 divergence 失败         | WARN `rfc068/ff-failed`；caller 改用 `refs/remotes/origin/<branch>` 作为 base    | running  |
| URL FF 因 ref lock 抢占失败       | 同上                                                                              | running  |
| URL base = tag / sha              | 跳过 FF（classifyBaseRef 早返回）；rev-parse 原样                                 | running  |
| URL base = `origin/<branch>`      | 跳过 FF（已是 remote-tracking）；rev-parse 原样                                   | running  |
| Path opt-in fetch 网络失败        | WARN `rfc068/path-fetch-failed`；不抛；rev-parse 用用户当前 ref                    | running  |
| Path opt-in 关闭                  | 不 fetch；行为 = 今天                                                             | running  |
| 多仓任一仓 FF 失败                | 该仓 WARN；其他仓正常；整体任务能起                                               | running  |

所有降级路径都**不应**把 task 拍成 failed——base ref 不是最新仍是合法
任务，能跑就跑。

## 测试策略

### shared (≥ 4 case)

- `StartTaskSchema.fetchBeforeLaunch` 字段：true / false / undefined / 非
  bool 拒绝。

### backend (≥ 18 case)

`packages/backend/src/services/__tests__/gitRepoCache-ff.test.ts`：

- BC-01：mirror 冷 clone → 不触发 FF（clone 本就最新）。
- BC-02：mirror warm reuse + origin/main 推进 → FF 把 local main 推到
  origin/main；worktree baseCommit == origin/main 新 sha。
- BC-03：base = `origin/main` → 不调用 update-ref；baseCommit ==
  origin/main 新 sha。
- BC-04：base = `v1.0`（tag）→ 不 FF；baseCommit == tag sha。
- BC-05：base = `a1b2c3d`（sha）→ 不 FF；baseCommit == 那个 sha。
- BC-06：base = `feature/branch-with-slash` → FF 正常工作（含 `/` ref 名）。
- BC-07：fetch 失败（mock 不可达）→ resolve 返回 fetchOk=false；下游
  baseCommit 用 fetch 前 ref；任务能起。
- BC-08：FF 失败（mock divergence：手 commit 到 local main）→ ffWarnings
  非空；下游 baseCommit = origin/<branch>；任务能起。
- BC-09：并发同 URL 两 task → 第二个等 URL lock，FF 串行；两 task
  baseCommit 都 ≥ fetch 前 ref。
- BC-10：mirror 没有 origin remote（手删 remote）→ FF skip + WARN。

`packages/backend/src/services/__tests__/task-fetch-before-launch.test.ts`：

- BP-01：path 模式 + `fetchBeforeLaunch=true` + 远端可达 → 调用 fetch
  一次；用户当前 branch ref **不变**；工作目录文件未被 checkout / reset。
- BP-02：path 模式 + `fetchBeforeLaunch=true` + 远端不可达 → fetch 失
  败 WARN；任务能起；用户 ref / 工作目录不变。
- BP-03：path 模式 + `fetchBeforeLaunch=false`（默认）→ 不调用 fetch；
  行为字节级守恒（与今天对比）。
- BP-04：URL 模式 ignore `fetchBeforeLaunch` 字段（即便用户 body 里传
  了也不影响行为，仍按 URL 模式自动 FF）。
- BP-05 ~ BP-08：源代码层文本断言（保护回归）：
  - `git pull` / `git merge` / `git reset --hard` 不出现在
    `fetchPathRepoBeforeLaunch` 实现中。
  - `git checkout` 不出现在 `syncBranchToRemote` 实现中。
- BP-09：FF + submodule init 顺序：FF 完后 worktree add → submodule
  init 跑在新 baseCommit 上（RFC-034 既有套件不退化）。

### frontend (≥ 8 case)

`packages/frontend/src/routes/tasks/__tests__/launch-path-fetch.test.tsx`：

- BF-01：URL 模式不显示 path-fetch 开关。
- BF-02：path 模式显示 `<Switch>`，默认 off。
- BF-03：toggle on → localStorage 写入；reload 默认带入 on。
- BF-04：submit 时 `fetchBeforeLaunch` 字段进 body。
- BF-05：URL 模式 base ref picker 上显示 `origin/<branch>` 选项（remote-
  tracking 已经在那）；ref dropdown 顺序不变。
- BF-06：任务详情页 fetch/FF warning 事件显示（小图标 + tooltip）。
- BF-07：i18n cn/en 两套 key 都注册。
- BF-08：测试公共组件 props（`<Switch>` 复用、不新写 CSS）。

### e2e (1 scenario)

`packages/frontend/tests/e2e/rfc068-base-branch-sync.spec.ts`：

- 启动一个 mock-remote URL 任务 → 用一个独立 fixture 模拟"远端 push
  新 commit" → 第二次启动同 URL task → 验证新 task 的 worktree files
  tab 里看到新 commit 内容。

## 与 opencode 的交互

无。FF / fetch 是平台与 git 之间的事，不经过 opencode 子进程；opencode
启动时 cwd 已经是 worktree 路径，只看到 worktree 物化出的文件。

依然遵循 CLAUDE.md「opencode 源码自取规则」——本 RFC 不涉及 opencode
行为假设，因此不需要核 opencode 源码；如未来在此基础上再加任何"启动后
对 worktree 做 git 操作"才需要回头看。

## 与既有 / 进行中 RFC 的交互

- **RFC-024**：本 RFC 在 `resolveCachedRepo` 内 warm path 加 FF；冷 clone
  不动。`gitRepoCache.ts` 函数签名向后兼容（新增 optional `syncBranches`
  字段）。
- **RFC-034**：FF 改变了 baseCommit，submodule init 跑在新 commit 上是
  期望行为。submodule init 失败的既有 WARN 路径不变。
- **RFC-066**：多仓启动时把 `resolveRepoSource` 的 FF 逻辑搬到 per-repo
  loop。本 RFC 不依赖 RFC-066；RFC-066 落地后小幅调整 wiring。
- **RFC-067**：无交互。

## 监控 / 可观察性

新增日志通道：

- `log.warn('rfc068/fetch-failed', { url: <redacted>, stderr })`
- `log.warn('rfc068/ff-failed', { url: <redacted>, branch, warning })`
- `log.warn('rfc068/path-fetch-failed', { repoPath, stderr })`
- `log.info('rfc068/ff-advanced', { url: <redacted>, branch, fromSha, toSha })`

任务详情页新增展示位（小 chip + tooltip）：FF 推进时显示 `synced to
origin/<branch>`；FF 失败时显示 `using stale base (fetch/FF warn)`。

## 回滚 / 风险

- **回滚**：单 PR 实现，回滚直接 revert 即可。worktree 物化逻辑无变化
  （仍是 `git worktree add ... <baseCommit>`），仅 baseCommit 的取值改
  变；revert 后 baseCommit 回退到原行为。
- **风险**：
  - URL 模式 FF 改变了"默认 base sha"，已有依赖"启动时 base = clone 时
    版本"的工作流会感知到差异。属于产品行为变更，本 RFC 即文档化此变
    更。
  - Path opt-in 是新功能，不勾不影响任何既有行为。
  - mirror 的"工作目录与本地 main 不同步"理论上一直就是这样（mirror 工
    作目录运行时不用），FF 后差距更明显，需要 doctor / debug 时知道这
    点（写进 STATE.md 备忘）。
