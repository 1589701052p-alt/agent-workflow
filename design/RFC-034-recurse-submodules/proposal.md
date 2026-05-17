# RFC-034 自动递归克隆 / 同步 Git submodule

> 状态：Draft
> 关联：RFC-024（`services/gitRepoCache.ts` cold clone + warm fetch + `refreshCachedRepo` + `cached_repos` 表）；RFC-033（批量导入 `/repos` 复用 `resolveCachedRepo`，会自动继承本 RFC 行为）；`packages/backend/src/util/git.ts createWorktree`；不与并发热区 `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts` 冲突。

## 背景

RFC-024 落地的远端 Git URL 克隆链路只跑裸 `git clone <url> <dir>`（`packages/backend/src/services/gitRepoCache.ts:228`），warm fetch 路径只跑 `git fetch --all --prune --tags`（同文件 `:198` / `refreshCachedRepo` `:354`）。任务派发用的 `createWorktree`（`packages/backend/src/util/git.ts:168-175`）也只跑 `git worktree add`，**没有任何 submodule 处理**。

结果是：

- 用户在 `/repos` 或 launcher 起一个含 `.gitmodules` 的远端仓 → 缓存目录里 submodule 子目录为空壳（gitlink 占位 + 空 working dir）
- worktree 派发出去后，agent 在 worktree 里看到的是同样的空壳——`agent` 视角里 `cat <submodule>/<file>` 全部 ENOENT，而它从 git 命令角度判定父仓状态又会把 submodule 标记为 "dirty: not initialized"
- 后续 audit / fix workflow 对 submodule 内容的引用全部失败；diff 快照里也只能看到父仓 gitlink SHA 的变化，没有子仓内部变动
- RFC-033 即将上线的批量导入会把这个问题放大：用户一次导入 10 个仓，9 个含 submodule，全部要靠用户事后手动 `git submodule update --init --recursive`

我们需要让框架在克隆 / 同步 / 派发的所有路径上**自动检测到 submodule 就递归处理**，让"在远端仓上起任务"这条 RFC-024 + RFC-033 主路径在含 submodule 的仓上也能开箱即用。

## 目标

- **cold clone**：`resolveCachedRepo` cold path 由 `git clone <url> <dir>` 升级为 `git clone --recurse-submodules --jobs <N> <url> <dir>`，N 由新 settings `gitSubmoduleJobs`（默认 4）控制；克隆失败语义不变（`repo-clone-failed`），但 stderr 可能包含子模块 URL，沿用 RFC-024 `redactGitUrl` 脱敏管道
- **warm fetch（reuse 路径 + manual refresh）**：`git fetch --all --prune --tags` 之后追加 `git submodule sync --recursive` + `git submodule update --init --recursive --jobs <N>`，把父仓最新 gitlink 指针同步到子仓 working dir
- **worktree 派发**：`createWorktree` 在 `git worktree add` 成功后，**如果父仓根存在 `.gitmodules`** 则在新 worktree 里跑 `git -C <worktree> submodule update --init --recursive --jobs <N>`，否则跳过
- **检测开关**：新 settings `gitRecurseSubmodules: 'auto' | 'always' | 'never'`，默认 `'auto'`：检测父仓根有 `.gitmodules` 才递归；`'always'` 强制递归（即便没 `.gitmodules` 也调一次 `submodule update`，幂等）；`'never'` 全链路退化为 RFC-024 现状（用于排查异常 / 用户私有协议跑不通时的逃生开关）
- **失败处理（warning，不致命）**：cold clone 阶段 `--recurse-submodules` 本身失败 → 沿用 `repo-clone-failed`（致命，与 RFC-024 一致，防止半成品入 DB）；但 warm fetch / refresh / worktree 阶段的 `submodule update` 失败 **不**致命：写 warning 日志 + 走新事件标 `[rfc034/submodule-sync-failed]`（task 仍继续），DB `cached_repos` 仍标记 `last_fetched_at` 更新成功，前端在 `/repos` 行上展示一个 warning 小圆点 + tooltip 给出脱敏 stderr
- **diff 行为说明（v1 不动）**：父仓 `gitDiffSnapshot` 继续基于 worktree + `fromCommit` 出 unified diff——这会捕获 gitlink SHA 改动，但**不捕获 submodule 内部未提交改动**；文档明示这是 v1 已知限制
- **provenance**：`cached_repos` 表新增可空列 `has_submodules INTEGER`（0/1，由 cold clone / refresh 后探测 `.gitmodules` 写入），`/repos` 列表行旁加 "含 submodule" 小标签

## 非目标

- **不**在 worktree 内的子仓再次跑 `git clone`：复用 git 自己的 submodule 机制，由它从父仓 `.git/modules/<name>` 复制 / 链接对象库
- **不**处理 submodule 自定义 credential：子仓 URL 走父仓 git 进程的 credential helper / SSH agent，**与 RFC-024 对父仓的处理完全对齐**——HTTPS 私有子仓需要用户的 git 配置里已经写好 `credential.helper`，框架不存 token、不替子仓注入 user:pass
- **不**给子仓 URL 做 redact 之外的额外脱敏：复用 `redactGitUrl`（RFC-024 落地的 shared 纯函数）
- **不**支持 `--depth` / `--shallow-submodules`：v1 一律完整克隆，与 RFC-024 §"不做 partial / blobless / shallow clone" 对齐
- **不**做 submodule 级 webhook / 自动 fetch：与 RFC-024 现状一致，submodule 同步只在 cold clone / warm fetch / worktree 创建三个点位触发
- **不**单独 GC：cache 删除（`deleteCachedRepo`）走 `rm -rf` 缓存根目录，submodule 数据连带删除，与 RFC-024 已有逻辑一致，无新增 GC 入口
- **不**在 v1 引入"submodule 内部未提交改动"到 `gitDiffSnapshot`：留到后续 RFC（如确实有需求）
- **不**做 per-repo override（"这个仓递归，那个仓不递归"）：v1 仅全局 settings；进阶用户可手动调 settings 临时 never 处理特例
- **不**改 `recent_repos` 语义：path 模式（用户给本机绝对路径）的 `createWorktree` 也同样按本 RFC 走 submodule init，**因为它沿用同一个 `createWorktree` 函数**——这是顺带受益，不是单独目标
- **不**做 LFS / annex 等 submodule 之外的 nested 储存机制

## 用户故事

1. 用户在 `/workflows/$id/launch` URL 模式输入 `git@github.com:foo/parent-with-submodules.git` → Start
2. 后端 cold clone：`git clone --recurse-submodules --jobs 4 …`，30s 后落地，`cached_repos.has_submodules=1` 入库
3. 任务派发：`createWorktree` 后探测 `.gitmodules` 存在 → `git -C <worktree> submodule update --init --recursive --jobs 4`，worktree 里子目录已经有内容
4. agent 在 worktree 里 `cat sub/foo.ts` 能正常读到文件；做改动后父仓 diff 捕获 gitlink SHA 变化（如有）+ worktree 内非 submodule 部分的代码变化
5. 一周后用户在 `/repos` 点 Refresh：`git fetch …` + `git submodule sync --recursive` + `git submodule update --init --recursive --jobs 4`；submodule URL 改了的情况下 sync 把新 URL 写到 `.git/config`，update 再拉新对象；UI 显示 `last_fetched_at` 已更新
6. 失败场景：子仓鉴权失败（用户 SSH key 没有访问权限）→ refresh 流程显示 last_fetched_at 仍更新（父仓 fetch 成功），但行旁加 ⚠ 小圆点 + tooltip"submodule sync 失败：xxx (脱敏)"；起任务时同样写 event tag `[rfc034/submodule-sync-failed]`、`createWorktree` 不抛错，agent 在 worktree 里看到空子目录（与不开 RFC-034 之前的现状一致，但用户在 UI 看到明确告警）

## 验收标准

- `ConfigSchema` 新增两字段（详见 design.md）：`gitRecurseSubmodules: 'auto' | 'always' | 'never'`（默认 `'auto'`）、`gitSubmoduleJobs: number`（默认 4，正整数 ≤ 32）
- cold clone 在 `gitRecurseSubmodules !== 'never'` 时使用 `--recurse-submodules --jobs <N>`；`'never'` 时退化为 RFC-024 现状
- warm fetch / `refreshCachedRepo` 在 `gitRecurseSubmodules !== 'never'` 且父仓根存在 `.gitmodules`（或 setting=`'always'`）时追加 sync+update；失败仅 warning，**不**翻 `fetchOk=false`，新增 `submoduleSyncOk: boolean` + `submoduleSyncError: string | null` 字段（脱敏后）回传给路由层
- `createWorktree` 在同样条件下追加 worktree-内 submodule update；失败仅 warning，不抛错；新增 `submoduleInitOk: boolean` 字段（与 worktreePath / branch / baseCommit 并列）由 startTask 写入 event（不写 task 行）
- `cached_repos` 表新增 `has_submodules INTEGER`（0/1，nullable，老行 NULL 表示未探测）；新 migration 0017（与 RFC-029 0015 / RFC-030 0016 让号，确认 commit 时取下一个未占编号）
- 任何 submodule 阶段产生的 git stderr 写日志 / 事件 / API 响应前必须穿过 `redactGitUrl`；新增 grep 兜底测试锁 `services/gitSubmodule.ts` / `gitRepoCache.ts` 改动行 + `util/git.ts createWorktree` 改动行没有裸 stderr 注入
- `/repos` 列表行：`has_submodules=1` 时展示 "含 submodule" 标签；最近一次同步 submodule 失败的行展示 ⚠ + tooltip（脱敏 stderr）
- e2e fixture：构造一个 bare 父仓 + bare 子仓的本地 file:// 链路，确保 cold clone → worktree 派发 → refresh 三阶段都能让子仓 working dir 含文件
- `gitRecurseSubmodules='never'` 时全链路行为与 RFC-024 字节级一致（回归保护）
- 现有 path 模式启动表单 + path 模式 task 启动流程在含 `.gitmodules` 的本地仓上同样 worktree 阶段自动 init（顺带受益）；测试覆盖
- `bun run typecheck && bun run test && bun run format:check` 三连绿；e2e Playwright 9+ 新 case 全绿

## 与现有模块的关系

- `services/gitRepoCache.ts`：cold clone 命令行加 `--recurse-submodules --jobs N`；warm fetch / refreshCachedRepo 追加 sync+update 调用；ResolveCachedRepoResult / RefreshCachedRepoResult 新增 `submoduleSyncOk` / `submoduleSyncError` 字段；其它 API 表面零变化
- `util/git.ts createWorktree`：返回值新增 `submoduleInitOk: boolean`；调用方（`services/task.ts`、worktree-files / RFC-021 worktree diff 区域）零改动（新字段可选 / 默认 true）
- `services/task.ts startTask`：把 submodule init 失败作为 event 落 `[rfc034/submodule-init-failed]`，不影响 task 状态；URL 模式 / path 模式同样
- `routes/cachedRepos.ts`：`POST /api/cached-repos/:id/refresh` 响应 body 新增 `submoduleSyncOk` / `submoduleSyncError`（与 `fetchOk` / `fetchError` 并列）；GET 列表行新增 `hasSubmodules` 字段
- `gitDiffSnapshot`（`util/git.ts:196`）：零改动；v1 文档明示限制
- RFC-033 批量导入：复用 `resolveCachedRepo`，**自动**继承本 RFC 行为；批次 row 状态新增可选 `submoduleSyncOk` 字段（沿用 cache resolve 结果），UI 行渲染时若失败展示 ⚠
- `services/scheduler.ts` / `services/runner.ts` / `services/review.ts` / `services/clarify.ts`：零改动
- `services/gc.ts`：零改动（删 cache dir 时 `rm -rf` 已经把 submodule 数据连带删除）

## 失败模式回顾

| 场景 | 处理 |
|------|------|
| `gitRecurseSubmodules='never'` 但 settings 写错 | zod 校验阻挡，回退到默认 `'auto'`，warning 入日志 |
| cold clone --recurse-submodules 失败（子仓鉴权 / host 不可达 / .gitmodules URL 拼错）| 与 RFC-024 一致：抛 `repo-clone-failed`，临时目录 `rm -rf`，cache 未入库；用户拿到脱敏 stderr |
| warm fetch 阶段 submodule sync 失败 | warning + `submoduleSyncOk=false`，父仓 fetch 仍记 `last_fetched_at`；事件 `[rfc034/submodule-sync-failed]`；UI ⚠ 标 |
| worktree-内 submodule update 失败 | warning + `submoduleInitOk=false`，worktree 创建成功，task 继续；事件 `[rfc034/submodule-init-failed]`；worktree 里子目录是空壳 |
| 同 worktree 并发 init（同 task 不会，多 task 共享父 cache 但 worktree 路径互不相同）| 每个 task 自己的 worktree 独立 submodule 工作目录；git 自动隔离，但同父 cache 的 `.git/modules/<sub>` 对象库共享——并发 fetch 通过 git 自身锁串行化；万一锁失败回 warning |
| 用户 git 版本低于 2.13（最早稳定支持 `--jobs` 的版本）| 启动 daemon 时 `git --version` 探测，<2.13 时把 `gitSubmoduleJobs` 强制视为 1（不传 `--jobs`），warning 入日志；CLAUDE.md `STATE.md` 不写死最低版本，仅文档提及 |
| 用户 git 版本低于 2.5（早期 worktree + submodule 联动有 bug）| daemon 启动时 `git --version` 探测，<2.5 时把 `gitRecurseSubmodules` 强制视为 `'never'`，warning 入日志（兜底） |
| 子仓 URL 含 `user:pass@`（少见但合法）| 沿用 RFC-024 `redactGitUrl` 全链路脱敏；DB 不存子仓 URL（只存父仓 URL） |
| `.gitmodules` 损坏 / 非法 URL | git 自身报错 → 走 sync/update 失败分支（warning，不致命） |
| 用户在父仓 worktree 里手工 `rm -rf <submodule-dir>` | 下次任务起新 worktree 时 init 重新落盘；不需特殊处理 |
| settings 切换 `auto → never`（或反过来）| 现有 cache 不重处理；下次 cold / refresh / worktree 时按新值生效 |
| 子仓也是含 submodule 的仓（嵌套 N 层）| `--recursive` 全部覆盖；`gitSubmoduleJobs` 全局适用 |
| Win / 非 macOS 平台 | 暂不官方支持（与项目当前 macOS + Linux 分发对齐）；CI 跑 ubuntu 验证 Linux 路径 |

## 多人协作

- 不与 in-flight RFC-029 / RFC-030 / RFC-032 / RFC-033 共享文件：本 RFC 的代码改动集中在 `services/gitRepoCache.ts` / `services/gitSubmodule.ts (新)` / `util/git.ts` / `routes/cachedRepos.ts` / `repos.tsx`；RFC-032 改 nav shell 不动数据层；RFC-033 改 `/repos` 顶部按钮 + batch 接口但走的是 `resolveCachedRepo` 同一入口（受益方），仅 i18n / styles.css 行可能交叠 → 改动严格按行号定位、追加而非替换
- migration 编号：当前 RFC-029 占 0015、RFC-030 占 0016；本 RFC 暂取 0017，**实际 commit 前再核一次未占编号**（CLAUDE.md 多人协作并发改动原则）
- `ConfigSchema` 改动：在 RFC-024 字段（`gitCloneTimeoutMs` / `gitFetchOnReuse`）紧邻位置追加；不动其它字段
