# Codex 核验：Git / worktree / 仓库 (07-git-worktree)

> 对应报告：`design/arch-audit-2026-06-23/07-git-worktree.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **GIT-03 属实，P1 合理**：`runGit` 没有 timeout/signal，也不会 kill 子进程（`packages/backend/src/util/git.ts:43`）。`resolveCachedRepo` 只是在外层 `Promise.race` timeout（`packages/backend/src/services/gitRepoCache.ts:71`、`packages/backend/src/services/gitRepoCache.ts:535`），内层 `spawnGit` clone 仍继续跑（`packages/backend/src/services/gitRepoCache.ts:93`、`packages/backend/src/services/gitRepoCache.ts:446`）。同 URL 后续调用会等 `withUrlLock` 的旧 slot 释放（`packages/backend/src/services/gitRepoCache.ts:49`）。
- **GIT-04 属实，P1 合理**：GC 只扫 `tasks`，不 join `task_repos`（`packages/backend/src/services/gc.ts:50`），并对多仓容器路径执行 `git worktree remove`（`packages/backend/src/services/gc.ts:73`）。多仓容器由普通 `mkdirSync` 创建（`packages/backend/src/services/task.ts:566`），不是某个 repo 的 worktree。
- **GIT-05 属实，P2 合理**：多仓 materialize loop 中，失败后直接 `break`（`packages/backend/src/services/task.ts:588`、`packages/backend/src/services/task.ts:609`），此前成功的 worktree 已进 `materializedRepos` 并落 `task_repos`（`packages/backend/src/services/task.ts:621`、`packages/backend/src/services/task.ts:718`）。测试还锁定“第一仓已记录、任务 failed”的当前行为（`packages/backend/tests/start-task-multi-repo-materialize.test.ts:233`）。
- **GIT-06 属实但报告还低估了问题**：`force` 会跳过引用保护并 `rmSync(row.localPath)`（`packages/backend/src/services/gitRepoCache.ts:669`、`packages/backend/src/services/gitRepoCache.ts:675`）；worktree 的 `.git` 依赖源仓 `.git/worktrees`，源仓删除后 worktree 会失效（`packages/backend/src/util/git.ts:81`）。
- **GIT-07 属实，P2 可接受**：全仓没有 `git worktree prune` 调用；`removeWorktree` 只做 `git worktree remove`（`packages/backend/src/util/git.ts:960`）。
- **GIT-08 属实，P3 合理**：commit 失败日志直接写 `commit.stderr.trim()`（`packages/backend/src/services/commitPushRunner.ts:239`、`packages/backend/src/services/commitPushRunner.ts:243`），虽然返回给节点的 `pushError` 有 redaction（`packages/backend/src/services/commitPushRunner.ts:249`）。
- **GIT-09 属实，P2 合理**：`worktreeFiles` 服务有 backslash + realpath 围栏（`packages/backend/src/services/worktreeFiles.ts:28`、`packages/backend/src/services/worktreeFiles.ts:50`），但 `/api/worktree-files` 路由只做词法 resolve，没有 backslash/realpath 检查（`packages/backend/src/routes/worktree-files.ts:57`、`packages/backend/src/routes/worktree-files.ts:64`）。
- **GIT-10 / GIT-11 属实但偏 P3**：`runGit` 与 `spawnGit` 样板重复（`packages/backend/src/util/git.ts:44`、`packages/backend/src/services/gitRepoCache.ts:93`）；`util/git.ts` 动态 import 服务层确实是分层倒挂（`packages/backend/src/util/git.ts:396`）。
- **GIT-02 只确认“扩展性债”，不应按当前 bug 处理**：`task_repos.branch` 已存在（`packages/backend/src/db/schema.ts:497`），但 scheduler 加载 `state.repos` 时丢掉它（`packages/backend/src/services/scheduler.ts:269`），commit&push 用 `task.branch`（`packages/backend/src/services/scheduler.ts:961`、`packages/backend/src/services/scheduler.ts:1044`）。不过现有设计明确“同一 working branch 应用于每仓”（`packages/backend/src/services/task.ts:583`），所以建议降为 P3/extensibility。

## REFUTED / 伪问题（给反证 file:line）

- **GIT-12 “nodeRollback 只收了 2 条”是过期/夸大**：clarify 已通过 `loadRollbackTarget` + `rollbackNodeRunWorktrees` 走共享多仓回滚（`packages/backend/src/services/clarify.ts:433`、`packages/backend/src/services/clarify.ts:450`）；review iterate/reject 也调用共享回滚（`packages/backend/src/services/review.ts:1716`、`packages/backend/src/services/review.ts:1722`）。cross-clarify 当前明确“不 rollback、原地修订”，这是有意语义，不是漏接线（`packages/backend/src/services/crossClarify.ts:763`）。
- **GIT-01 的“回滚散在 5 处”作为根因判断过重**：创建/GC 确实缺 owner，但回滚已经大幅收敛到 `nodeRollback`；`loadRollbackTarget` 直接从 `task_repos` 取多仓视图（`packages/backend/src/services/nodeRollback.ts:57`、`packages/backend/src/services/nodeRollback.ts:64`），scheduler retry 也调用共享回滚（`packages/backend/src/services/scheduler.ts:1871`）。更准确说法是“生命周期清理/创建缺 owner”，不是“回滚仍各自实现”。
- **GIT-X4 Windows 不能作为当前架构风险上升优先级**：权威产品形态明确 v1 只支持 macOS + Linux，Windows v1 不支持（`design/proposal.md:29`）。`-z`/NUL 解析仍是未来可移植性债，但不应挤占 P1/P2 修复序列。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **缓存仓引用计数会漏算 URL-mode 任务，可能无需 force 就删除活跃 mirror — P1 — `packages/backend/src/services/gitRepoCache.ts:538` / `packages/backend/src/services/task.ts:684` / `packages/backend/src/services/task.ts:724`**  
  `refTaskCount` 用 `cached_repos.url` 明文去等值匹配 `tasks.repoUrl`（`packages/backend/src/services/gitRepoCache.ts:538`），但启动任务时写入的是 redacted URL（`packages/backend/src/services/task.ts:684`），`task_repos.repoUrl` 也 redacted（`packages/backend/src/services/task.ts:724`）。带凭据 URL 会计数为 0；多仓的非首仓也不在 `tasks.repoUrl`。结果是 DELETE 可能不需要 `force=1` 就删掉仍被 task worktree 引用的 mirror。
- **repo-scoped memory 对带凭据 URL-mode 任务失效 — P2 — `packages/backend/src/services/memoryInject.ts:350` / `packages/backend/src/services/memoryDistillScheduler.ts:178`**  
  两处都用 `taskRow.repoUrl === cachedRepos.url` 查 repoId，但 task 侧 redacted、cache 侧明文。影响是同一个仓的记忆注入/蒸馏无法归到 repo scope，表现为“URL-mode 仓记忆丢失”。
- **multipart 上传失败会留下无 task row 的 worktree，GC 永远不可见 — P2 — `packages/backend/src/routes/tasks.ts:762` / `packages/backend/src/routes/tasks.ts:810`**  
  上传流先 materialize worktree，再写文件；`applyUploadsToWorktree` 抛错时注释明确“worktree directory stays on disk but no task row is created”（`packages/backend/src/routes/tasks.ts:810`）。这类孤儿既不在 `tasks` 也不在 `task_repos`，GC 无从清理。
- **GC 会删除可 resume 的 failed/interrupted worktree — P1 — `packages/backend/src/services/gc.ts:23` / `packages/backend/src/services/task.ts:1000`**  
  GC terminal set 包含 `failed` / `interrupted`（`packages/backend/src/services/gc.ts:23`），但 `resumeTask` 明确允许这两种状态恢复（`packages/backend/src/services/task.ts:1000`）。报告只在测试缺口里提到，没有作为正式风险列出；这会直接破坏“保留 worktree 以便恢复”的任务语义。
- **`withUrlLock` map 清理条件永远为 false，长跑 daemon 按 URL 泄漏 mutex entry — P3 — `packages/backend/src/services/gitRepoCache.ts:55`**  
  `urlMutex.set` 存的是一次 `prev.then(() => slot)` 的 Promise（`packages/backend/src/services/gitRepoCache.ts:55`），`finally` 比较时又新建了一次 `prev.then(() => slot)`（`packages/backend/src/services/gitRepoCache.ts:65`），引用不可能相等。正常完成后不阻塞后续请求，但会按 URL 长期留 Map 项。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

`WorktreeSet` 方向基本正确，但报告把范围拉得过大。建议先落一个更窄的 `TaskRepoSet`/`worktreeLifecycle`，只收敛三类真实破坏性路径：GC、部分 materialize 失败、缓存 mirror 删除。创建路径和 scheduler runtime metadata 可以后置，避免一次性重写 startTask/scheduler/review/clarify 造成 RFC-097 状态机 CAS 回归。

清理入口必须遵守现有不变量：任务状态仍只通过 `setTaskStatus` / `trySetTaskStatus` 变更；cleanup 本身不要顺手改 task status，避免绕开 RFC-097 CAS。RFC-099 也不应把 owner/collaborator 信息塞进 agent prompt；worktree owner 抽象只应是服务端权限和资源归属，不进入 `templateMeta` 或 opencode user prompt。

`runGit` 加 `{timeoutMs, signal}` 是必要的，但不要把它变成“所有调用默认短超时”。clone/fetch/submodule/push 的时限应分场景配置；取消信号要传到 task 级 AbortController，超时时 TERM 后 KILL，并记录结构化耗时。`spawnGit` 可合并进 `runGit(cwd?: string)`，但要保留无 cwd clone 的能力。

`deleteCachedRepo` 的优先修复不是“force 二次提示”，而是先修引用模型：用 cache id/url_hash 或明文 URL 单独安全存储引用，不要用 redacted display URL 做 join；引用计数应查 `task_repos`，并区分 active/resumable/terminal。否则 UI 再多确认也挡不住计数为 0 的误删。

`git worktree prune` 建议作为 cleanup 后的 best-effort，不应作为主修复。主修复必须逐 `task_repos.repoPath + worktreePath` remove；prune 只能清源仓 admin 残留。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：报告抓住了 worktree 生命周期和 git 子进程治理的主线，但部分回滚结论已经过期，并漏掉了 URL redaction 导致缓存仓引用计数失效这个更直接的 P1 问题。
