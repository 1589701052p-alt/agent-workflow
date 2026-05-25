# RFC-068 — 任务分解 & PR 计划

## PR 总览

单 PR 实现。改动面集中、无 DB schema / migration 变更，分 PR 反而增加
回归面。如果 review 量太大可临时拆分（见末尾）。

PR title：`feat(backend): RFC-068 sync base branch to remote before task launch`

## 子任务

### RFC-068-T1 — shared schema 扩展

- 文件：`packages/shared/src/schemas/task.ts`
- 改动：`StartTaskSchema` 加 `fetchBeforeLaunch: z.boolean().optional()`。
- 测试：BC-shared 4 case（true / false / undefined / 非 bool 拒绝）。
- 估算：0.5 d。

### RFC-068-T2 — util/git 新增 `classifyBaseRef`

- 文件：`packages/backend/src/util/git.ts`
- 改动：新增 export `BaseRefKind` 类型 + `classifyBaseRef()` 函数。
- 测试：`packages/backend/src/util/__tests__/git-classifyBaseRef.test.ts`
  覆盖 5 种 kind + edge case（含 `/` 的 branch 名、含大小写 hex 的 sha、
  refs/tags vs refs/heads 同名优先级）。
- 估算：0.5 d。

### RFC-068-T3 — `services/gitRepoCache.ts` FF 实现

- 文件：`packages/backend/src/services/gitRepoCache.ts`
- 改动：
  - 新增 `syncBranchToRemote(cacheDir, branch)` 内部函数。
  - `GitRepoCacheDeps` 加 optional `syncBranches?: string[]`（caller 传
    需要 FF 的 branch 列表，默认是 detected default branch）。
  - `ResolveCachedRepoResult` 加 `ffWarnings: string[]`。
  - warm path 内部循环：对每个 syncBranch 调 `classifyBaseRef` →
    `syncBranchToRemote`，收集 warning。
  - 冷 clone 不动（clone 本来就最新）。
- 测试：BC-01 ~ BC-10 全部（10 case）。
- 估算：1.5 d。

### RFC-068-T4 — `services/repo.ts` opt-in fetch helper

- 文件：`packages/backend/src/services/repo.ts`（新增 export，文件已存在）
- 改动：`fetchPathRepoBeforeLaunch(repoPath)`，纯 `git fetch --all
  --prune --tags` wrapper；永不 pull / merge / checkout。
- 测试：BP-01 ~ BP-03（path 模式行为）+ BP-05 ~ BP-08（源代码层文本断
  言）。
- 估算：0.5 d。

### RFC-068-T5 — `services/task.ts` 串接

- 文件：`packages/backend/src/services/task.ts`
- 改动：
  - `resolveRepoSource` 接收 `input.fetchBeforeLaunch`，path 模式按开
    关调 `fetchPathRepoBeforeLaunch`（失败 WARN + 继续）。
  - URL 模式把 `input.ref` 传给 `resolveCachedRepo` 的 `syncBranches`
    选项。
  - WS 广播 `taskEvent.fetchWarn`（如果有 ffWarnings / fetchFailed）。
- 测试：BP-04（URL 模式 ignore fetchBeforeLaunch）+ BP-09（FF +
  submodule init 顺序）。
- 估算：0.5 d。

### RFC-068-T6 — Launcher 前端

- 文件：
  - `packages/frontend/src/routes/tasks/launch.tsx`（或 RFC-066 的
    `RepoSourceRow.tsx`，看落地顺序）
  - `packages/frontend/src/i18n/cn.ts` / `en.ts`
- 改动：
  - Path 模式行加 `<Field>` 包 `<Switch>` `launcher.repo.pathFetch`。
  - URL 模式行加 `launcher.repo.urlAutoSync` 静态提示文案。
  - `<Switch>` 状态记 localStorage 键 `agent-workflow.launcher.pathFetch`。
  - submit 时 body 带 `fetchBeforeLaunch` 字段。
- 测试：BF-01 ~ BF-08（8 case）。
- 估算：1 d。

### RFC-068-T7 — 任务详情页 fetch/FF warning 显示

- 文件：`packages/frontend/src/routes/tasks/$taskId.tsx`（或相邻
  TaskHeader 组件）
- 改动：消费 `taskEvent.fetchWarn`，渲染小 chip + tooltip；i18n key
  `task.detail.baseStaleWarn`。
- 测试：BF-06 cover。
- 估算：0.5 d。

### RFC-068-T8 — e2e

- 文件：`packages/frontend/tests/e2e/rfc068-base-branch-sync.spec.ts`
- 改动：mock-remote URL fixture（playwright 已有 git server helper，复
  用）+ 两次启动验证 worktree files 更新。
- 测试：单 spec / 1 scenario。
- 估算：1 d。

### RFC-068-T9 — STATE.md / plan.md 收尾

- 文件：`STATE.md`、`design/plan.md`
- 改动：RFC 状态 Draft → Done；STATE.md 顶部"进行中 RFC-068"行删除；
  已完成 issue 表加一行。
- 估算：0.25 d。

## 依赖关系

```
T1 (shared schema)
 ├─ T2 (classifyBaseRef)       — 独立
 ├─ T3 (FF)                    — depends T2
 ├─ T4 (path fetch helper)     — 独立
 ├─ T5 (task.ts 串接)          — depends T1+T3+T4
 ├─ T6 (launcher 前端)         — depends T1
 ├─ T7 (任务详情 warning)      — depends T5
 ├─ T8 (e2e)                   — depends T5+T6
 └─ T9 (STATE.md / plan.md)    — last
```

T2 / T4 可与 T1 并行；T3 / T6 可并行；T5 / T7 / T8 收尾。

## PR 拆分备选（仅在 review 量太大时启用）

- **PR-A**：T1 + T2 + T3 + T4 + T5（backend + shared，可独立 ship —
  body 接受 `fetchBeforeLaunch` 字段，前端暂无 UI 触发，对老用户零行为
  变更）。
- **PR-B**：T6 + T7 + T8（前端 UI + e2e）。

默认走单 PR；只在 PR-A 改动 LOC > 800 或 reviewer 主动要求时拆。

## 验收清单（落 PR 前必须全绿）

- [ ] `bun run typecheck` 通过
- [ ] `bun run test` 通过（含本 RFC 新增 ≥ 30 case：shared 4 + backend
      ≥ 18 + frontend ≥ 8）
- [ ] `bun run format:check` 通过
- [ ] 既有 git / worktree / cached-repo 套件零退化（特别是
      `gitRepoCache-cache-revalidate.test.ts` / `task-launch.test.ts` /
      `worktree.test.ts`）
- [ ] e2e `rfc068-base-branch-sync.spec.ts` 通过
- [ ] 手动 smoke：
  - [ ] URL 模式启动一个本机服务器的 mock-remote URL → 远端 push 一个
        新 commit → 第二次启动 → worktree files tab 看到新 commit
        内容
  - [ ] Path 模式不勾开关 → 不触发任何 git fetch（监控 daemon 日志）
  - [ ] Path 模式勾开关 + 远端可达 → 看到 fetch 日志、用户本地 branch
        ref 不变、`git status` 在用户仓里仍是 clean
  - [ ] Path 模式勾开关 + 远端不可达 → 启动表单 warning，任务能起
- [ ] 推送后按 `feedback_post_commit_ci_check` 立刻 `gh run list -L 5`
      看 CI 状态

## 不在本 RFC 范围

- URL 模式 fetch on reuse 默认值不变（仍 true，新加的 launcher 「跳过
  fetch」开关已 OPEN QUESTION 决定不做）。
- Path 模式不做"自动 pull"。永远 opt-in 且只到 fetch。
- 不动 worktree 创建分支命名（仍 `agent-workflow/{taskId}`）。
- 不动 worktree 路径布局（与 RFC-066 落地后的 multi/{taskId}/ 平铺保持
  正交）。
- 不动 cache repo 的工作目录（仍不主动 checkout / reset；运行时只看
  worktree）。
