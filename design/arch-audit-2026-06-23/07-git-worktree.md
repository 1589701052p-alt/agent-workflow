# Git / worktree / 仓库管理 — 架构审计 (2026-06-23)

> 子系统 key=07-git-worktree｜审计视角：架构层 + 扩展性（非纯 bug 清单）
> 与既有审计交叉：scheduler-audit-2026-06-10（S-2/S-8/S-11/⑥-3）、dedup-audit-2026-06-13（#3/#12/#41/#44）。
> 凡与既有报告重叠者明确标注「已被 … 覆盖」，本报告把火力集中在它们没说的**架构归因 + 扩展性瓶颈**。

## 0. 健康度一句话

底层 git 原语（`util/git.ts`）是全仓最干净、注释最翔实、可测性最好的模块之一（单一 `runGit` 入口、纯函数化、fail-closed 回滚、ref 钉住），但**“worktree 生命周期”从来没有一个 owner**——创建散在 task.ts 三条分支、回滚散在 nodeRollback/scheduler/clarify/review/crossClarify 五处、清理散在 gc.ts 一处且对多仓恒失败——导致每加一个仓维度的新能力（多仓、worktree 浏览、commit&push）都要在 N 处补一遍，已经漏掉了多仓的清理与部分失败回收。

## 1. 当前架构与职责

`util/git.ts` 是唯一的 git CLI 适配层：所有 git 调用走 `runGit(cwd,args)`（无 cwd 的 clone 走 `gitRepoCache.spawnGit`），并导出 worktree 创建（`createWorktree`）、快照（`gitStashSnapshot` + `snapshotRefName` 钉 ref）、回滚（`rollbackToSnapshot`，RFC-098 fail-closed）、diff/changed-files、ref 分类（`classifyBaseRef`，RFC-068）等原语。服务层把这些原语**编排**成业务：`gitRepoCache.ts`（URL→本地 mirror，per-URL in-process mutex + 30min 超时）、`gitSubmodule.ts`/`gitVersion.ts`（RFC-034 子模块能力门控）、`commitPush.ts`+`commitPushRunner.ts`（RFC-075 自动提交推送，纯/执行分层）、`repo.ts`（path-mode fetch + launcher 下拉）、`repoBatchImport.ts`（RFC-033 批量克隆队列）、`orphans.ts`（daemon 重启 reap）、`gc.ts`（小时级 worktree 回收）。task.ts 的 `startTask`/`materializeWorktree` 是 worktree 的创建编排者，nodeRollback.ts 是回滚的（部分）收口者。

关键文件：`util/git.ts`、`util/lock.ts`、`util/safePath.ts`、`services/{gitRepoCache,gitSubmodule,gitVersion,commitPush,commitPushRunner,repo,repoBatchImport,orphans,gc,nodeRollback}.ts`、`services/task.ts`（worktree 创建编排）、`services/worktreeFiles.ts`（路径围栏第二份）。

---

## 2. 设计问题（Design）

**[GIT-01] worktree 生命周期没有单一 owner，是本子系统所有漂移的总根因** — 级别 P1｜类型 design/coupling｜
证据：创建散在 `services/task.ts:508`（单仓）`:577`（多仓 loop）`:469`（preCreated 上传流）三处；快照写入双轨 `services/scheduler.ts:1993`（单仓 `preSnapshot`）/`:2014`（多仓 `preSnapshotReposJson`）；回滚收口（部分）`services/nodeRollback.ts:76`，但还有 `clarify.ts:393`、`review.ts`（iterate/reject）、`crossClarify.ts:782` 三条 out-of-band 回滚点（scheduler-audit 附录⑩已点名）；清理只在 `services/gc.ts:73` 一处。｜影响：没有“一个 task 的全部 worktree 在哪、谁负责建/回滚/删”的统一抽象，每个仓维度新能力都要在创建 3 处 + 回滚 5 处 + 清理 1 处各补一遍，多仓 PR（RFC-066）就漏了清理（见 GIT-04）和部分失败回收（GIT-05），快照双轨曾导致 S-2（P0）。｜建议：抽 `WorktreeSet`（按 task 聚合 `{repoPath, worktreePath, dirName, branch, baseCommit}[]`）作为唯一句柄，create/snapshot/rollback/remove 都接受它，单仓即 length-1；scheduler 的双轨快照、5 处回滚、gc 的清理全部改成对 `WorktreeSet` 的机械遍历。这正是 scheduler-audit R3「首跑/恢复双轨」+ RFC-092 已起头（`rollbackNodeRunWorktrees`）但没收完的方向。

**[GIT-02] 多仓 commit&push 的目标分支用容器镜像列 `task.branch`，靠“恰好同名”侥幸正确** — 级别 P2｜类型 design/coupling｜
证据：`services/scheduler.ts:961` `const branch = task.branch`，循环里对每个 `repo of state.repos` 都用同一个 `branch` 推送（`:1044` `repoBranch: branch`）；而 `state.repos`（`:223`、`:269`）**只带 `{repoPath, worktreePath, worktreeDirName, baseBranch}`，没有 per-repo `branch`**。｜影响：今天隔离分支恒为 `agent-workflow/{taskId}`、working 分支恒为同一名作用到每仓，所以 `task.branch` 与每仓真实分支碰巧相等——**不是 bug，是抽象泄漏**：一旦未来支持 per-repo working branch（多仓里 A 仓用 main、B 仓用 dev）或 detached worktree，这里会把 A 的提交推到 B 的分支名上。`state.repos` 丢掉 `branch` 字段本身就是 GIT-01 缺统一句柄的征兆。｜建议：`state.repos` 补 `branch`（从 `task_repos.branch` 直接来，已经在表里），commit-push/快照/回滚全用 `repo.branch` 而非 `task.branch`。

**[GIT-03] `git` 命令普遍无超时、无 cancel-signal，唯一的 `withTimeout` 还会在超时时泄漏 url 锁** — 级别 P1｜类型 design/observability｜
证据：`util/git.ts:44` `runGit` 既不接 `AbortSignal` 也不设超时；仅 `gitRepoCache.ts:325` 的 clone/fetch 被 `withTimeout`（`:71`）包住，而 `withTimeout` 只 `Promise.race` reject，**不 kill 派生的 git 子进程**（`:82-85`）。更糟：`work = withUrlLock(hash, …clone…)`（`:325`），超时 reject 后内层 clone fn 仍 pending → `withUrlLock` 的 `release()`（`:62`）不执行 → **同 URL 的后续 launch 全部排在一个永不 resolve 的 slot 后面，直到那个孤儿 clone 在 OS 层真正结束**。path-mode RFC-068 fetch（`repo.ts:104`）、`worktree add`、submodule update、merge、push、`ls-remote`（working-branch 探测，`git.ts:473`）全无任何时限。｜影响：单 daemon（`util/lock.ts` flock 保证唯一实例，所以 in-process mutex 假设成立）下，一次卡死的网络 git 就能挂住 worktree 创建链路，任务级 cancel 也传不进去（`runGit` 收不到 signal，git 子进程继续写 worktree）。可观测性为零——没有“某 git 卡了多久”的任何指标。｜建议：`runGit` 增加可选 `{ timeoutMs, signal }`，超时/取消时 `proc.kill()`（先 TERM 后 KILL，复用 `util/process.ts` 的 `killStaleRunProcessTree` 形态）；`withTimeout` 改为超时即 kill 子进程，确保 `withUrlLock` 的 `finally` 一定跑到。

**[GIT-04] GC 对多仓任务恒失败泄漏、且完全无视 `task_repos`** — 级别 P1｜类型 design/impl-bug｜**已被 scheduler-audit ⑥-3 + `scheduler-audit-gap3-gc-terminal-statuses.test.ts` 覆盖**，此处补架构归因｜
证据：`services/gc.ts:73` `removeWorktree({ repoPath: t.repoPath, worktreePath: t.worktreePath })`——多仓时 `t.worktreePath` 是 `worktrees/multi/{taskId}` 这个普通 `mkdirSync` 的容器（`task.ts:566`），不是 `t.repoPath`（=repos[0] 源仓）的 worktree，`git -C repos[0] worktree remove 容器` 恒报错 → `:86` catch 计入 skipped → 容器 + N 个子仓 worktree + 它们钉的 snapshot ref（`deleteSnapshotRefs` 在 `:84`，多仓也只对 `t.repoPath` 删一次）**永久泄漏**。GC 从头到尾没 import `taskRepos`（`grep` 确认 `gc.ts` 零处引用 task_repos）。｜架构归因：这是 GIT-01 的直接后果——GC 写在 tasks 单行视图上，对“一个 task 有 N 个 worktree”这件事一无所知。｜建议：GC 候选改为 `JOIN task_repos`，逐子仓 `removeWorktree` + 逐子仓 `deleteSnapshotRefs(repo.repoPath, taskId)` + 最后 `rmSync` 容器 + `git worktree prune`（见 GIT-07）。归入 GIT-01 的 `WorktreeSet` 收口。

**[GIT-05] 多仓 launch 部分失败：已建子仓 worktree 无回滚清理，且 GC 也捞不回** — 级别 P2｜类型 design/impl-bug｜（GIT-04 的派生新角度，既有审计未单列）｜
证据：`services/task.ts:572-634` 多仓 materialize loop，第 i 个仓失败时 `:609` `break`，**前 i-1 个已成功的 `git worktree add` 留在磁盘**，无任何 `removeWorktree` 回收；随后 `:718` 把**部分** `materializedRepos` 写进 `task_repos`、task 标 `failed`（`:689`）。｜影响：叠加 GIT-04，这些既已落 task_repos 的子仓 worktree 永远不会被清（GC 无视 task_repos）。一次“第 3 个 URL 拼错”的多仓启动 = 2 个孤儿 worktree + 钉死的 snapshot ref 常驻 `~/.agent-workflow/worktrees/multi/`。无测试覆盖（grep `partial.*worktree` / `repo[i] failed` 在 tests 下零命中）。｜建议：多仓 materialize 用 try/在任何 `earlyError` 时遍历已建子仓 `removeWorktree` + `rmSync` 容器，再抛/落 failed 行（best-effort，错误降级为 warn）。

**[GIT-06] `deleteCachedRepo(force=1)` 会 rmSync 掉仍被活跃任务引用的 mirror，瞬间废掉那些任务的全部 worktree** — 级别 P2｜类型 design/impl-bug｜
证据：`services/gitRepoCache.ts:670` 仅当 `count>0 && !force` 才拦（抛 `CachedRepoHasReferencesError`）；`force=true`（HTTP 路由用户确认后翻，`:639-643`）直接 `rmSync(row.localPath,…)`（`:675`）。URL-mode 的任务 worktree 落在 `appHome/worktrees/{slug}/{taskId}`，其 `.git` 是**指回 `mirror/.git/worktrees/<id>` 的文件**（`util/git.ts:82-89` 注释亲述）。rmSync 整个 mirror = 抹掉所有这些 worktree 的 `.git` admin 数据 → `isGitWorkTree` 即刻为 false，那些任务的 diff/快照/回滚/resume 全废。｜影响：`force` 文案只说“N 个任务仍引用，确认删除”，没说“会让这 N 个任务的工作区当场报废且不可 resume”。｜建议：force 删除前先按 `task_repos.repo_path == mirror` 找出活跃（非 terminal）任务并二次拒绝，或先逐 worktree `removeWorktree` 再删 mirror，并把代价讲清。

---

## 3. 实现问题 / Bug（Impl）

**[GIT-07] 从不调用 `git worktree prune`：失败的 removeWorktree / force 删 mirror / 手工 rm 会在源仓 `.git/worktrees/` 留死 admin 条目** — 级别 P2｜类型 impl-bug｜
证据：全仓 `grep "worktree prune"` 在 src 下零命中（只有 odb prune 的 `fetch --prune` 与“gc-pruned”注释）。`removeWorktree`（`util/git.ts:960`）失败被 gc `:86` 吞掉后、GIT-05 的 break、GIT-06 的 force 删，都会在源仓留 `.git/worktrees/<id>` 死条目，长期累积会让 `git worktree add` 的 lock/列举变慢，且 `worktree add` 同名分支可能撞到死条目报 `already used by worktree`（`util/git.ts:427` 的误报来源之一）。｜影响：长期运行的 daemon 上源仓元数据膨胀 + 偶发 worktree-in-use 误报。｜建议：gc 一轮结束、以及 force 删 mirror 前，对相关源仓跑一次 `git worktree prune`。

**[GIT-08] commit&push：`git commit` 失败时把原始 `commit.stderr` 直接落日志（绕过 redact）** — 级别 P3｜类型 security/impl-bug｜
证据：`services/commitPushRunner.ts:243` `log.warn('git commit failed', { stderr: commit.stderr.trim() })`——同函数里 push/fetch/merge 的 stderr 都过了 `redactPushError`（`:249/:283/:311/:324`），唯独这一条 commit stderr 裸写。｜影响：commit stderr 含凭据概率低（commit 不联网），但 hook 脚本回显里可能带 token；属一致性破口。｜建议：统一过 redact。注：`redactPushError` 自身覆盖不全（漏 Bearer/token=/password=）已被 **dedup-audit #3/#18 `git-url-credential-redaction`** 覆盖，建议合并到那条用 `util/redact.ts` 的超集替换。

**[GIT-09] `worktreeFiles.ts` 路径围栏是第二份手抄，第三份（image-proxy 路由）已漂成安全缝** — 级别 P2｜类型 impl-bug/security｜**已被 dedup-audit #12/#44 `worktree-path-containment-check` 覆盖**｜
证据：`services/worktreeFiles.ts:28` `resolveInsideWorktree` 与 `util/safePath.ts:14` `safeJoin` 是同一套词法围栏的两份实现（worktreeFiles 版多了“容忍空 root”）；dedup-audit 点名第三份 `routes/worktree-files.ts:57` 漏了反斜杠拒绝 + realpath 符号链接逃逸检查 → 真实穿越缝。｜影响：worktree 文件浏览/下载（RFC-065/071）是面向用户的读盘面，第三份缺符号链接检查可读到 worktree 外。｜建议：按 dedup-audit §3.4 落 `safeJoinAllowRoot`，三处共用。

**[GIT-10] `git-spawn-capture` 样板抄了 4 份（runGit / spawnGit / doctor / …）** — 级别 P3｜类型 impl-bug/coupling｜**已被 dedup-audit #41 `git-spawn-capture-boilerplate` 覆盖**｜
证据：`util/git.ts:44` `runGit` 与 `gitRepoCache.ts:93` `spawnGit` 是同一段 `Bun.spawn`+三路 `Promise.all` 收集，仅差“有无固定 cwd”；`cli/doctor.ts` 还有一份。｜影响：将来给 git 加超时/signal（GIT-03）要在 4 处各改一遍。｜建议：`runGit` 把 cwd 变可选（无 cwd 即省去 `-C`），`spawnGit` 退化为调用它；超时/signal 一次加全。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[GIT-X1] 未来功能：per-repo 工作分支 / 多仓里每个仓不同 base 或不同 working branch**
- 根因：`state.repos`（scheduler.ts:223）与 `RollbackTarget.repos`（nodeRollback.ts:35）这两个“运行期仓视图”都**砍掉了 `branch`**，只有持久层 `task_repos.branch` 有；commit-push 用 `task.branch` 顶替（GIT-02）。
- 现在要加得碰：`scheduler.ts` 的 repos 投影（:269）、commit-push 循环（:961/:1044）、快照写入双轨（:1993/:2014 要按仓记 branch）、nodeRollback 的 target（:69）、可能还有 `templateMeta.repos`（:1009/:2359/:3657/:3914 四处都传 `state.repos`）。
- 目标形态：定义一个权威 `TaskRepo`（含 repoPath/worktreePath/dirName/branch/baseBranch/baseCommit），`runTask` 顶部加载一次（已有 repoRows，只是丢了字段），所有下游只读这一个数组；commit/快照/回滚一律 `repo.branch`。

**[GIT-X2] 未来功能：worktree 配额 / 磁盘水位 GC / 取消任务时立即回收 worktree**
- 根因：清理只活在 gc.ts 一处、且只认 `tasks` 单行、对多仓恒失败（GIT-04）；cancel/delete 任务路径完全不碰 worktree（grep 确认 routes/tasks.ts + lifecycle.ts 无 removeWorktree）。
- 现在要加得碰：gc.ts 重写成 join task_repos、新增 cancel 时的同步回收钩子、部分失败回收（task.ts:609）、force-delete-mirror 的连带回收（gitRepoCache.ts:675）——四个互不知情的点。
- 目标形态：一个 `worktreeLifecycle.ts` 提供 `removeTaskWorktrees(taskId)`（逐子仓 remove + 删容器 + 删 snapshot ref + prune），GC / cancel / 部分失败 / 配额清理全调它；磁盘水位策略只需在它之上加一个候选排序器。

**[GIT-X3] 未来功能：给所有 git 操作加超时 / 任务取消即停 / “git 卡住”可观测**
- 根因：`runGit` 不接 signal/timeout（GIT-03），且 git-spawn 样板抄了 4 份（GIT-10）。
- 现在要加得碰：`util/git.ts` runGit、`gitRepoCache` spawnGit、doctor，再加每个想超时的 call-site 各自传参；`withTimeout` 还得改成真 kill。
- 目标形态：runGit 单点支持 `{timeoutMs, signal}` + 超时 kill 子进程 + 统一发一条 `git.duration` 结构化日志/指标；spawnGit 退化为 runGit 的无-cwd 形态。这样“给 fetch 加 60s 超时”是一行。

**[GIT-X4] 未来功能：Windows 二进制 / 非 POSIX 路径**
- 根因：`util/git.ts:1-5` 自述“no porcelain v2 / NUL-separated，含换行的路径会在 lsFiles 丢失”，全靠 `\t`/`\n` 行解析（`listFiles`/`gitChangedFiles`/`gitDiffSnapshot` 的 untracked 循环都是按 `\n` split）；`repoSlug`/worktree 路径用 `join` 但子目录碰撞后缀逻辑（task.ts:369 `resolveMultiRepoDirName`）与前端 `computePreviewDirNames` 是两份手抄需保持同步。
- 现在要加得碰：每个行解析点都要换 `-z` NUL 模式；safePath 已防了反斜杠（safePath.ts:31）但 worktree 内文件遍历是另一套（worktreeFiles.ts）。
- 目标形态：git.ts 统一走 `-z`/porcelain v2，输出解析收敛成一个 `parseNulList`；basename 碰撞解析抽到 shared 供前后端共用（消除手抄同步）。

**[GIT-X5] 未来功能：把 mirror 缓存做成可被外部工具/多 daemon 共享，或加 LRU/容量上限**
- 根因：`gitRepoCache` 的并发安全完全建立在“单 daemon + in-process `urlMutex`”假设上（`util/lock.ts` 的 flock 保证），mirror 无容量上限、无 LRU、无跨进程文件锁；批量导入（repoBatchImport.ts）整套队列状态只在内存（daemon 重启全丢，注释 :11-13 已自述）。
- 现在要加得碰：要加容量上限/LRU 得在 resolve/delete/list 三处都接 refTaskCount + 时间戳排序 + 跨进程锁；要持久化批量导入进度得把整个 `batches` Map 落库。
- 目标形态：mirror 元数据已在 `cached_repos` 表，加 LRU 只需一个按 `last_fetched_at` + refTaskCount==0 的逐出器（与 gc 同形）；若真要多进程共享，clone 的临时目录已是“sibling tmp + atomic rename”（:431-471 设计正确），只差一个 mirror 级 flock。当前单 daemon 下**这条优先级最低**。

---

## 5. 耦合 / 分层违规

**[GIT-11] `util/git.ts` 动态 import 服务层（gitSubmodule / gitRepoCache）规避循环依赖** — 级别 P3｜类型 coupling｜
证据：`util/git.ts:398-399` `createWorktree` 内 `await import('@/services/gitSubmodule')` + `await import('@/services/gitRepoCache')`（`resolveSubmoduleParams`）。注释（:396）明说是为绕开 util↔services 循环。｜影响：util 层（本应零业务依赖）实际反向依赖 services；分层倒挂，且动态 import 让静态分析/打包看不见这条边（参考 MEMORY 的 binary-build module-cycle 教训）。｜建议：`resolveSubmoduleParams` 是纯函数（只读 git caps），应下沉到 `util/git.ts` 或 `gitVersion`（util 层）；`syncSubmodules` 也无 DB 依赖，可移到 util，彻底消除动态 import。

**[GIT-12] 回滚语义分散在 6 个调用点，单一 owner（nodeRollback）只收了 2 条** — 级别 P2｜类型 coupling｜**S-2 家族已被 scheduler-audit 附录⑩覆盖**｜
证据：`nodeRollback.ts` 收了 scheduler in-process retry + resume 两条；但 `clarify.ts:393/438`、review iterate/reject、`crossClarify.ts:782` 仍各自处理（scheduler-audit ⑩点名）。｜影响：多仓在这些 rerun 起点的回滚正确性靠逐处接线，是 GIT-01 的具体表现。｜建议：随 GIT-01 的 `WorktreeSet` 一并把这 4 处改成调用 `rollbackNodeRunWorktrees`。

---

## 6. 测试 / 可观测性缺口

- **可观测性**：git 子进程零监控——没有耗时、没有“哪条 git 卡住/被超时杀”的事件；`withTimeout` 超时只产出一句 `repo-cache-locked`，看不出是网络慢还是锁泄漏（GIT-03）。建议 runGit 单点发 `git.duration`/`git.failed` 结构化日志。
- **多仓清理零测试**：GIT-05（部分失败回收）无任何测试；GIT-04 有 current-behavior-lock 测试（`scheduler-audit-gap3-gc-terminal-statuses.test.ts`）锁的是“故意保留 bug”，修复时该文件翻红即提醒。
- **force-delete-mirror 连带影响无测试**：GIT-06 没有“force 删 mirror 后活跃任务 worktree 失效”的回归。
- **git 超时/取消无测试**：因为根本没实现（GIT-03）。
- **GC `onlyMerged` 多仓语义未定义**：`gc.ts:97 isMerged` 对多仓只检查 `t.branch`（repos[0]），其余仓的合并状态无视——`onlyMerged` 在多仓下不可信，无测试。

## 7. 目标形态（Target architecture）

1. **WorktreeSet 作为唯一句柄**（解 GIT-01/02/04/05/12/X1/X2）：`{ taskId, repos: TaskRepo[] }`，`TaskRepo` 含 repoPath/worktreePath/dirName/branch/baseBranch/baseCommit。`runTask` 顶部加载一次（已有 repoRows，补回 branch 即可），下游所有 create/snapshot/rollback/remove/commit-push 只读它、按仓遍历。单仓 = length-1，single-path 字节基线由现有 grep guard 继续守。
2. **worktreeLifecycle.ts 作为清理唯一 owner**（解 GIT-04/05/06/07/X2）：`removeTaskWorktrees(taskId)` = 逐子仓 `removeWorktree` + `deleteSnapshotRefs(repo.repoPath, taskId)` + `rmSync` 容器 + `git worktree prune`；GC / cancel / 部分失败 / mirror-force-delete / 配额清理全调它。
3. **runGit 单点超时 + signal + 观测**（解 GIT-03/10/X3）：`runGit(cwd?, args, {timeoutMs, signal})`，超时/取消 kill 子进程；spawnGit 退化为无-cwd 形态；统一发结构化耗时日志。
4. **redact 收口**（解 GIT-08 + dedup #3/#18）：所有 git stderr 落库/落日志前过 `util/redact.ts` 超集。
5. **路径围栏收口**（解 GIT-09 + dedup #12/#44）：`safeJoinAllowRoot` 三处共用。
6. **util 层去倒挂**（解 GIT-11）：纯函数 `resolveSubmoduleParams`/`syncSubmodules` 下沉 util，删动态 import。

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 是否新发现 |
|---|---|---|---|---|---|
| 1 | GIT-03 | git 无超时/无 signal + withTimeout 超时泄漏 url 锁 | P1 | design/observability | **新** |
| 2 | GIT-01 | worktree 生命周期无单一 owner（漂移总根因） | P1 | design/coupling | 架构归因（S-2/R3 延伸） |
| 3 | GIT-04 | GC 多仓恒失败泄漏 + 无视 task_repos | P1 | design/impl-bug | 覆盖（⑥-3）+ 归因 |
| 4 | GIT-05 | 多仓 launch 部分失败 worktree 无回收 | P2 | design/impl-bug | **新** |
| 5 | GIT-06 | force 删 mirror 废掉活跃任务 worktree | P2 | design/impl-bug | **新** |
| 6 | GIT-09 | worktree 路径围栏第三份漂成安全缝 | P2 | security | 覆盖（dedup #12/#44） |
| 7 | GIT-07 | 从不 `git worktree prune`，源仓元数据膨胀 | P2 | impl-bug | **新** |
| 8 | GIT-02 | 多仓 commit&push 分支靠“恰好同名”侥幸正确 | P2 | design | **新（抽象泄漏）** |
| 9 | GIT-12 | 回滚语义 6 处分散，owner 只收 2 条 | P2 | coupling | 覆盖（⑩） |
| 10 | GIT-11 | util/git 动态 import 服务层（分层倒挂） | P3 | coupling | **新** |
| 11 | GIT-08 | commit stderr 裸写日志绕过 redact | P3 | security | 半覆盖（dedup #3） |
| 12 | GIT-10 | git-spawn 样板抄 4 份 | P3 | coupling | 覆盖（dedup #41） |

### 待核验（无法在静态阅读中证伪）
- GIT-03 的“孤儿 clone 阻塞同 URL 后续 launch 直到 OS 层结束”：依据 `withUrlLock` 的 release 在 `fn()` settle 后才跑（`gitRepoCache.ts:59-68`）+ `withTimeout` 不 kill（`:82-85`）的代码事实推断；需一条“clone 超时后第二次同 URL launch 是否立刻拿锁”的集成测试坐实。
- GIT-06 的“rmSync mirror 后 worktree 立即不可用”：依据 `util/git.ts:82-89` 注释自述的 `.git` 文件指向 mirror，未实跑验证；建议加回归。
