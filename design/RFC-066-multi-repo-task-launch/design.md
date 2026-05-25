# RFC-066 — 技术设计（Multi-Repo Task Launch）

## 0. 全文约定

本 RFC 区分两条代码路径：

- **single-path**（`repos.length === 1` 或 legacy `repoPath`/`repoUrl`
  字段）：与今天行为字节级一致，所有现存测试 / API fixture / WS
  payload 不允许 byte-level diff。
- **multi-path**（`repos.length > 1`）：进入新的代码分支，与 single
  共用同一 service 但分支显式。

实现侧 invariant：**single-path 永远走 single-path 代码分支**，绝不
被多仓代码"顺路"消化掉。grep guard（design §6）锁住这条。

---

## 1. 数据模型

### 1.1 新表 `task_repos`

```sql
CREATE TABLE task_repos (
  task_id            TEXT NOT NULL,
  repo_index         INTEGER NOT NULL,    -- 0..N-1；0 总是 primary
  repo_path          TEXT NOT NULL,       -- 绝对路径（URL 模式 = cached_repos.localPath）
  repo_url           TEXT,                -- 已 redact 的源 URL；path 模式为 NULL
  base_branch        TEXT NOT NULL DEFAULT '',
  branch             TEXT NOT NULL,       -- 'agent-workflow/{taskId}'
  base_commit        TEXT,                -- nullable
  worktree_path      TEXT NOT NULL,       -- 绝对路径
  worktree_dir_name  TEXT NOT NULL DEFAULT '',
                                          -- 多仓时是 cwd 下的 sub-dir 名（含冲突后缀）
                                          -- 单仓时空串（cwd 自己就是 worktree）
  has_submodules         INTEGER,         -- nullable boolean
  submodule_init_ok      INTEGER,         -- nullable boolean
  submodule_init_error   TEXT,            -- nullable
  schema_version     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (task_id, repo_index),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_repos_repo_path ON task_repos(repo_path);
CREATE INDEX idx_task_repos_repo_url ON task_repos(repo_url);
```

### 1.2 `tasks` 表列扩展

```sql
ALTER TABLE tasks ADD COLUMN repo_count INTEGER NOT NULL DEFAULT 1;
```

- `repo_count` = `task_repos` 行数，**写入路径同步维护**（startTask 写
  task_repos 时一并写 repo_count，便于"找多仓 task"快速过滤）。
- `tasks.repo_path / repo_url / base_branch / branch / base_commit /
  worktree_path` **保留**，语义为 **`task_repos[0]` 的镜像**：
  - 单仓时 `task_repos[0]` 完全镜像 `tasks` 的这些列。
  - 多仓时镜像 `task_repos[0]`（`repo_path` = 第一个源仓的绝对路径，
    `worktree_path` = `~/.agent-workflow/worktrees/multi/{taskId}`，
    `branch` = `agent-workflow/{taskId}`，`base_commit` = 第一个仓的
    base commit）。
  - 即：`tasks.worktree_path` **永远等于 opencode 子进程的 cwd**。

### 1.3 `node_runs` 表列扩展

```sql
ALTER TABLE node_runs ADD COLUMN pre_snapshot_repos_json TEXT;
```

- 单仓 task 的 run：写老列 `pre_snapshot`（单 sha），新列保持 NULL。
- 多仓 task 的 run：写新列 `pre_snapshot_repos_json`
  `{"<wt-dir-name>":"<stash-sha>", ...}`，老列保持 NULL（rollback 时
  优先读新列）。
- resume / retry 流程按列存在性分流（§5 详述）。

### 1.4 Migration 0034

`packages/backend/src/db/migrations/0034_rfc066_task_repos.sql`（RFC-067
已先落 0033_rfc067_task_git_identity 占用编号，故顺延 0034）：

```sql
CREATE TABLE task_repos (
  -- ... 见 §1.1
);
CREATE INDEX idx_task_repos_repo_path ON task_repos(repo_path);
CREATE INDEX idx_task_repos_repo_url ON task_repos(repo_url);

INSERT INTO task_repos (
  task_id, repo_index, repo_path, repo_url, base_branch,
  branch, base_commit, worktree_path, worktree_dir_name,
  has_submodules, submodule_init_ok, submodule_init_error,
  schema_version
)
SELECT
  id, 0, repo_path, repo_url, base_branch,
  branch, base_commit, worktree_path, '',
  NULL, NULL, NULL,
  1
FROM tasks;

ALTER TABLE tasks ADD COLUMN repo_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE node_runs ADD COLUMN pre_snapshot_repos_json TEXT;
```

drizzle schema（`packages/backend/src/db/schema.ts`）增 `taskRepos`
对象 + `tasks.repoCount` + `nodeRuns.preSnapshotReposJson`。

journal idx：当前 HEAD 是 33（来自 RFC-067 migration 0033，journal idx=32）；
本 RFC 落 idx=33（migration 0034）。`upgrade-rolling.test.ts` 同步刷一个
journal count。

---

## 2. shared schemas

### 2.1 `TaskRepoSchema`（新）

`packages/shared/src/schemas/task.ts`：

```ts
export const TaskRepoSchema = z.object({
  repoIndex: z.number().int().nonnegative(),
  repoPath: z.string(),
  repoUrl: z.string().nullable(),
  baseBranch: z.string(),
  branch: z.string(),
  baseCommit: z.string().nullable(),
  worktreePath: z.string(),
  /** 多仓时是 cwd 下的 sub-dir 名（含冲突后缀）；单仓时空串。 */
  worktreeDirName: z.string(),
  hasSubmodules: z.boolean().nullable(),
  submoduleInitOk: z.boolean().nullable(),
  submoduleInitError: z.string().nullable(),
})
export type TaskRepo = z.infer<typeof TaskRepoSchema>
```

### 2.2 `TaskSchema` / `TaskSummarySchema` 扩展

`TaskSchema` 加：

```ts
repoCount: z.number().int().positive(),   // ≥ 1
repos: z.array(TaskRepoSchema),           // 长度 = repoCount
```

`TaskSummarySchema` 加：

```ts
repoCount: z.number().int().positive(),
```

（list 视图不展开仓详情，只显示 chip『N repos』）。

### 2.3 `StartTaskSchema` 扩展

新增 `StartTaskRepoSchema`：

```ts
export const StartTaskRepoSchema = z
  .object({
    repoPath: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const hasPath = !!value.repoPath
    const hasUrl = !!value.repoUrl
    if (hasPath && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repoPath and repoUrl are mutually exclusive',
        path: ['repoUrl'],
      })
    }
    if (!hasPath && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'one of repoPath or repoUrl is required',
        path: ['repoPath'],
      })
    }
    if (hasPath && (!value.baseBranch || value.baseBranch.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseBranch is required in path mode',
        path: ['baseBranch'],
      })
    }
  })
export type StartTaskRepo = z.infer<typeof StartTaskRepoSchema>
```

`StartTaskSchema` superRefine 改写：

```ts
export const MULTI_REPO_MAX = 8
export const StartTaskSchema = z
  .object({
    workflowId: z.string().min(1),
    name: TaskNameSchema,
    // legacy 字段（单仓兼容）
    repoPath: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    // v2: 多仓
    repos: z.array(StartTaskRepoSchema).min(1).max(MULTI_REPO_MAX).optional(),
    inputs: z.record(z.string(), z.string()).default({}),
    maxDurationMs: z.number().int().nonnegative().optional(),
    maxTotalTokens: z.number().int().nonnegative().optional(),
    assignments: z.array(/* unchanged */).optional(),
    collaboratorUserIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const hasLegacyPath = !!value.repoPath
    const hasLegacyUrl = !!value.repoUrl
    const hasLegacy = hasLegacyPath || hasLegacyUrl
    const hasRepos = Array.isArray(value.repos) && value.repos.length > 0

    if (hasLegacy && hasRepos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'legacy repoPath/repoUrl is mutually exclusive with repos[]',
        path: ['repos'],
        params: { errorCode: 'start-task-source-conflict' },
      })
      return
    }
    if (!hasLegacy && !hasRepos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'one of repoPath, repoUrl, or repos[] is required',
        path: ['repos'],
      })
      return
    }
    if (hasLegacyPath && hasLegacyUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repoPath and repoUrl are mutually exclusive',
        path: ['repoUrl'],
      })
    }
    if (hasLegacyPath && (!value.baseBranch || value.baseBranch.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseBranch is required in path mode',
        path: ['baseBranch'],
      })
    }
  })
```

服务端在 `startTask` 入口先做 **normalization**：

```ts
function normalizeStartTaskRepos(input: StartTask): StartTaskRepo[] {
  if (Array.isArray(input.repos) && input.repos.length > 0) {
    return input.repos
  }
  // legacy → 单仓数组
  return [
    {
      ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
      ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    },
  ]
}
```

这条 normalization **既被 single-path 也被 multi-path 使用**，保证内部
代码路径统一处理 `StartTaskRepo[]`；外部 API 保留 legacy 兼容。

---

## 3. 后端 service

### 3.1 `services/task.ts` `startTask` 重构

```ts
export async function startTask(input: StartTask, deps: StartTaskDeps): Promise<Task> {
  const workflow = await getWorkflow(deps.db, input.workflowId) // 不变
  if (workflow === null) throw new NotFoundError(...)
  const validation = validateWorkflowDef(workflow.definition, {
    agents: await listAgents(deps.db),
    skills: await listSkills(deps.db),
  })
  if (!validation.ok) throw new ValidationError(...)

  const appHome = deps.appHome ?? Paths.root
  const repoSpecs = normalizeStartTaskRepos(input)

  // 多仓 gate：wrapper-git
  if (repoSpecs.length > 1) {
    const wrapperGitNodes = (workflow.definition.nodes ?? [])
      .filter((n) => n.kind === 'wrapper-git')
      .map((n) => n.id)
    if (wrapperGitNodes.length > 0) {
      throw new ValidationError(
        'multi-repo-wrapper-git-unsupported',
        'wrapper-git nodes are not supported in multi-repo tasks (v1)',
        { wrapperGitNodes },
      )
    }
    // 多仓 gate：upload inputs
    const uploadInputs = (workflow.definition.inputs ?? [])
      .filter((i) => i.kind === 'upload')
      .map((i) => i.key)
    if (uploadInputs.length > 0) {
      throw new ValidationError(
        'multi-repo-upload-unsupported',
        'multipart upload inputs are not supported in multi-repo tasks (v1)',
        { uploadInputs },
      )
    }
  }

  // 解析每个 repo spec（path / URL 两种模式各自处理）
  const resolved = await Promise.all(
    repoSpecs.map((spec) => resolveRepoSourceSingle(spec, deps)),
  )
  // resolved: { repoPath, baseBranch?, repoUrl: string | null }[]

  // 单/多仓分流
  const taskId = deps.preCreatedWorktree?.taskId ?? ulid()
  let primaryWorktreePath: string
  let materializedRepos: MaterializedRepo[]
  let earlyError: string | null = null

  if (resolved.length === 1) {
    // single-path: 与今天 byte-for-byte 一致
    if (deps.preCreatedWorktree) {
      primaryWorktreePath = deps.preCreatedWorktree.worktreePath
      materializedRepos = [{
        ...resolved[0],
        worktreePath: deps.preCreatedWorktree.worktreePath,
        worktreeDirName: '',
        branch: deps.preCreatedWorktree.branch,
        baseCommit: deps.preCreatedWorktree.baseCommit,
        submoduleInitOk: true,
        submoduleInitError: null,
        hasSubmodules: false,
      }]
    } else {
      const wt = await materializeWorktree({
        repoPath: resolved[0].repoPath,
        baseBranch: resolved[0].baseBranch,
        taskId,
        appHome,
      })
      primaryWorktreePath = wt.worktreePath
      materializedRepos = [{
        ...resolved[0],
        worktreePath: wt.worktreePath,
        worktreeDirName: '',
        branch: wt.branch,
        baseCommit: wt.baseCommit,
        submoduleInitOk: wt.submoduleInitOk,
        submoduleInitError: wt.submoduleInitError,
        hasSubmodules: wt.hasSubmodules,
      }]
      earlyError = wt.earlyError
    }
  } else {
    // multi-path
    const parentWorktree = join(appHome, 'worktrees', 'multi', taskId)
    await mkdir(parentWorktree, { recursive: true })
    primaryWorktreePath = parentWorktree
    // 收集 basename 冲突
    const usedNames = new Set<string>()
    const named = resolved.map((r) => {
      const raw = basename(r.repoPath)
      let name = raw
      let suffix = 2
      while (usedNames.has(name)) {
        name = `${raw}-${suffix}`
        suffix += 1
      }
      usedNames.add(name)
      return { ...r, wtDirName: name }
    })
    // 每仓 git worktree add（顺序而非并行 — git on the same source repo
    // can race on `.git/index.lock`；并行带来 5-15% wallclock 收益，但
    // 不值在 v1 引入 race risk）
    materializedRepos = []
    for (const r of named) {
      const wtPath = join(parentWorktree, r.wtDirName)
      try {
        const wt = await createWorktree({
          repoPath: r.repoPath,
          taskId, // 同 taskId 跨 source repo 的分支不会撞
          ...(r.baseBranch !== undefined ? { baseBranch: r.baseBranch } : {}),
          appHome,
          // 修改 createWorktree 让 caller 能指定 wtPath，避免 default
          // `~/.agent-workflow/worktrees/{repoSlug}/{taskId}` 计算
          overrideWorktreePath: wtPath,
        })
        materializedRepos.push({
          ...r,
          worktreePath: wt.worktreePath,
          worktreeDirName: r.wtDirName,
          branch: wt.branch,
          baseCommit: wt.baseCommit,
          submoduleInitOk: wt.submoduleInitOk,
          submoduleInitError: wt.submoduleInitError,
          hasSubmodules: wt.hasSubmodules,
        })
      } catch (err) {
        earlyError = err instanceof Error ? err.message : String(err)
        break
      }
    }
  }

  const now = Date.now()
  await deps.db.transaction(async (tx) => {
    await tx.insert(tasks).values({
      id: taskId,
      name: input.name,
      workflowId: workflow.id,
      workflowSnapshot: JSON.stringify(workflow.definition),
      // mirror task_repos[0]
      repoPath: materializedRepos[0]?.repoPath ?? '',
      repoUrl: materializedRepos[0]?.repoUrl !== null
        ? redactGitUrl(materializedRepos[0]!.repoUrl!)
        : null,
      worktreePath: primaryWorktreePath,
      baseBranch: materializedRepos[0]?.baseBranch ?? '',
      branch: materializedRepos[0]?.branch ?? `agent-workflow/${taskId}`,
      baseCommit: materializedRepos[0]?.baseCommit ?? null,
      repoCount: materializedRepos.length,
      status: earlyError === null ? 'pending' : 'failed',
      inputs: JSON.stringify(input.inputs),
      maxDurationMs: input.maxDurationMs ?? null,
      maxTotalTokens: input.maxTotalTokens ?? null,
      startedAt: now,
      finishedAt: earlyError === null ? null : now,
      errorSummary: earlyError !== null ? `worktree creation failed: ${earlyError}` : null,
      errorMessage: earlyError,
      ownerUserId: deps.actorUserId ?? null,
    })
    for (let i = 0; i < materializedRepos.length; i++) {
      const r = materializedRepos[i]!
      await tx.insert(taskRepos).values({
        taskId,
        repoIndex: i,
        repoPath: r.repoPath,
        repoUrl: r.repoUrl !== null ? redactGitUrl(r.repoUrl) : null,
        baseBranch: r.baseBranch ?? '',
        branch: r.branch,
        baseCommit: r.baseCommit,
        worktreePath: r.worktreePath,
        worktreeDirName: r.worktreeDirName,
        hasSubmodules: r.hasSubmodules,
        submoduleInitOk: r.submoduleInitOk,
        submoduleInitError: r.submoduleInitError,
      })
    }
  })

  // 路径模式仓全部 upsert 进 recent_repos（多仓 path 模式时调用 N 次）
  for (const r of materializedRepos) {
    if (r.repoUrl === null) {
      upsertRecentRepo(deps.db, r.repoPath).catch((err) =>
        log.warn('upsertRecentRepo failed', { error: (err as Error).message }),
      )
    }
  }

  // 后续 task fetch / collab / scheduler 启动逻辑不变
  // ...
}
```

`materializeWorktree` 现签名加一个可选 `overrideWorktreePath: string` 参
数：如果传了就直接用，不再调 `repoSlug` 算路径；single-path 调用方不
传该参数，沿用今天的 `{repoSlug}/{taskId}` 路径计算。这样 single-path
的 path layout 字节级保留。

### 3.2 `services/task.ts` `getTask` 扩展

```ts
export async function getTask(db: DbClient, id: string): Promise<Task | null> {
  const row = /* tasks 行；不变 */
  if (row === null) return null
  const repos = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, id))
    .orderBy(asc(taskRepos.repoIndex))
  // 单仓向后兼容：repos.length === 0 时（migration 0034 之前的极端
  // 中间态，理论上不出现，但 defensive）合成一行从 row 的 mirror 字段
  if (repos.length === 0) {
    return {
      ...mapTaskRow(row),
      repoCount: 1,
      repos: [synthesizeRepoFromTask(row)],
    }
  }
  return {
    ...mapTaskRow(row),
    repoCount: repos.length,
    repos: repos.map(mapTaskRepoRow),
  }
}
```

### 3.3 `services/scheduler.ts` template var 渲染

scheduler 调 runner 时把 `templateMeta` 扩展：

```ts
templateMeta: {
  repoPath: task.repoPath,        // legacy = repo[0].repoPath，保持不变
  baseBranch: task.baseBranch,    // legacy 不变
  taskId,
  nodeId: node.id,
  iteration,
  // 新增 — 三个占位符渲染源
  repos: task.repos.map((r) => ({
    repoPath: r.repoPath,
    worktreePath: r.worktreePath,
    worktreeDirName: r.worktreeDirName,
    baseBranch: r.baseBranch,
  })),
}
```

`shared/src/prompt.ts` `renderUserPrompt` 增加渲染：

```ts
out = out.replaceAll('{{__repos__}}', meta.repos.map((r) => r.worktreePath).join('\n'))
out = out.replaceAll('{{__repo_names__}}', meta.repos.map((r) => r.worktreeDirName).join('\n'))
out = out.replaceAll('{{__repo_count__}}', String(meta.repos.length))
```

旧 `{{__repo_path__}}` / `{{__base_branch__}}` / `{{__task_id__}}` 渲
染不动。

### 3.4 多仓 wrapper-git gate 在 scheduler 层兜底

`runTask` 入口（scheduler.ts）首次扫 workflow 节点：

```ts
if (task.repoCount > 1) {
  const wrapperGit = workflowDef.nodes.find((n) => n.kind === 'wrapper-git')
  if (wrapperGit) {
    // startTask 应已拒，此处兜底防 mid-life-cycle 改 workflow
    throw new DomainError(
      'multi-repo-wrapper-git-unsupported',
      `wrapper-git node ${wrapperGit.id} not allowed in multi-repo task`,
      400,
    )
  }
}
```

`workflowDef.nodes` 已是 `tasks.workflowSnapshot` 的快照，midway swap 不
影响这条 gate；但实现里仍按 v1 防御。

### 3.5 Diff endpoint 多仓拼接

`services/task.ts` `worktreeDiffForTask`：

```ts
export async function worktreeDiffForTask(
  db: DbClient,
  id: string,
): Promise<{ diff: string; baseCommit: string | null; truncated: boolean }> {
  const task = await getTask(db, id)
  if (task === null) throw new NotFoundError(...)
  if (task.repoCount === 1) {
    // 单仓 byte-for-byte 不变
    if (task.baseCommit === null) throw new DomainError(...)
    if (!existsSync(task.worktreePath)) throw new DomainError(...)
    return await worktreeDiff(task.worktreePath, task.baseCommit)
  }
  // 多仓：每仓拼接
  const MAX_BYTES = 1024 * 1024
  let out = ''
  let truncated = false
  for (const repo of task.repos) {
    if (repo.baseCommit === null) continue
    if (!existsSync(repo.worktreePath)) continue
    const oneRaw = await gitDiffSnapshot(repo.worktreePath, repo.baseCommit)
    if (oneRaw === '') continue
    const header = `# === Repo: ${repo.worktreeDirName} ===\n`
    if (out.length + header.length + oneRaw.length > MAX_BYTES) {
      const remaining = MAX_BYTES - out.length - header.length
      if (remaining > 0) {
        out += header + oneRaw.slice(0, remaining)
      }
      truncated = true
      break
    }
    out += header + oneRaw
    if (!out.endsWith('\n')) out += '\n'
  }
  // multi-repo 没有单一 baseCommit；返回 null
  return { diff: out, baseCommit: null, truncated }
}
```

前端 `DiffViewer` 已能识别 `# ===` 行作为新文件块前 hunk header，零改
动（验证以单测覆盖）。

### 3.6 Resume per-repo rollback

`services/task.ts` resume 路径（`resumeTask` + 单节点 retry）：

```ts
async function rollbackForResume(task: Task, run: NodeRun): Promise<void> {
  if (run.preSnapshotReposJson !== null && task.repoCount > 1) {
    const map: Record<string, string> = JSON.parse(run.preSnapshotReposJson)
    for (const repo of task.repos) {
      const sha = map[repo.worktreeDirName]
      if (sha) {
        await rollbackToSnapshot(repo.worktreePath, sha)
      }
    }
    return
  }
  // single-path（含 multi-task 中没写过新列的极端 mid-state）
  if (run.preSnapshot !== null && run.preSnapshot !== '' && task.worktreePath !== '') {
    await rollbackToSnapshot(task.worktreePath, run.preSnapshot)
  }
}
```

`gitStashSnapshot` 在 scheduler 调度写节点前：

```ts
if (task.repoCount === 1) {
  const sha = await gitStashSnapshot(task.worktreePath)
  await db.update(nodeRuns)
    .set({ preSnapshot: sha })
    .where(eq(nodeRuns.id, runId))
} else {
  const map: Record<string, string> = {}
  for (const repo of task.repos) {
    map[repo.worktreeDirName] = await gitStashSnapshot(repo.worktreePath)
  }
  await db.update(nodeRuns)
    .set({ preSnapshotReposJson: JSON.stringify(map) })
    .where(eq(nodeRuns.id, runId))
}
```

---

## 4. 前端

### 4.1 组件层

新文件 `packages/frontend/src/components/launch/RepoSourceRow.tsx`：把
现有 `RepoSourceTabs.tsx` 内部 markup（Local Path / Remote URL 二选一
+ baseBranch / ref pickers）整体抽出，prop：

```ts
export interface RepoSourceRowProps {
  source: RepoSource
  index: number              // 0-based 位置（用于 a11y 标签）
  showRemove: boolean        // true 时渲染右上 - 按钮
  onChange: (next: RepoSource) => void
  onRemove: () => void
  /** 多仓时显示「将挂载为 <dir>/」预览；index=0 单仓时隐藏。 */
  previewDirName: string | null
}
```

新文件 `packages/frontend/src/components/launch/RepoSourceList.tsx`：

```tsx
export interface RepoSourceListProps {
  repos: RepoSource[]
  onChange: (next: RepoSource[]) => void
  /** 多仓 wrapper-git / upload gate banner。 */
  multiRepoBlockedReason: 'wrapper-git' | 'upload' | null
  /** 上限。 */
  maxCount: number  // = MULTI_REPO_MAX 默认 8
}

export function RepoSourceList({ repos, onChange, multiRepoBlockedReason, maxCount }: RepoSourceListProps) {
  const previewNames = computePreviewDirNames(repos)
  return (
    <div className="repo-source-list" data-testid="repo-source-list">
      {repos.map((src, i) => (
        <RepoSourceRow
          key={i}
          source={src}
          index={i}
          showRemove={repos.length > 1}
          previewDirName={repos.length > 1 ? previewNames[i] ?? null : null}
          onChange={(next) => onChange(repos.map((r, j) => (j === i ? next : r)))}
          onRemove={() => onChange(repos.filter((_, j) => j !== i))}
        />
      ))}
      <div className="repo-source-list__actions">
        <button
          type="button"
          className="btn btn--sm"
          data-testid="repo-source-add"
          disabled={repos.length >= maxCount}
          onClick={() => onChange([...repos, defaultRepoSource()])}
        >
          {t('launch.repoSource.add')}
        </button>
        {multiRepoBlockedReason && (
          <div className="repo-source-list__banner" role="status">
            {t(`launch.repoSource.multiRepoBlocked.${multiRepoBlockedReason}`)}
          </div>
        )}
      </div>
    </div>
  )
}
```

`computePreviewDirNames` 与 backend 冲突解决逻辑等价（同样的 raw +
suffix-2/3 算法，纯函数，单测覆盖）。

### 4.2 路由层

`routes/workflows.launch.tsx` state 改造：

```ts
const [repos, setRepos] = useState<RepoSource[]>([defaultRepoSource()])
```

mutation `start.mutationFn` 按 `repos.length` 分流：

```ts
mutationFn: () => {
  const name = taskName.trim()
  if (repos.length === 1) {
    // legacy 形态（兼容旧 fixture）
    return api.post<Task>('/api/tasks', buildLaunchBody(repos[0], { workflowId: id, name, inputs }))
  }
  // v2 形态
  return api.post<Task>('/api/tasks', buildLaunchBodyV2(repos, { workflowId: id, name, inputs }))
}
```

`buildLaunchBodyV2` 新增（`lib/launch-repo-source.ts`）：

```ts
export function buildLaunchBodyV2(
  repos: RepoSource[],
  common: LaunchCommonPayload,
): Record<string, unknown> {
  return {
    workflowId: common.workflowId,
    name: common.name,
    inputs: common.inputs,
    repos: repos.map((r) => {
      if (r.kind === 'path') {
        return { repoPath: r.repoPath, baseBranch: r.baseBranch }
      }
      const out: Record<string, unknown> = { repoUrl: r.repoUrl }
      if (r.ref.trim().length > 0) out.ref = r.ref.trim()
      return out
    }),
  }
}
```

multi-repo gate：

```ts
const hasWrapperGit = (workflow.data?.definition.nodes ?? []).some((n) => n.kind === 'wrapper-git')
const hasUpload = (workflow.data?.definition.inputs ?? []).some((i) => i.kind === 'upload')
const multiRepoBlockedReason: 'wrapper-git' | 'upload' | null =
  repos.length > 1 ? (hasWrapperGit ? 'wrapper-git' : hasUpload ? 'upload' : null) : null
```

Start 按钮 disabled 条件叠加 `multiRepoBlockedReason !== null`。

### 4.3 任务详情 header

`routes/tasks.detail.tsx` header 行（任务名 / status / branch 等下方）
新增 multi-repo 条件块：

```tsx
{task.repoCount > 1 && (
  <details className="task-detail__multi-repo">
    <summary>{t('tasks.multiRepoSummary', { count: task.repoCount })}</summary>
    <ul>
      {task.repos.map((r) => (
        <li key={r.repoIndex}>
          <code>{r.worktreeDirName || basename(r.repoPath)}</code>
          {' @ '}
          <code>{r.baseBranch || '(default)'}</code>
          {r.repoUrl && <span className="muted"> · {r.repoUrl}</span>}
        </li>
      ))}
    </ul>
  </details>
)}
```

单仓 task 不渲染该块（保 baseline）。

### 4.4 i18n keys（cn / en 对称）

```
launch.repoSource.add                 → "+ 增加仓库" / "+ Add repository"
launch.repoSource.remove              → "− 删除此仓" / "− Remove repository"
launch.repoSource.previewDirName      → "将挂载为 {{name}}/" / "Will mount as {{name}}/"
launch.repoSource.multiRepoBlocked.wrapper-git
  → "v1 多仓任务不支持 wrapper-git 节点；请回到工作流编辑器移除，或改用单仓启动"
  → "wrapper-git nodes are not supported in multi-repo tasks (v1); remove them in the editor or launch with a single repository"
launch.repoSource.multiRepoBlocked.upload
  → "v1 多仓任务不支持 multipart 上传输入；请回到工作流编辑器移除上传节点，或改用单仓启动"
  → "multipart upload inputs are not supported in multi-repo tasks (v1); remove them in the editor or launch with a single repository"
launch.repoSource.maxReached
  → "已到达单任务最多 {{max}} 个仓的上限" / "Reached the maximum of {{max}} repos per task"
tasks.multiRepoSummary                → "{{count}} 个仓库" / "{{count}} repositories"
tasks.multiRepoRepoLine               → "{{dirName}} @ {{baseBranch}}" / 同
errors.start-task-source-conflict     → "不能同时传 legacy repoPath/repoUrl 与 repos[]"
                                       / "cannot mix legacy repoPath/repoUrl with repos[]"
errors.multi-repo-wrapper-git-unsupported / errors.multi-repo-upload-unsupported
```

---

## 5. 测试矩阵

总目标：**新增 ≥ 80 case；现有套件零退化**。

### 5.1 shared 层（`packages/shared/tests`）

| # | 文件 | 重点 |
|---|------|------|
| S1-S3 | `start-task-schema-multi-repo.test.ts` | 合法 legacy body 通过 / 合法 v2 body 通过 / legacy + v2 mix → 拒 + code `start-task-source-conflict` |
| S4-S5 | 同上 | v2 单行的 path/url 互斥校验 / v2 空 repos[] 拒 |
| S6-S7 | 同上 | `repos.length > MULTI_REPO_MAX` 拒 / `MULTI_REPO_MAX = 8` 常量字面量锁 |
| S8-S9 | `task-repo-schema.test.ts` | TaskRepoSchema parse happy / reject |
| S10-S12 | `prompt-multi-repo-vars.test.ts` | `renderUserPrompt` 渲染 `{{__repos__}}` / `{{__repo_names__}}` / `{{__repo_count__}}` 三占位符；缺占位符不出错 |

### 5.2 backend 层（`packages/backend/tests`）

| # | 文件 | 重点 |
|---|------|------|
| B1-B3 | `migration-0034-task-repos.test.ts` | 表存在 + 索引 + backfill 单行 / `tasks.repo_count` 列默认 1 / `node_runs.pre_snapshot_repos_json` 列存在 |
| B4-B5 | `upgrade-rolling.test.ts` | journal HEAD count 33→34；老路径仍 apply |
| B6 | `start-task-legacy-byte-baseline.test.ts` | legacy body → `tasks` 行字段 / DB 状态 / WS 广播 / events 与今天**字节级一致** |
| B7-B9 | `start-task-multi-repo-materialize.test.ts` | 2 个 path-mode 仓 → 父目录 + 两子 worktree 存在 / 每仓 branch 相同 / `task_repos` 两行 |
| B10 | 同上 | 2 个相同 basename → 第二个加 `-2` 后缀 |
| B11 | 同上 | 3 个仓里第二个加 worktree 失败 → 整 task 状态 failed、第一个仓 worktree 不留尾巴（清理） |
| B12 | 同上 | URL + path 混合 N=2 |
| B13 | `start-task-multi-repo-gates.test.ts` | workflow 含 wrapper-git + repos.length>1 → 422 + `multi-repo-wrapper-git-unsupported` + `wrapperGitNodes` 在 detail |
| B14 | 同上 | workflow 含 upload input + repos.length>1 → 422 + `multi-repo-upload-unsupported` |
| B15 | 同上 | repos.length==1 + wrapper-git → 通过（v1 不动单仓行为） |
| B16-B18 | `task-diff-multi-repo.test.ts` | 单仓 baseline 字节守恒 / 多仓拼接两段 + header / 1 MiB 截断 + truncated:true |
| B19-B21 | `resume-multi-repo-rollback.test.ts` | 多仓写 `pre_snapshot_repos_json`，resume 时每仓独立 rollback；单仓继续读 `pre_snapshot` |
| B22-B24 | `scheduler-template-multi-repo.test.ts` | scheduler 把 `meta.repos[]` 传给 runner / runner 调 renderUserPrompt 渲染三个新占位符 |
| B25 | `task-cancel-multi-repo.test.ts` | cancel 多仓 task → controller abort，行 status 转 canceled，每仓 worktree 保留 |
| B26-B27 | `gettask-multi-repo.test.ts` | `getTask` 返回的 task.repos 长度匹配 / 顺序按 repo_index 升序 |
| B28-B30 | `start-task-multi-repo-source-isolation.test.ts` | wrapper-fanout / clarify / review 节点在多仓 task 下零退化（pick 3 高 RFC-060 / RFC-056 fixture，多仓化跑一遍） |

### 5.3 frontend 层（`packages/frontend/tests`）

| # | 文件 | 重点 |
|---|------|------|
| F1-F3 | `launch-repo-source-list.test.tsx` | 默认渲染 1 行无 `−` / 点 `+` 加行 + `−` 出现 / 点 `−` 删行回退 |
| F4-F5 | 同上 | 加到 MULTI_REPO_MAX → `+` 按钮 disabled + 提示 |
| F6 | `launch-repo-source-list.test.tsx` | basename 冲突时预览 chip 显示 `-2` |
| F7-F8 | `launch-buildbody-multi-repo.test.ts` | 1 行 → `buildLaunchBody` 兜底（legacy 体）；2 行 → `buildLaunchBodyV2` 输出 `repos:[...]` |
| F9-F10 | `launch-multi-repo-gates.test.tsx` | workflow 含 wrapper-git + 2 行 → banner 出现 + Start disabled / 含 upload + 2 行 → banner 出现 |
| F11 | `task-detail-multi-repo-header.test.tsx` | 多仓 task header 渲染 N repos summary 与每仓行；单仓 task baseline 锁不渲染 |
| F12 | `i18n-multi-repo-keys.test.ts` | 10 个新 key cn/en 对称、不含占位符 leak |
| F13 | `launch-task-name-submit-paths.test.ts`（既有） | 单仓 form data 行为 byte-for-byte 不变（regression lock） |

### 5.4 e2e（`packages/frontend/e2e`）

| # | 文件 | 重点 |
|---|------|------|
| E1 | `multi-repo-launch.spec.ts` | 选 2 仓 → 启动 → assert 两个子 worktree 存在 + cwd 为父目录 + 任务详情 header 显示两仓 |
| E2 | 同 spec | 多仓 + wrapper-git workflow → Start 禁用，banner 文案锁定 |

### 5.5 守门（grep）

| # | 文件 | 锁定 |
|---|------|------|
| G1 | `tests/source/start-task-single-path-baseline.test.ts` | `services/task.ts` 中 single-path 分支必须存在标识注释 `// RFC-066: single-path byte-baseline branch`；防 multi-path 改动顺手把 single 分支删了 |
| G2 | 同上 | `RepoSourceList` 不复用 `RepoSourceTabs` 旧 default export 名（避免类型偏移） |
| G3 | 同上 | `materializeWorktree` 单仓调用方不传 `overrideWorktreePath`（grep 守门） |

---

## 6. 风险 / 兼容性 / 回退

- **回退**：单 PR 完工后回滚 commit + rollback migration 0034（DROP
  `task_repos` + DROP COLUMN）。多仓 task 的 task_repos 行随 DROP 一起
  消失，旧单仓 task 的字段未动；前端 multi-repo UI 回到单行模式。
- **数据兼容**：migration 0034 仅 **ADD COLUMN + CREATE TABLE +
  INSERT FROM**，无 DROP / 无重命名，纯 additive；老 daemon 读到带新
  列 / 表的 DB 不会崩（drizzle schema 列声明默认 nullable / DEFAULT
  1）。
- **API 兼容**：
  - 旧 client（只发 legacy body）→ server normalize 后 `repos.length=1`，
    走 single-path；DB 写 `repo_count=1` + `task_repos[0]` 行；老 client
    GET `/api/tasks/:id` 拿到的 JSON 多了 `repoCount`/`repos` 字段，老
    Zod schema 默认忽略未知字段，零破坏。
  - 新 client 发 v2 body 时如果遇到老 server（未上 RFC-066），server
    Zod 拒 `repos` 字段返回 422 — 由前端 deploy 顺序保证（先后端再前
    端）。
- **e2e fixture**：`e2e/fixtures/stub-opencode-*.sh` 不感知多仓；多仓
  e2e 跑同一个 stub，cwd 是父目录但 stub 不读 cwd，零改动。
- **RFC-067（task git identity）兼容**：RFC-067 已收口为**纯 env 注入**
  （`runner.ts` spawn 时设 `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` /
  `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` 四件套，**不写**
  worktree `.git/config`），原因是 worktree config 在并发同仓 task 间
  会互相覆盖。env 是 opencode 子进程级、对 cwd 下**任何**子目录的
  `git commit` 都生效——RFC-066 多仓 cwd = 父目录、各子仓 `git commit`
  仍能读到这四个 env，**身份自动跨仓共享，本 RFC 零额外代码**。本 RFC
  不写 `git config`、不引入 per-repo 身份循环。
- **RFC-064（Unified Clarify Runtime）migration 编号协调**：RFC-064
  PR-B T9 与本 RFC PR-A T2 都曾规划落 `migration 0033`，但 RFC-067 已
  先落 `0033_rfc067_task_git_identity`（journal idx=32）占用编号。**本
  RFC 现顺延为 migration 0034**（journal idx=33）；RFC-064 若后落需顺
  延 0035 或视情况再排。两边 plan.md 都要求 PR 提交前 grep
  `migrations/00NN_` 防撞，本 RFC plan.md T2 已含「落 PR 前 grep 防撞
  号」步骤。代码层无冲突：
  RFC-064 改 `services/clarify.ts` + scheduler clarify 分支 + DROP
  `node_runs.cross_clarify_iteration`；本 RFC 改 `services/task.ts` +
  scheduler `templateMeta` + ADD `node_runs.pre_snapshot_repos_json`，
  即便同改 `node_runs`，是不同列的 additive ALTER，无 schema 冲突。
- **RFC-065（worktree-files tab）自然兼容**：RFC-065 把 `task.
  worktreePath` 当树根列举 + 用 `realpath` 守门越界。多仓时根 = 父
  目录、列出 N 个子仓 sub-dir，用户展开每个看到该仓内容；`.git/` 隐藏
  规则递归对每个子仓内的 gitlink（`.git` 文件）同样生效；越界检查的
  边界是父目录，子仓互相之间的 symlink 合法、跳出父目录的 symlink 被
  拒。本 RFC 零额外工作。**唯一小 UX nuance**：RFC-065 根级排序走「目
  录优先 + `localeCompare`」固定规则，**不**按 `task_repos.repo_index`
  添加顺序——用户在任务详情 multi-repo summary header（本 RFC §4.3）
  仍能看到添加顺序，所以不修。

---

## 7. 待办（PR 拆分见 plan.md）

整个 RFC 拟 3 PR 强序：

- **PR-A**：shared + DB + backend 多仓 startTask + 单仓 baseline 锁。
- **PR-B**：scheduler/runner template var + diff + resume per-repo
  rollback + 多仓 wrapper-git/upload gate（运行时兜底）。
- **PR-C**：前端 RepoSourceList + 路由层接线 + 详情 header + e2e。

详见 [plan.md](./plan.md)。
