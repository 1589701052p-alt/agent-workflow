# RFC-066 — 多仓库任务启动（Multi-Repo Task Launch）

## 背景

`/workflows/$id/launch` 当前只允许选 **单个仓库** 作为任务工作目录：

- `RepoSourceTabs.tsx`（`packages/frontend/src/components/launch/RepoSourceTabs.tsx`）
  二选一 Local Path / Remote URL，单个 `repoPath` 或 `repoUrl` + `baseBranch`/`ref`。
- 后端 `StartTaskSchema`（`packages/shared/src/schemas/task.ts:104-167`）字段
  `repoPath` 与 `repoUrl` 互斥，二者只能一选一。
- `services/task.ts:material­izeWorktree` 只支持单 repo `git worktree add`，
  产物落到 `~/.agent-workflow/worktrees/{repoSlug}/{taskId}/`，整条 task
  的 cwd = 这个目录。
- 整个调度器 / runner / wrapper-git / diff 端点 / resume / retry 都以
  「`task.worktreePath` == 单一 git worktree」为隐含前提。

但实际编排场景里，**Code → Audit → Fix** 经常需要 worker 同时操作多个
仓——典型案例：审计仓 A 的 PR 影响、引用仓 B 里的运行时实现做交叉对照、
顺手 sync 仓 C 的 schema 文档。今天用户只能：

- 把多个仓的代码手动拷进一个临时目录，**失去 git worktree 语义**（没法
  diff / 没法 rollback / 没法被 wrapper-git 用）；或
- 把每个仓单独立成一个 task，**丢失同上下文跨仓推理能力**（agent 在
  task A 里看不到 task B 的状态）。

这次给启动表单 + 后端运行时正式补一个 **N 仓任务** 能力：单仓时行为字
节级不变；多仓时 cwd 升级为「父工作目录」，每个仓平铺成 cwd 下的一个
独立 git worktree 子目录。

## 目标

- `/workflows/$id/launch` 表单支持在 **1..N 个 repo** 之间动态增减：
  - 默认 1 行（与今天一致），不显示「−」按钮。
  - 旁边永远显示一个「**+** 增加仓库」按钮。
  - 增加到 2 行以上时，每行右侧出现「**−** 删除此仓」按钮（删到剩 1 行
    时按钮再次隐藏）。
  - 每行内部沿用现有 `RepoSourceTabs` 的 Local Path / Remote URL 二选
    一 + baseBranch/ref picker；行与行之间相互独立。
- 任务工作目录布局：
  - **单仓**（`repos.length === 1`）：cwd = 该仓的 git worktree，
    路径与今天完全一致：`~/.agent-workflow/worktrees/{repoSlug}/{taskId}/`。
    **字节级保 baseline**（包括 `task.worktreePath` 列值、`tasks.repoPath`、
    `tasks.branch`、子目录布局、cwd 传递、wrapper-git 行为）。
  - **多仓**（`repos.length > 1`）：cwd = 新引入的 **父工作目录**
    `~/.agent-workflow/worktrees/multi/{taskId}/`；每个仓在父目录下平
    铺成一个子目录 `<basename>/`，子目录本身是该仓的 `git worktree add`
    产物（分支同为 `agent-workflow/{taskId}`，每个仓相互独立）。
  - 子目录命名 = `basename(repoPath)` 或 `basename(parseGitUrl(url))`；
    同 task 内两个仓 basename 冲突时**自动追加数字后缀** `-2` / `-3`
    ...（用户在表单里能看到预览名）。
- 单/多仓 task 状态管理统一：每个仓挂在新表 `task_repos` 上（详见
  design.md §3）；`tasks` 表保留 `repo_path` / `worktree_path` /
  `base_branch` / `branch` / `base_commit` / `repo_url` 列作为
  **`task_repos[0]` 的镜像**（保 REST / WS / 前端 legacy 字段不破）。
- opencode 子进程的 cwd 永远等于 `tasks.worktree_path`——单仓时是
  仓自身的 worktree，多仓时是父目录，**完全靠 schedule/runner 现有 cwd
  路径，零侵入**。
- 模板变量：现有 `{{__repo_path__}}` / `{{__base_branch__}}` 保留指向
  `repos[0]`（向后兼容）；新增 `{{__repos__}}`（每行一个 worktree 绝
  对路径）、`{{__repo_names__}}`（每行一个子目录 basename）、
  `{{__repo_count__}}`（数量字符串）让 prompt 模板能显式访问多仓信息。

## 非目标

- **不**在 v1 让 `wrapper-git` 节点跨多仓工作。多仓 task 内只要工作流
  含 `wrapper-git`，启动时 422 拒绝；运行时也不会触发到 `wrapper-git`
  分支。文案明确告诉用户「v1 多仓不支持 wrapper-git」。
- **不**在 v1 支持 **multipart 上传 + 多仓** 组合：与今天 URL+upload
  的 422 处理风格一致，提示用户「多仓 + 上传 v1 暂不支持」。
- **不**自动 merge 各仓的 `.opencode/` 子目录到父 cwd 下。**opencode 配
  置发现**沿用其源码行为（`packages/opencode/src/config/paths.ts:23`：
  从 cwd 向上 walk 找 `.opencode`），多仓时 cwd 是父目录、各仓的
  `.opencode/` 落在子目录里、opencode 不会 walk 进去——这是 v1 已知
  trade-off，靠现有 `OPENCODE_CONFIG_CONTENT`（agent 注入）+
  `OPENCODE_CONFIG_DIR`（managed skills 注入）两条路径继续工作。文档
  化登记，UI 内不弹警告（避免过度噪声）；未来 RFC 可补 merge 逻辑。
- **不**在 v1 改 `tasks.worktree_path` 列的 schema（继续是 NOT NULL
  TEXT），只是 **语义**变化（多仓时存父目录路径）。
- **不**改 `recent_repos` 与 `cached_repos` 的表结构；多仓时分别对每个
  仓 upsert / resolve（仓与仓互不引用）。
- **不**在 v1 引入「仓权限」「仓只读 / 可写」「仓优先级」等元数据——
  task_repos 行的 `repo_index` 仅用于稳定排序与 `repos[0]` 镜像选择。
- **不**改 task cancel / GC / 软删等生命周期路径的对外行为：cancel 仍
  是单一控制器，GC 仍按 task id 清整个 worktree 目录树。
- **不**改 `/api/tasks/:id/worktree-files/*` 旧路由（reviews 图片回查）；
  RFC-065 即将上线的 `worktree-tree` / `worktree-file` 也只读 cwd 根，
  多仓时用户能看到 `repo-a/` `repo-b/` 等子目录正常展开（不增加 v1
  工作量）。
- **不**新增第二种「diff」表达形式：`GET /api/tasks/:id/diff` 多仓时返
  回 **每仓 1 段、用 `# === Repo: <basename> ===` 分隔**的拼接 diff
  文本，单仓字节级保 baseline；前端 DiffViewer 自然识别 hunk header。

## 用户故事

1. **跨仓 Code → Audit → Fix**：用户启动一个 task，加 3 个仓（前端 +
   后端 + 共享库），worker agent 在 cwd 下看到 `frontend/`、`backend/`、
   `shared/` 三个子目录平铺，可以在 prompt 模板里把任意子目录写进
   `cd backend && bun test`；auditor 拿到的 `task.diff` 是三仓 diff 拼
   接、按子目录标头清晰分块，能挑出涉及哪个仓哪个文件。
2. **错填一个仓，删一行换**：用户在表单里加了 5 个仓，第 3 个仓路径写
   错，点该行右侧「−」按钮删掉，剩 4 个继续；其他 4 个仓 baseBranch /
   ref 选择不丢。
3. **回退到单仓**：用户加了 2 个仓，又点「−」删掉第 2 个，表单回到默
   认 1 行状态，「−」按钮再次隐藏；提交的 task 完全走单仓 path
   （`task.worktreePath` 还是 `{repoSlug}/{taskId}`、`task_repos` 行
   `repo_index=0` `worktree_dir_name=''`）。
4. **basename 冲突**：用户加了 `/foo/utils` 与 `/bar/utils`，预览面板里
   第 2 行显示「将挂载为 `utils-2/`」；用户接受默认或选择删掉一个。
5. **wrapper-git 误用拦截**：用户用一个含 `wrapper-git` 节点的工作流
   尝试启动 3 仓 task，Start 按钮 disabled 并显示 banner「v1 多仓任务
   不支持 wrapper-git；请回到工作流编辑器移除或改用 1 仓启动」。
6. **多仓 resume**：3 仓 task 跑到中间失败；用户点「Resume」，scheduler
   按 `node_runs.pre_snapshot_repos_json` 对每个仓分别 `rollbackToSnapshot`
   到该 run 的前置快照（每仓一个独立 stash sha），然后从失败处续跑。

## 验收标准

1. ✅ `StartTaskSchema` 接受两种 body 形态：
   - **legacy**（单仓兼容）：`{ workflowId, name, repoPath, baseBranch,
     inputs, ... }` 或 `{ workflowId, name, repoUrl, ref?, inputs, ... }`，
     效果同今天，**字节级 baseline 保留**（DB 行 / WS payload / API
     响应 / 前端 fixture 比对全过）。
   - **v2**（多仓）：`{ workflowId, name, repos: [{ repoPath?, repoUrl?,
     baseBranch?, ref? }, ...], inputs, ... }`，`repos.length` ∈ [1, 8]。
   - 两种 body 同时给 → 422 `start-task-source-conflict`。
   - `repos` 数组里同时有 `repoPath` 与 `repoUrl` / 都没有 → 422 与现有
     单仓校验保持同 code。
2. ✅ `repos.length === 1` 时，server side 必走「单仓代码路径」：
   `tasks.worktreePath = ~/.agent-workflow/worktrees/{repoSlug}/{taskId}`，
   不进入 `multi/` namespace、不写 `task_repos.worktree_dir_name`（保持
   空串），与今天的字段、目录布局、cwd 完全字节级一致。
3. ✅ `repos.length > 1` 时：
   - `tasks.worktreePath = ~/.agent-workflow/worktrees/multi/{taskId}`；
     **目录初始化为空**（启动期间由 framework 创建）。
   - 每个仓在 `task_repos[i]` 落一行，`worktree_path =
     ~/.agent-workflow/worktrees/multi/{taskId}/{wt-dir-name}`，
     `worktree_dir_name` 已通过冲突解决填好（`utils` / `utils-2` /
     `utils-3` ...）。
   - 每个仓在自己 source repo 上 `git worktree add -b agent-workflow/{taskId} <wt-path> <baseCommit>`；同一 taskId 的分支名可重用因为各源仓独立。
4. ✅ 任意 opencode 子进程的 cwd 都等于 `task.worktreePath`（runner 现
   有逻辑无需改）；template var `{{__repo_path__}}` 渲染为
   `task_repos[0].repo_path`，`{{__base_branch__}}` 渲染为
   `task_repos[0].base_branch`，新增三个变量按 §设计渲染。
5. ✅ `GET /api/tasks/:id/diff` 单仓 byte-for-byte 不变；多仓返回拼接
   diff（每仓一段、首行 `# === Repo: <wt-dir-name> ===`），1 MiB 总上
   限不变；`truncated: true` 当总 size 超阈值。空 diff 仓被略过（不出
   现该段 header）。
6. ✅ `POST /api/tasks/:id/resume` 多仓时按 `pre_snapshot_repos_json`
   分别 rollback 每仓；单仓时继续读 `pre_snapshot` 单 sha，行为不变。
7. ✅ 启动期间 workflow 含 `wrapper-git` 且 `repos.length > 1` → 422
   `multi-repo-wrapper-git-unsupported`，错误体里枚举命中的 nodeId。
8. ✅ workflow inputs 含 `kind: 'upload'` 且 `repos.length > 1` → 422
   `multi-repo-upload-unsupported`。
9. ✅ 前端 `RepoSourceList` 默认渲染 1 个 `RepoSourceRow`，无「−」按钮；
   点「+ 增加仓库」追加一行；多于 1 行后每行右侧出现「−」；删到 1 行
   后「−」再次隐藏。Start 按钮 disabled 条件 = 任一行未填齐 / 命中
   wrapper-git 或 upload 多仓 gate。
10. ✅ 多仓提交时 `buildLaunchBody` 输出 `{ ..., repos: [...] }`，单仓
    提交（即用户没点过「+」）输出与今天完全一致的 `{ ..., repoPath?,
    repoUrl?, baseBranch?, ref?, ... }` 形态，**老测试 / 老 e2e fixture
    零改动**。
11. ✅ `recent_repos` 多仓时对每个 path-mode 源仓 upsert；`cached_repos`
    对每个 URL-mode 源仓 resolve；UI 列表后续看到所有源仓。
12. ✅ 既有 task 列表 / 详情 / 看板 / 诊断 / 反问 / 审阅等全部页面对单
    仓 task 字段渲染 byte-for-byte 不变；对多仓 task，详情页 header
    新增「N repos」chip + 折叠出每仓 `<basename> @ <baseBranch>` 行，
    不破当前布局（视口铺满锁不动）。

## 影响范围

- **后端**：
  - 新表 `task_repos`（design §3）+ migration 0034（含 1-行 backfill 现
    有 tasks → `task_repos.repo_index=0`）。
  - `node_runs` 新列 `pre_snapshot_repos_json TEXT NULL`。
  - `services/task.ts` `material­izeWorktree` 拆出 `materializeMultiRepoWorktrees`；
    `startTask` 接受 `StartTask.repos[]`、按数量分支。
  - `services/scheduler.ts` template var 扩展（`{{__repos__}}` 等）。
  - `services/runner.ts` 不动 cwd 处理；prompt template render 通过新增
    `templateMeta.repos` 字段拿到多仓信息。
  - `routes/tasks.ts` JSON body 接受 v2 形态；422 wrapper-git / upload
    多仓 gate；diff 端点多仓拼接。
  - `services/task.ts` resume 路径支持 `pre_snapshot_repos_json`。
  - `services/repo.ts` `upsertRecentRepo` 在多仓时每仓调用一次。
- **shared**：
  - `StartTaskSchema` 加 `repos` 字段（兼容老字段）。
  - `TaskSchema` 加 `repos: TaskRepo[]`（每行字段对齐 DB 列；UI 渲染）。
  - 新增 `TaskRepoSchema`、`StartTaskRepoSchema`。
  - 模板渲染 helper `renderUserPrompt` 在 `shared/src/prompt.ts` 加新
    占位符（三个）；保持现有 placeholder 不变。
- **前端**：
  - 拆 `RepoSourceTabs.tsx` 内部 markup 抽出为 `RepoSourceRow.tsx`（per-
    repo 子组件）；新增 `RepoSourceList.tsx`（容器 + +/− 按钮）。
  - `routes/workflows.launch.tsx` state 从 `source: RepoSource` 改成
    `repos: RepoSource[]`（默认长度 1）；buildLaunchBody 按长度分流。
  - 添加 wrapper-git / upload 多仓 gate banner 与 disable Start 逻辑。
  - 任务详情 header 新增 multi-repo chip + 列表（折叠/展开）。
  - i18n：~10 个新 key（cn/en 对称）。
  - `styles.css` 加 `.repo-source-list` / `.repo-source-row` 等命名空间。
- **schema / migration / runtime**：1 migration（task_repos + node_runs
  新列），无 runtime 大动；scheduler/runner 仅参数化扩展。

## 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 多仓 schema 改动较深、回退困难 | 整改 migration 0034 仅 **新增**（CREATE TABLE + ALTER ADD COLUMN）+ 1 行 backfill，旧表无破坏；回滚 = 不读新列即可，已存在的多仓 task 数据保留但不被消费。 |
| `task.repoPath` / `task.worktreePath` 列在多仓时语义不再「字面」 | 保留为 `task_repos[0]` 镜像，**单仓字节级不变**；多仓时这些列仍是合法路径（父目录 / 主仓基底），不破 legacy 调用方。前端如需「真值多仓」用新 `task.repos[]`。 |
| basename 冲突自动后缀让用户惊讶 | UI 行内 inline preview「将挂载为 `<dir-name>/`」实时显示，提交前用户能看到、能改顺序或删行调整。 |
| 多仓 wrapper-git 路径有人误依赖 | 启动期 422 提前拦截，不进入运行；workflow 编辑器现有 wrapper-git 节点不动。RFC-066 v2 可移除该 gate。 |
| 多仓 cwd 不在 git repo 里，agent 跑 `git status` 报错 | 由 agent 提示词显式约束（`{{__repo_names__}}` 让用户知道要 `cd` 进具体子目录）；属于产品教育，不在 framework 强制范围。 |
| 多仓 8 上限不够 | 写在 settings `multiRepoMaxCount`（默认 8）；用户改大需注意 `git worktree add` 并发与 submodule init 资源占用。 |
| 多仓 resume 单仓 stash 数据格式漂移 | `node_runs.pre_snapshot_repos_json` 是新列，单仓继续写老 `pre_snapshot`；resume 先看新列、再 fallback 老列；老 task resume 完全不变。 |
| 多仓 task GC 残留 | `~/.agent-workflow/worktrees/multi/{taskId}/` 整个目录树挂在 `tasks.worktreePath` 之下，现有 GC 路径（按 task id 删 worktreePath）自然把它带走，无新增清理工作。 |
| 多仓 task 与 `worktree-files` 路由（RFC-065）交互 | RFC-065 列举 cwd 子项，多仓时根列出 `repo-a/` / `repo-b/`，用户能正常展开；零额外工作。 |

## 不走 RFC 的部分

- 「workflow 编辑器内对 wrapper-git 节点显式标注多仓不兼容」属于 UX 修
  缮，可在本 RFC PR-C 顺手做，但不单独立 RFC。
- 模板变量新增的三个占位符（`{{__repos__}}` / `{{__repo_names__}}` /
  `{{__repo_count__}}`）作为 RFC-066 一部分实现；不再单立小 RFC。

## 与其它 RFC 的关系

- **RFC-024** Git URL 源：本 RFC 在每个 repo 行复用 `resolveCachedRepo`
  逻辑，多仓 URL 模式同样走 cached_repos 缓存，零冲突。
- **RFC-034** submodule init：每个仓独立调用 `syncSubmodules`，每仓自
  己的 submodule init 失败仅警告该仓，不影响其它仓。
- **RFC-060** wrapper-fanout：fanout sharding 与多仓正交——shard 仍按
  `list<path>` 散开；多仓 task 内 list<path> 元素的路径需要带上子目
  录前缀（agent 自己约束，framework 不强校验）。
- **RFC-064** Unified Clarify Runtime：与本 RFC **无代码冲突**——RFC-064
  只动 `services/clarify.ts` + scheduler clarify 分支 + `node_runs.
  cross_clarify_iteration` 列 DROP；本 RFC 动 `services/task.ts` +
  scheduler `templateMeta` + `node_runs.pre_snapshot_repos_json` 列 ADD。
  **唯一接触点是 migration 编号**：RFC-064 PR-B 与本 RFC PR-A 都规划
  曾共同规划 migration 0033，**RFC-067 已先落 0033**（journal idx=32）；
  本 RFC 顺延 **migration 0034**（journal idx=33），RFC-064 PR-B 若后
  落需顺延 0035 或视情况再排；两边 plan.md 都要求 PR 提交前 grep 编号
  防撞。落地顺序由用户决定。
- **RFC-065** worktree-files tab：新 tab 列举 `task.worktreePath` 子项，
  多仓时根目录是父目录、按 sub-dir 自然展开、`.git/` 隐藏规则递归对每
  个子仓内的 gitlink 同样生效、`realpath` 越界守门把父目录当根边界、
  5000 项截断永不触发（根仅 N ≤ 8 子目录）——**本 RFC 零额外工作**。
  一处小 UX nuance：根级排序走 RFC-065 既有规则（目录优先 + `localeCompare`
  升序），与用户在表单里**添加顺序**（`task_repos.repo_index`）不一定
  一致；添加顺序在任务详情 multi-repo summary header 仍可看到，所以
  不修。
- **RFC-067** Task Git Identity：纯 env 注入（`runner.ts` 设
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*`），env 跨子目录天然生效，多仓零额
  外代码。详见 design §6。
- **RFC-005 / RFC-053** review / resume：review 节点不直接访问仓数据，
  受影响极小；resume 路径已覆盖（per-repo rollback）。
