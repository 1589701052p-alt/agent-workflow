# RFC-068 — 启动任务前同步 base branch 到远端最新

## 背景

当前 task 启动流程（`services/task.ts:205` `startTask` →
`materializeWorktree` → `util/git.ts:198` `createWorktree`）选择 base ref
后直接 `git rev-parse <base>` 拿 commit、然后 `git worktree add -b
agent-workflow/{taskId} <path> <baseCommit>`。两个模式都存在"任务跑的不
是最新代码"问题：

### 路径模式（用户本地仓 `repoPath`）

`resolveRepoSource`（`services/task.ts:179`）pass-through 用户给的本地路
径，**完全不跑 fetch / pull**。base 默认是 `currentBranch(repoPath)` 当下
指向的 commit，远端 origin/<branch> 有没有新 commit 框架完全不管。

### URL 模式（平台维护 mirror cache）

`resolveCachedRepo`（`services/gitRepoCache.ts:211`）的 warm path 默认
`fetchOnReuse=true`，会跑 `git fetch --all --prune --tags`
（`gitRepoCache.ts:245`）。但 `git fetch` 的语义是：

- **只**前进 `refs/remotes/origin/*`；
- **不动** 本地 branch（`refs/heads/*`）；
- **不动** mirror 的工作目录文件。

而 `createWorktree` 用 `git rev-parse <base>` 解析的是**本地** branch 的
sha（`util/git.ts:209`，`base = opts.baseBranch ?? currentBranch(...)`，
形如 `main` 而非 `origin/main`）。结果：URL 模式 fetch 了一通，但只要用
户没显式把 base 改成 `origin/<branch>`，rev-parse 拿到的依然是 mirror
clone 那一刻的旧 commit、worktree 物化出的工作目录文件也是旧的。

### 用户可观察的后果

- 本机已经 `git push` 了新 commit 到远端，半小时后用同一 URL 启动 task，
  worktree 里看到的是半小时前的代码——agent 改完发现底层文件版本不对、
  conflict / rebase 阶段才暴露。
- 多人协作：队友 push 了新 commit，本地 task 启动后 agent 在旧 base 上
  做事，后续 merge 冲突放大、review 困难。
- 文档 / 用户教学要解释一句"想要最新得手动选 origin/main"才能工作，与
  "把代码扔给平台，平台自己管 worktree"的产品直觉相悖。

## 目标

- **URL 模式（mirror）**：启动 task 选择 base 是 branch 名（而不是 tag /
  sha / `origin/X` 这种已经显式指向远端的 ref）时，框架在 worktree 物化
  **之前**把 mirror 的本地 `refs/heads/<base>` fast-forward 到
  `refs/remotes/origin/<base>`，保证 worktree checkout 出来的是远端最新
  commit。
- **路径模式（用户本地仓）**：默认保持现状（不动用户本地 ref / 工作目
  录）。新增 launcher 上的 opt-in 开关「启动前 fetch 远端 ref」：勾上
  后启动前只跑 `git fetch --all --prune --tags`（**不**触发 `pull` /
  `merge`），用户随后可以选 `origin/<branch>` 作为 base ref；不勾走原
  逻辑。
- 失败永远降级而不是阻断启动：fetch 失败 → WARN + 用现有 ref；
  fast-forward 失败（理论不可能，因为 mirror 不接受人工 commit；兜底）
  → WARN + 退回 origin/<branch> 作为 base。
- 单仓 / 多仓（RFC-066 落地后）行为对称。

## 非目标

- **不在 path 模式下替用户 pull/merge** 当前 branch。用户工作目录是用户
  的，框架替它 `git pull` 撞 hook / 未提交修改 / 拉错 remote 的风险面太
  大，永远 opt-in 也只到 fetch。
- **不在 URL 模式下改 fetch on reuse 默认值**（仍是 true）。FF 是 fetch
  之后的额外动作，不是替代。
- **不引入"启动时强制 rebase / merge"** 这种语义。worktree 从一个具体
  commit 拉出新 branch 即可，agent 自己跑的 commit 是后续事，与 base 同
  步无关。
- **不动 tag / commit sha base** 的语义。这两类 ref 选了就是要那个具体
  对象，FF 不适用。
- **不动 cache repo 的工作目录文件**。运行时只用 worktree，mirror 工作
  目录从来不被读，所以 FF 不需要 `git checkout`，只需要 `git update-ref`，
  对其他正在跑的 worktree 零影响。

## 用户故事

### US-01：URL 模式典型路径

- 我在 launcher 输入 `git@github.com:foo/bar.git`，base ref 留空（默认
  `main`）。
- 远端 origin/main 已经比我上次启动时新了 17 个 commit。
- 我点启动。框架自动 fetch + 把 mirror 的 `refs/heads/main` 推到
  `refs/remotes/origin/main`、用这个新 sha 物化 worktree。
- 我打开任务详情 → worktree files tab，看到的是远端最新代码。

### US-02：URL 模式选 tag / sha base

- 我在 launcher 选 base ref `v2.3.0`（tag）或 `a1b2c3d`（sha）。
- 框架照常 fetch（拿到最新 tag），但**不**对 tag / sha 做 FF。
- worktree 物化出的就是那个具体 commit。

### US-03：路径模式默认行为（不变）

- 我在 launcher 选本地路径 `~/code/foo`，base 留空（默认当前 branch）。
- 框架**不** fetch、**不** pull，base = `~/code/foo` 当下 HEAD。
- 行为与今天一样。

### US-04：路径模式 opt-in fetch

- 我在 launcher 选本地路径 `~/code/foo`，勾上「启动前 fetch 远端 ref」。
- 框架跑 `git fetch --all --prune --tags`（用户本地仓的工作目录、
  当前 branch ref 不动）；如果失败 → 启动表单显示 warning 但允许继续。
- 我可以在 base ref 下拉里看到 `origin/main` 这种 remote-tracking ref，
  选它作为 base → worktree 物化出的是远端最新。

### US-05：fetch 失败降级

- 远端临时不通（网络抖、auth 失败）。
- URL 模式：fetch 报错 → 框架 WARN + 继续；rev-parse base 用当前 mirror
  状态（worktree 拉的是上次 fetch 时的 sha）。任务能启动。
- 路径模式（opt-in）：fetch 报错 → 启动表单 warning，用户可以重试 / 关
  掉开关继续。

### US-06：FF 收敛失败兜底

- 假设有人手 push 到了 mirror 的 `refs/heads/main`（理论上 mirror 是平
  台独占、不会发生），导致本地 main 与 origin/main 分叉。
- URL 模式：FF 失败 → WARN + 用 `refs/remotes/origin/<base>` 作为 base
  commit；任务照常起。

## 验收标准

### URL 模式

- A1：启动 task 选 default base（或显式 branch 名如 `main`）→ FF 成功 →
  worktree 物化的 baseCommit = fetch 后的 origin/<branch>。新增测试覆盖
  fresh clone、warm reuse 两条路径。
- A2：启动 task 选 `origin/<branch>` 作为 base → 走原 rev-parse 逻辑、
  不触发 FF（已经是 remote tracking）；baseCommit = origin/<branch>。
- A3：启动 task 选 tag / commit sha 作为 base → 不触发 FF；baseCommit =
  rev-parse 那个具体对象。
- A4：fetch 失败 → 任务**仍能启动**（status = running，不是 failed），
  WARN 日志写明降级；baseCommit 取 fetch 前状态。
- A5：FF 失败（mock divergence）→ 任务仍能启动，WARN，baseCommit =
  origin/<branch>。

### 路径模式

- B1：opt-in 开关默认**关**；不勾 → 行为字节级守恒（不 fetch、不动用户
  ref / 工作目录）。
- B2：opt-in 开关勾上 → 启动前跑 `git fetch --all --prune --tags`；
  **不**跑 `pull` / `merge` / `checkout` 任何会动用户当前 branch / 工作
  目录的命令。
- B3：opt-in fetch 失败 → 启动表单 warning，允许继续启动；任务行为退回
  到不 fetch 的状态。

### 多仓（RFC-066 完工后）

- C1：多仓启动 → 每仓独立按上述规则同步（互不阻塞，逐仓 fetch + FF）。
- C2：任一仓 fetch 失败 → 该仓 WARN 但其他仓正常；整体任务能启动。

## OPEN QUESTION（待用户审）

- **OQ1**：URL 模式 base 默认是 mirror 的 `defaultBranch`（裸名）。是否
  在 RFC-068 同步把默认改成 `origin/<defaultBranch>`，让 ref picker UI
  上显式标"远端最新"（教学价值更高，行为等价）？我倾向不改（保持 base
  显示就是 `main`，FF 是后台细节），但开放给你审。
- **OQ2**：路径模式 opt-in 开关的粒度——单次启动选项 vs 全局 settings
  开关（settings.gitFetchOnLaunch=auto/never）？我倾向**单次启动表单上
  的复选框** + 记住上次选择（localStorage / 用户 prefs），不进 settings
  全局开关，因为不同仓的远端访问性差异大。
- **OQ3**：URL 模式 FF 失败的兜底是降级到 origin/<branch>（A5 / US-06）
  还是直接报错让用户看到 mirror 异常？我倾向降级 + WARN，因为这是平台
  独占目录、用户不该被一个理论上不会发生的状态阻断；如果倾向"严格"我
  改成 422。
- **OQ4**：URL 模式 fetch on reuse 默认值 `true` 保持。是否同步加 launcher
  上的「跳过 fetch」开关（用于本地调试时避免来回拉远端）？我倾向**不加**
  这个开关——FF 之前必须先 fetch 才能拿到最新 origin/*，加了用户得理解两
  者的差别才好用；如果用户想"快"，建议直接选 commit sha 作为 base。

## 与既有 / 进行中 RFC 的关系

- **RFC-024**（cached repo 体系）：FF 是 warm path 的增量；冷 clone 不
  需要 FF（clone 本来就是最新）。
- **RFC-034**（submodule 同步）：FF 之后 submodule 不需要额外同步，因为
  `createWorktree` 的 post-`worktree add` `submodule update --init` 阶段
  会基于新 baseCommit 触发。
- **RFC-066**（multi-repo task launch，进行中）：多仓启动时每仓独立走本
  RFC 流程。若 RFC-066 PR-A 先落，本 RFC 的实现复用其 `task_repos`
  per-repo 元数据；否则按单仓物化、RFC-066 落地时把 FF 调用迁移到
  per-repo loop。两 RFC 互不阻塞，按落地顺序决定 wiring 点。
- **RFC-067**（task-git-identity，进行中）：与本 RFC 没有耦合，独立演
  进。

## 估算

约 5-8 工作日（含测试）。比 RFC-066 小一档：核心改动集中在
`services/gitRepoCache.ts` + `services/task.ts` + launcher 表单，无 DB
schema / migration 改动，无 runtime / scheduler 改动。
