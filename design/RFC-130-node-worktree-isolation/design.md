# RFC-130 Design —— 每节点隔离 worktree + 串行合并回收；删除 readonly

> 状态：Draft　配套：`proposal.md` / `plan.md`
> 本文所有 file:line 均为核对过的现网代码位置。

## 0. 术语

| 术语 | 含义 |
|---|---|
| **主树 / canonical worktree** | 任务既有的那个（多仓则每仓一个）git worktree（`~/.agent-workflow/worktrees/{slug}/{task-id}`）。累积任务的未提交改动，是 resume / 输出 / git wrapper diff / auto commit&push / 最终产物的**唯一事实源**（不变量 I-1）。 |
| **隔离树 / isolated worktree** | 每个 node run 派发时新建的临时 `git worktree`，起点 = 派发时刻主树全量状态。opencode 以它为 cwd 并行运行。用完即弃。 |
| **隔离起点快照 / base-snapshot** | 派发时刻主树全量状态（HEAD + 已跟踪改动 + untracked）的一个 commit 对象（pin 防 gc）。隔离树从它 checkout；合并回收时作三路合并的 base。 |
| **合并回收 / merge-back** | node run 成功后，在写锁下把「隔离终态 vs base-snapshot 的 delta」三路合并回主树。 |
| **合并 agent** | 新内置 framework agent，三路合并出真冲突时被派发去解冲突（仿 commit-push）。 |

## 1. 根因（详见 proposal §1）

DAG 并行已在（`scheduler.ts:711` 完成驱动 frontier），但可写节点被**每任务一把、罩住整个 agent 运行**的写锁 `writeSem`（`taskWriteLocks.ts` + `scheduler.ts:1960/4061/4351`）串成一次一个——因为所有节点共用一个主树，并发写互相覆盖、git wrapper diff 快照（`scheduler.ts:4588/4675`）被污染。`readonly` 的唯一价值是让「不写盘」的 agent 跳过写锁真并行。

## 2. 新执行模型总览

**每个 node run 的三段式**（锁序见 §7）：

```
① 快照-派发（持 writeSem，毫秒级）
    base = snapshotFullState(主树)          // 含 untracked，pin 防 gc
    git worktree add --detach <iso> base    // 隔离树（在主 repo 之外，D14）
   释放 writeSem
② 运行（持 globalSem，分钟级；不持 writeSem）
    runNode(cwd = 隔离树)                     // opencode 并行跑
    // 成功：落 node 输出（node_run_outputs）+ 快照 pin node_tree=snapshotFullState(隔离树)
    //       + merge_state='pending-merge'。★status 仍不置 'done'（D15）
   释放 globalSem
③ 合并回收（持 writeSem，毫秒级；冲突时含合并 agent）
    canon_tree = snapshotFullState(主树)     // 可能已被兄弟节点推进
    merged = merge-tree(base, canon_tree, node_tree)   // 内存三路合并
    if 干净:  materialize(主树, merged)
    else:     合并 agent 解（§6）→ materialize 或 awaiting_human
    merge_state='merged'  →★此时才 status='done'（D15）
   释放 writeSem
   弃隔离树（worktree remove + 删 pin ref；node_tree pin 保留供 replay 幂等）
```

**关键**：writeSem 只罩 ①③ 两个**毫秒级**窗口，不再罩住 ② 的多分钟 agent 运行。于是并行度从「可写节点 1」提升到「受 `globalSem`（默认 4）约束的 DAG 并行」。合并回收在**同一把 writeSem 上串行** → 主树的读（快照 base / canon）与写（materialize）互斥，不会撕裂。

**完成门控（D15，防崩溃窗口）**：node run 的 `status='done'` **只在 merge-back 落定后**才置——`deriveFrontier`/`areTransitiveUpstreamsCompleted`（`freshness.ts`）既有的「上游 done 才放行下游」判据因此天然正确：**下游永不在 delta 落主树前被派发**。② 与 ③ 之间崩溃 → 该 run 停在 `merge_state='pending-merge'`（status 未 done、输出+node_tree 已持久化）→ resume 从 pinned `node_tree` **replay merge-back（不重跑 agent）** 再置 done（§10.2）。

**为什么并发正确**：兄弟节点各在自己隔离树写，物理隔离（AC-2）；合并回收串行且以内存三路合并计算，主树永不处于半合并态（§6 冲突也不落半成品，除 awaiting_human 兜底）。第一个完成的兄弟合并回收时主树 == 它的 base（未动过）→ 干净应用；后续兄弟的 base 落后于主树 → 真三路合并，重叠才冲突。

## 3. 数据模型变更

### 3.1 删除 `agents.readonly`

- migration `00NN_rfc130_drop_agent_readonly.sql`：SQLite 12 步表重建删列（照 `0057_rfc115_drop_agent_params.sql` 模板；`readonly` 是 `agents` 表 `schema.ts:27`）。**pre-drop fail-loud 守卫**非必需（删只读列不丢关键语义），但迁移注释标明。
- `AgentSchema`/`CreateAgentSchema`（`shared/schemas/agent.ts:98/165`）、`InventoryAgentSchema`（`shared/inventory.ts:44/138`）删字段。
- 旧 `agent.md` / 导入含 `readonly:` 键 → 降级路由进 `frontmatterExtra`（不丢不报，同 RFC-115 处理旧 `model:` 键；`services/agent.ts` 解析处）。AC-16。

### 3.2 `node_runs` 新增隔离记账列（migration `00NN+1`，纯 ADD COLUMN）

| 列 | 类型 | 用途 |
|---|---|---|
| `iso_worktree_path` | text nullable | 该 run 隔离树绝对路径（**在主 repo 之外**，§4.2 D14）；成功弃后置空。resume / GC 据此清孤立隔离树。 |
| `iso_base_snapshot` | text nullable | base-snapshot sha（单仓）。合并回收 base；也是重试/回滚的「弃隔离树后从主树重新分叉」不依赖项。 |
| `iso_base_snapshot_repos_json` | text nullable | 多仓：`{worktreeDirName: sha}`。 |
| `iso_node_tree` | text nullable | **run 成功时**隔离终态全量快照 sha（pin 防 gc；单仓）。用于**崩溃后 replay merge-back**（无需重跑 agent，§5.1/§10.2 D15）。 |
| `iso_node_tree_repos_json` | text nullable | 多仓：`{worktreeDirName: sha}`。 |
| `merge_state` | text nullable | `null`（未到合并 / 非隔离旧行）/`pending-merge`（agent 成功、输出+node_tree 已落、**尚未合并**）/`merged`/`conflict-resolving`/`conflict-human`。**downstream 就绪门控 + resume 幂等据此**（§5.1 D15）。 |

> 复用既有 `pre_snapshot`/`pre_snapshot_repos_json`？**不复用**——语义不同：`pre_snapshot` = 主树回滚点（`git stash create`，**不含 untracked**）；`iso_base_snapshot` = 隔离树起点（**含 untracked** 的全量快照）。混用会把「回滚主树」和「隔离起点」两个正交概念耦合（RFC-092/098 的回滚仍读 `pre_snapshot`，但新模型下**失败节点不再写主树**，故顶层回滚基本退化，见 §11）。

## 4. 隔离树生命周期

### 4.1 全量快照原语（新增 `util/git.ts`）

`gitStashSnapshot`（git.ts:883）= `git stash create`，**不含 untracked** —— 不能直接当隔离起点（AC-2 要含 untracked）。新增：

```ts
// snapshotFullState: 用临时 index 把「HEAD + 所有已跟踪改动 + 所有 untracked」
// 写成一个 commit 对象，不触碰真 index / worktree / HEAD。pin 防 gc。
export async function snapshotFullState(
  worktreePath: string, opts?: { pinRef?: string; log?: Logger },
): Promise<string> {
  const idx = <tmp index path>
  await runGit(worktreePath, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: idx } })
  await runGit(worktreePath, ['add', '-A'],        { env: { GIT_INDEX_FILE: idx } }) // 含 untracked
  const tree = (await runGit(worktreePath, ['write-tree'], { env: { GIT_INDEX_FILE: idx } })).stdout.trim()
  const sha  = (await runGit(worktreePath, ['commit-tree', tree, '-p', 'HEAD', '-m', 'aw-snapshot'])).stdout.trim()
  if (opts?.pinRef) await runGit(worktreePath, ['update-ref', opts.pinRef, sha])
  return sha
}
```

> **前置：`runGit` 需支持 env 覆盖**（Codex 三轮 P2）：现 `runGit(cwd, args)` 恒注入 `nonInteractiveGitEnv()`、不接受额外 env，上面的 `GIT_INDEX_FILE` 写法**当前签名实现不了**（省略则误触真 index、照抄则不 typecheck）。T1 先给 `runGit` 加可选 `{ env }`（merge 在 `nonInteractiveGitEnv()` 之上），再实现 `snapshotFullState`。
> 与既有 `gitStashSnapshot` 并存（后者仍服务 RFC-092/098 主树回滚，语义不变、零改动）。

### 4.2 创建隔离树

- **路径必须在主 worktree 之外**（D14，Codex 设计 gate P1）：`{appHome}/iso/{taskId}/{nodeRunId}`（单仓）；多仓 `.../iso/{taskId}/{nodeRunId}/{worktreeDirName}`。**绝不放在主 worktree 目录树内**——否则后续兄弟节点 / wrapper 的 `snapshotFullState(主树)` 里 `git add -A` 会把 `iso/...`（一个带 gitlink 的嵌入 worktree）当 untracked embedded repo 暂存进快照树 → 临时隔离树泄漏进产物 / 合并树。放主 repo 之外则 `git add -A` 根本看不到它。写 `iso_worktree_path`。
- **隔离树 HEAD = 任务原始 base HEAD，累积改动作为「未提交工作区状态」铺上**（D23，Codex 三轮 P2「下游 diff 语义」）：**不能**直接 `worktree add <iso> <snapshot-commit>`——那会让上游 A 已合并的改动变成隔离树的**已提交 HEAD**，下游 B 的 `git status`/`git diff HEAD` 对 A 的改动**变干净**，而现状共享树里上游改动是**未提交、可见**的（inspect-diff 型 workflow / prompt 会丢上下文）。改为：
  ```
  git worktree add --detach <iso> <task-base-HEAD>      // HEAD=原始基线 commit（干净）
  git --work-tree=<iso> read-tree <base-snapshot-tree>  // index←累积快照
  git -C <iso> checkout-index -f -a                      // 工作区←累积快照（未提交）
  ```
  于是隔离树 = 「HEAD 原始基线 + 累积改动未提交」，与主树结构一致；`git diff HEAD` 在隔离树里显示累积改动（含 former-untracked），下游 agent 照旧从 diff 看到上游产物。**AC 新增 diff-可见性回归锁**。
- **submodule 初始化（D20，Codex 设计 gate P2）**：`worktree add` **不填充 submodule 工作区**。既有 `createWorktree` 在 add 后跑 `syncSubmodules`（git.ts:396-404，按配置 mode/jobs）；隔离树**必须同样跑**——否则 agent 读/改 submodule 文件会看到空 checkout、产出与主树不一致的树。`createIsolatedWorktree` 内在 add 后调 `syncSubmodules`（或对 `hasSubmodules` 任务显式门控）。合并回收对 submodule gitlink 的处理随 `merge-tree` 语义（gitlink 作为特殊 blob 三路合并）。
- **submodule 脏编辑 = v1 已知限制（D22，Codex 三轮 P2）**：agent **在 submodule 工作区内改文件但不在 submodule 里提交**时，超级项目的 `snapshotFullState`（`git add -A`）**只记录 submodule gitlink、丢弃这些脏文件** → 它们不进 `iso_node_tree` / merge-back → 用户改动丢失。**这是隔离模型对既有共享树行为的回归**（共享树里 submodule 脏文件会持久）。v1 处理：**检测并门控**——对 `hasSubmodules` 任务，若隔离终态快照发现 submodule 工作区有未提交脏改动，**该 node fail-loud（`submodule-dirty-unsupported`）而非静默丢**；**递归 submodule 隔离/合并（每个 submodule 作独立隔离子树三路合并）列为后续 RFC**。proposal 非目标登记。
- pin：`iso_base_snapshot` 同时 `update-ref refs/agent-workflow/iso/{taskId}/{nodeRunId}`，防 base commit 被 gc（照 `snapshotRefName` 惯例，git.ts:818）。
- **兜底防护**：`snapshotFullState` 内 `git add -A` 追加 `-c core.excludesFile` / `.git/info/exclude` 排除 `iso/`（即便未来误置内），并在 `add -A` 前 `git config --worktree` 忽略 nested gitlink。D14 双保险。

### 4.3 cwd 切换 + **全部路径承载令牌**改指隔离树（D16，Codex 设计 gate P1-3）

opencode cwd 由 `runNode.worktreePath`（`runner.ts:117`）决定，改指隔离树即可让进程物理落隔离区。**但仅改 worktreePath 不够**——`renderUserPrompt` 里 `{{__repo_path__}}` 渲染自 `templateMeta.repoPath`（当前 dispatch 传 `task.repoPath` / 源 repo），若不改，agent 会被 prompt **明确告知去编辑一个非隔离路径** → 绕过隔离。故隔离运行时**所有承载文件系统路径的令牌/字段一并改指隔离树**：
- `runNode.worktreePath` → 隔离树。
- `templateMeta.repoPath` → 隔离树（单仓）；`templateMeta.repos[].worktreePath`（:120-141）→ 各仓隔离子树；`templateMeta.repos[].repoPath` 按语义（若表示 agent 工作路径则改指隔离，若表示源 repo 只读引用则保留——**编码前逐令牌核对 `renderUserPrompt` 语义**，见 plan T-token-audit）。
- envelope **文件端口**产物路径（agent 写的文件在隔离树内，输出端口给的是隔离树相对/绝对路径）——合并回收后这些文件落主树；**下游读文件端口时按主树解析**（端口值是相对路径 + 下游自己的隔离树含合并后的文件，天然一致；绝对路径端口需在合并回收时重写，plan 标注）。
- agent 自身的 `git diff` / git 操作：cwd=隔离树，自然正确。

## 5. 合并回收（merge-back）

### 5.1 时机、锁与完成门控（D15）

- **成功即持久化、但不置 done**：node run agent 成功（`result.kind==='ok'`）时，在 §2 段② 末（释放 globalSem 前）落 `node_run_outputs` + 快照 pin `iso_node_tree` + `merge_state='pending-merge'`。**此刻 `status` 仍非 `'done'`**——把「run 完成」与「合并落定」解耦。
- **合并回收在段③**：`runOneNode` 内、**释放 globalSem 之后**、返回之前，持 writeSem 执行（§7 锁序）。合并落定后 `merge_state='merged'` **并**在同一 writeSem 临界内把 `status` 从 running/中间态转 `'done'`（经 `lifecycle.ts` CAS，非直写）。
- **downstream 就绪 = status='done'**：`areTransitiveUpstreamsCompleted`（`freshness.ts`）判据不变；因 `'done'` 只在 `'merged'` 后置，下游**永不**在 delta 落主树前派发（修 Codex P1-2 崩溃窗口）。**非隔离旧行**（`merge_state IS NULL`）行为逐字不变（golden-lock）。
- **runNode 契约变更**：隔离运行下 runNode 成功**不再直接 finalize `status='done'`**（改由 runOneNode 段③ finalize）；`runNode.ts` 里置 done 的点加隔离分支（或返回「ran-ok-unmerged」让 runOneNode 收口）。这是本 RFC 对 runNode/runOneNode 契约的关键改动，测试锁。

### 5.2 三路合并机制

三个 tree（都经 §4.1 全量快照，含 untracked）：
- `base` = `iso_base_snapshot`（派发时主树）
- `ours` = `canon_tree` = 主树**现态**（可能被兄弟节点推进）
- `theirs` = `node_tree` = 隔离树终态

```
merged, conflicts = git merge-tree --write-tree --merge-base=<base> <ours(canon_tree)> <theirs(node_tree)>
```

`git merge-tree --write-tree`（git ≥ 2.38）**纯内存**产出合并树 OID + 冲突路径列表，**不触碰主树**。

- **无冲突** → 把 `merged` 落地进主树工作区（materialize，§5.3），主树得到并集改动（未提交，I-2）。
- **有冲突** → §6。

**git 版本门**：daemon 启动已探测 git 版本（`services/gitVersion.ts`）。本特性要求 git ≥ 2.38；低于则 daemon 启动拒绝（同「低于文档最低版本拒启」既有策略）。决策 D7。

### 5.3 materialize（把合并树落地为主树未提交改动）

```
git -C 主树 read-tree <merged>          // 更新 index 到合并树
git -C 主树 checkout-index -f -a         // 写工作区文件
git -C 主树 clean -fd -- <被 merged 删除但工作区残留的路径>   // 精确删，见下
```

- 主树 HEAD 不动 → `git diff HEAD`（= `gitDiffSnapshot` 从 base commit，git.ts:543）仍显示全部累积改动，含新增（former-untracked）。I-2 保持。
- **删除处理**：合并树里被删的文件需从工作区移除；用合并树与主树现态的 diff 精确 `rm`，不裸 `clean -fd`（避免误删无关 untracked）。
- former-untracked → 经 read-tree 变**已暂存**：仍属「未提交」（I-2 成立）；`gitDiffSnapshot`（比对 base commit ↔ 工作区）与 auto commit&push（`git add -A`）都不受影响。决策 D8 记此**良性偏移**。

### 5.4 干净快路径 & 空 delta

- **干净应用**：第一个完成的兄弟合并回收时 `ours == base`（主树自派发未动）→ merge-tree 必无冲突、materialize == 直接落 `theirs`。线性工作流恒走此路（AC-17 零回归）。
- **空 delta**：非写节点 `node_tree == base` → merged == ours → materialize no-op。删了 readonly 后「不写盘」节点靠此免真合并（仅付隔离树创建/销毁成本，§性能）。

## 6. 冲突 → 合并 agent → awaiting_human

### 6.1 内置合并 agent

新 `services/mergeAgent.ts`，仿 `buildCommitAgent`（commitPush.ts:29）：

```ts
export const MERGE_AGENT_NAME = 'aw-merge-resolver'
export function buildMergeAgent(): Agent {
  return { id: '__merge_agent__', name: MERGE_AGENT_NAME,
    description: 'Framework built-in: resolve git merge conflicts (RFC-130).',
    outputs: ['resolution'], syncOutputsOnIterate: true, permission: {},
    skills: [], dependsOn: [], mcp: [], plugins: [], frontmatterExtra: {},
    bodyMd: '<解冲突 system prompt：cwd 内文件带 <<<<<<< 冲突标记，逐个解、保留双方意图、输出无标记的完整文件>',
    schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now() }  // 无 readonly（已删）；runtime 由调度器解析冻结
}
```

- 运行时：`resolveInternalAgentRuntime(db, { runtimeName: opts.mergeAgentRuntime, deprecatedModel: opts.mergeAgentModel, defaultRuntime })`（runtimeRegistry.ts:204），配置字段 `mergeAgentRuntime`/`mergeAgentModel`（config.ts，仿 `commitPushRuntime`）。
- 派发：`runNode`，作为**子 node_run**（`parentNodeRunId = 冲突节点 run`，`cause='merge-resolve'`，keyed `merge:{nodeId}:{iter}`，仿 commit-push child，scheduler.ts:1074）。

### 6.2 流程（持 writeSem 全程，冲突罕见）

```
merge-tree 出冲突 conflicts[]：
  ① merged 是 tree OID，worktree add 要 commit-ish（Codex P2-2）→ 先
        cmt = git commit-tree <merged> -p <base> -m aw-conflict   // pin 防 gc
     再 git worktree add --detach <resolve-iso> <cmt>            // 解冲突工作区（带冲突标记）
  ② runNode(合并 agent, cwd=<resolve-iso>, 绕 globalSem〔§7 防死锁〕)
  ③ 成功判定 = resolve-iso 工作区无残留冲突标记（grep '^<<<<<<< ' / '^>>>>>>> ' / '^=======$'）
       且进程正常收尾
  ④ 判定通过 → resolved_tree = snapshotFullState(resolve-iso) → materialize(主树, resolved_tree)
     判定失败（残留标记 / 进程失败耗尽重试）→ §6.3
  ⑤ 弃 resolve-iso
```

- 全程持 writeSem：主树在解冲突期间**不被其他合并回收/快照插入**（merge-tree 是内存态，主树自始至终是 `ours`，故 resolved 可直接落主树）。代价 = 罕见冲突期间其他节点的**合并回收/新派发快照**排队（**运行中的 agent 不受影响**，它们不持锁）。决策 D5 记此延迟权衡 + 后续可拆「解冲突专用锁」精化。
- **合并 agent 绕 globalSem**（§7）：否则「我持 writeSem 等 globalSem，兄弟持 globalSem 等 writeSem」成环 → 死锁。合并 agent 罕见、框架内部，放行不计入 `globalSem`。

### 6.3 awaiting_human 兜底

合并 agent 也解不了：
- 把**带冲突标记的合并树** materialize 进主树（让人能在主树看到 `<<<<<<<` 冲突、手工解），`merge_state='conflict-human'`。
- 冲突节点 run → `park-human`（`nextNodeRunStatus` pending/running→`awaiting_human`，shared/lifecycle.ts:124）；任务 `trySetTaskStatus(running→awaiting_human)`（scheduler.ts:526）。
- **resume**（`resumeTask`→`resumeKick`，task.ts:1232）：人工已解（无残留标记）→ 从合并点继续（该节点 merge_state 置 `merged`、标 done、放行下游）；仍有标记 → 再次 awaiting_human。检测在 resume 的 scheduler 首 tick 做（读 `merge_state='conflict-human'` 的节点 → 校验主树无残留标记）。
- **框架自检、不依赖 agent 自报**：成功/失败判定一律由框架 grep 残留标记决定（合并 agent 只管产出，不发 clarify）。决策 D6。

## 7. writeSem 语义改写 + 锁序

### 7.1 改写

三处 `agent.readonly ? null : await writeSem.acquire()`（scheduler.ts:1960 单节点 / 4061 fanout shard / 4351 aggregator）**全删**。writeSem 不再罩 agent 运行，改为在 `runOneNode`（及 fanout/agg 对应体）内部**两段短持有**：
- 段①快照-派发：`writeSem.run(() => { base=snapshotFullState(主树); worktree add iso })`
- 段③合并回收：`writeSem.run(() => { merge-tree; materialize | 合并 agent })`

`releaseWrite` 不再是整函数生命周期，改为两个 `writeSem.run(...)` 短临界区（复用 `Semaphore.run`，见 scheduler.ts:4542/4588 既有用法）。

### 7.2 锁序与死锁分析（新写进 `taskWriteLocks.ts` 模块注释）

单节点一次运行的持锁时间线：
```
[writeSem 段①] → 释放 → [globalSem 段②] → 释放 → [writeSem 段③ (+合并 agent 绕 globalSem)] → 释放
```

- **writeSem 与 globalSem 从不同时持有**（段①释放后才取 globalSem；段②释放 globalSem 后才取段③ writeSem）——唯一例外是段③冲突时合并 agent 需一个「跑 opencode」的额度。
- **合并 agent 绕 globalSem** → 段③持 writeSem 期间不等 globalSem → 不与「持 globalSem 等 writeSem 的兄弟」成环。**无 writeSem↔globalSem 环**。
- 与既有 **question-write 锁（B）**（taskWriteLocks.ts:36）关系：本 RFC 只动主写锁 A（`getTaskWriteSem`），B 不碰；既有「A ≻ B、仅 submit 内嵌套」不变。
- `subprocessSem`（fanout）：段②内取（fanout shard），与 writeSem 同样「不与段③ writeSem 同持」。

### 7.3 并发模型结果

`globalSem`（默认 `maxConcurrentNodes=4`）成为**真并行上限**（对所有节点，不再区分读写）。writeSem 退化为「主树读写的短临界区串行器」。不新增用户配置（沿用 `maxConcurrentNodes`，proposal 非目标）。

## 8. wrapper 交互（AC-10/11/12）

### 8.1 wrapper-git

- pre/post 快照仍取**主树**（`runGitWrapperNode`，scheduler.ts:4588/4675，在 writeSem.run 内），`git_diff` = post−pre。
- 内部节点各自隔离 + 合并回主树；wrapper 内所有内部节点完成后（`runScope` await 全部），所有合并回收已落主树 → post 快照含内部改动**全集** → `git_diff` 与串行等价（I-4/AC-10）。
- pre 必须在任一内部节点段①快照之前取（内部节点 base ⊇ wrapper pre）；post 在全部合并回收后取。二者都在 writeSem 上，与内部合并回收互斥 → 一致。

### 8.2 wrapper-loop

- 每迭代进入内部 scope，内部节点隔离 + 合并进主树；跨迭代状态经主树文件（v1 无跨迭代反馈端口，proposal 模型不变）。
- `git in loop`（git 在 loop 内）= 每迭代取一次 pre/post，末迭代 diff 为输出；`loop in git` = loop 外 git 取一次 pre、全循环后 post = 全循环总 diff。隔离不改这两个取点，只把内部写从「串行落主树」换成「并行落隔离树→串行合并回主树」，净累积一致（AC-11）。

### 8.3 wrapper-fanout（最高风险子案）

- 可写 shard（`dispatchFanoutShard`，scheduler.ts:4056）各自隔离树并行跑（受 `subprocessSem`）；合并回主树串行（writeSem）。不同 shard 通常改不同文件（per-file/per-dir 分片）→ 合并干净；同文件重叠 → 走 §6。
- **value-hash replay**（RFC-098 B3，scheduler.ts:3906）：replay 的 shard 不 spawn、不建隔离树、不合并回收——其上次改动已在主树（上次 run 的合并回收落过）。replay 复用旧 node_run，天然跳过段①③。
- **shard rerun（value 变）**：新 run 隔离 base = 主树现态（含**本 shard 上次**已落改动）；合并回收 delta = 新态 vs base。**风险**：上次 shard 改动仍在主树、rerun 又叠新改动 = 语义应「替换本 shard 贡献」而非叠加。v1 处理：rerun 前对**本 shard 上次改动**做定向撤销（读上次 run 的 delta 反向 apply）后再建隔离 base——**此子案单独硬化 + 测试锁**（plan T-fanout）。决策 D9 标为最高风险、最后交付、加 shard-rerun 等价性回归测试。
- aggregator（scheduler.ts:4347）同单节点：隔离 + 合并。

## 9. 多仓（RFC-066，AC-13）

- 隔离**逐仓**：一个 node run 为它涉及的每个仓建一个隔离子树（`iso_worktree_path` 容器下按 `worktreeDirName`），base 快照逐仓（`iso_base_snapshot_repos_json`）。
- 合并回收逐仓独立（一仓冲突走 §6、不影响他仓的干净合并）。
- 复用既有多仓 `state.repos` 线程（scheduler.ts:304-335）与多仓 pre-snapshot 惯例（:2188-2217）的结构。

## 10. 失败 / 重试 / resume / 恢复

### 10.1 失败零污染（I-5，比现状更干净）

合并回收**只在成功后**发生 → 失败 / canceled 的 node run **从不写主树**。于是重试分两种（对齐既有 RFC-042 `followupDecision.followup` 分叉，scheduler.ts:2040）：
- **fresh-session 重试**（`!followup`）：**弃失败隔离树**（`removeWorktree` + 删 pin ref）→ 段①从**当前主树**重新快照分叉新隔离树。**无需回滚主树**（主树没被污染）。RFC-092/098 的「rollback 主树到 pre_snapshot」在新模型下对**已隔离节点**退化为 no-op（主树本就干净）。
- **隔离树生命周期 = 逻辑节点首次派发 → 最终产出（done→merge-back）/ 放弃**（D17/D19，Codex 设计 gate P2-1 + 第二轮 P1）：一个逻辑节点在其生命周期内的**所有同会话续跑都复用同一隔离树、绝不中途弃/合/重建**：
  - **RFC-042 envelope / RFC-049 port-validation 同会话 follow-up 重试**（`followupDecision.followup`）：续跑同 opencode session，记得刚写文件。
  - **clarify 内联续跑**（D19，第二轮 P1）：节点写文件后发 `<workflow-clarify>` → 停 `awaiting_human`；答完**内联续跑同 session**（`scheduler.ts:2687-2727` `resumeDecision.inlineMode` / `effectiveResumeSessionId`）。**此时节点尚无最终输出 → 不 merge-back**（merge-back 只在最终产出时，§5.1）；隔离树必须从首次派发一路保留到答完续跑最终产出，中途弃/合会让续跑 session 文件系统与记忆不符。
  - **仅 fresh-session 重试**（`!followup`、非内联）才弃隔离树 + 从当前主树重快照。既有 `if (!followupDecision.followup) { rollback }`（scheduler.ts:2040）语义平移为「仅 fresh-session 弃隔离树」，且**扩展**到 clarify inline 分支同样保留。
  - **merge-back 时机随之明确**：一个逻辑节点**只在它真正产出最终输出那一次**做 merge-back（clarify 中途的 awaiting_human 不 merge）。`iso_worktree_path` 生命周期跨越 clarify 轮，直到 done 才弃。
- `pre_snapshot` 回滚路径（nodeRollback.ts、task.ts resume）**保留但基本空转**（防御：万一有非隔离写入路径）；`rollbackNodeRunWorktrees`（nodeRollback.ts:76）签名不改。决策 D10：保留回滚代码作纵深防御，不删。

### 10.2 resume（`resumeKick`，task.ts:1304）

- 选重跑目标 `selectResumeRollbackTargets`（task.ts:443，最新 failed/interrupted）不变。
- **replay 未落合并（D15，Codex P1-2 收口）**：resume 首 tick 扫 `merge_state='pending-merge'` 且 status 非 done 的行（= 段②③ 之间崩溃）→ 从 pinned `iso_node_tree` **replay merge-back**（重算 `merge-tree(base, canon_now, node_tree)` → materialize / 合并 agent）→ 落 `merged` + `done`，**不重跑 agent**（输出已在 `node_run_outputs`）。node_tree pin ref 丢失（罕见）才回退重跑 agent。
- 新增：resume 首 tick 清理**孤立隔离树**（`iso_worktree_path` 非空但 run 终态且 `merge_state IN (merged,null)` 的行 → `removeWorktree`；**pending-merge 的隔离树保留**待 replay）+ 处理 `merge_state='conflict-human'`（§6.3）。
- preflight（RFC-108 T6，`worktreePreflight`）：新模型下 pre_snapshot 多为空，preflight 基本放行；隔离 base pin ref 若被 gc（罕见）→ 该 run 重跑从当前主树重新分叉，不 fail-closed（区别于 pre_snapshot 丢失的 `snapshot-lost` 升级：隔离 base 丢失不致命，因主树未依赖它回滚）。决策 D11。

### 10.3 daemon 重启（interrupted）

孤立隔离树由 §10.2 resume 清理 + §12 GC 兜底。`node_runs.iso_worktree_path` 是清理索引。

## 11. auto commit&push（RFC-075）——写锁窗口收紧（D18，Codex 设计 gate P1）

`maybeRunCommitPush`（scheduler.ts:1017）是 `commitpush:` 合成路径，**直接在主树**上 `git status`/`git add -A`/commit/push、自持 writeSem（:1161）。它**不走**隔离/合并回收（它要提交的正是主树累积的全部改动）。

**新问题**：`commitPushRunner.ts:182-199,238-252` 现在在 `git add -A`/取 cached diff **之后、`git commit` 之前就释放 writeSem**（为的是不在多分钟的 commit-message 生成期间持锁）。今天这是安全的（只有它写主树）；RFC-130 后**兄弟节点的 merge-back 也抢同一把 writeSem**，会在这个缝里改主树 index/worktree → 该 commit 混入兄弟改动（挂错合成行 / 错消息），或让后完成的节点 diff 变空。

**修（D18，含三轮 P1 收口）**：commit-push **提交一棵冻结快照树**，让 message 的输入 diff 与被提交的树**同源**，且并发 merge-back 不被卷进本次提交：
1. **短锁冻结**：持 writeSem 一次，`frozen = snapshotFullState(主树)`（一棵树 sha）+ 取 `diff(HEAD, frozen)` 供 message。释放锁。
2. **锁外生成 message**：opencode 用该 diff 生成消息（慢、无锁）。
3. **短锁提交冻结树**：持 writeSem 一次，`new = git commit-tree <frozen^{tree}> -p HEAD -m <msg>` + `git update-ref HEAD <new>`；然后把 index/工作区对齐 HEAD（`reset --soft`/刷新），使「已提交部分」不再算未提交改动。释放锁。
- **关键**：提交的是 **step 1 冻结的那棵树**（= message 描述的树），**不是** commit 时刻 `git add -A` 的实时树 → step 1↔3 之间落地的兄弟 merge-back **不进本 commit**（它们留作未提交改动、下一轮 commit-push 收），既不混入错 message、也不清空兄弟 diff。push（网络、慢）在 HEAD 更新后、锁外做。
- `commitPushRunner.ts:182-199/238-252` 的「add→释放→gen→commit」重构为「冻结取 diff→释放→gen→commit-tree 冻结树」。**AC-23 据此锁**。

`buildCommitAgent`（commitPush.ts:29）去 `readonly:true` 字段（随 §3.1 schema 删列）。

## 12. GC（隔离树清理，`services/gc.ts`）

- 既有 `runWorktreeGc`（gc.ts:36）清终态任务的主树 + `deleteSnapshotRefs`。
- 新增：扫 `node_runs.iso_worktree_path` 非空的孤立隔离树（run 终态 / 任务终态）→ `removeWorktree` + 删 `refs/agent-workflow/iso/{taskId}/*`。运行期正常路径段③已即时弃，GC 是兜底（崩溃/重启残留）。
- 复用既有每小时 ticker（gc.ts:114）。

## 13. readonly 删除全清单（AC-15）

| 层 | 文件:行 | 动作 |
|---|---|---|
| DB | schema.ts:27 + migration | 删 `agents.readonly` 列 |
| schema | shared/schemas/agent.ts:98,165；shared/inventory.ts:44,138 | 删字段 + normalizer |
| 调度 | scheduler.ts:1960,4061,4351 | 删写锁三元（改 §7 短临界） |
| 调度 | scheduler.ts:2049,2164 | 回滚/pre-snapshot 的 `!agent.readonly` 门 → 见 §10.1（改为「隔离节点恒不回滚主树」） |
| runner | runner.ts:848,1691 | 删注入 `options.readonly` |
| claude | runtime/claudeCode/spawn.ts:60,87 | 删 `CLAUDE_READONLY_DISALLOWED_TOOLS` + 门禁（软沙箱能力消失，proposal 已声明） |
| 内置 | commitPush.ts:36 | 删 `readonly:true`（随 schema） |
| transcoder | opencode-plugin/transcoder.ts:48 | 删 readonly 派生（改恒 false/删分支） |
| 前端 | AgentForm.tsx:35,180；DependencyTree.tsx:125；DependencyTreePreview/NodeDependencyTreeSection | 删开关 + chip |
| i18n | en-US.ts:1696；zh-CN.ts:4126 | 删 `fieldReadonly*`；`dependencyTree.readonly/writes` |
| 测试 | reviews-detail-readonly-source / dependency-tree-build / agent-import-merge 等 | 更新（去 readonly 断言） |

## 14. 失败模式

| 场景 | 处理 |
|---|---|
| 隔离树 `worktree add` 失败（磁盘满/路径冲突） | node run fail，错误 `iso-worktree-add-failed`；不污染主树 |
| base pin ref 被 gc（隔离运行超长 + 激进 gc） | 合并回收时 `gitCommitExists(base)` 假 → 回退：以主树现态为 base 直接应用隔离 delta（退化为二路，风险自担并告警）或 fail node（决策 D11 取告警+二路） |
| merge-tree git<2.38 | daemon 启动即拒（§5.2 版本门） |
| 合并 agent 输出仍带标记 | §6.3 awaiting_human |
| 段②③ 之间 / materialize 中途崩溃 | status 未 done（D15）；resume 首 tick 检测 `merge_state IN (pending-merge, conflict-resolving)` 的 run → 从 pinned `iso_node_tree` **replay merge-back**（幂等：重算 `merge-tree(base, canon_now, node_tree)` → materialize），不重跑 agent |
| 多仓一仓合并 agent 失败 | 整任务 awaiting_human（保守；不做部分推进） |

## 15. 测试策略（每改动带测试，见 plan 验收清单）

- **纯 oracle（首选可断言面）**：抽 `mergeBackPlan(base,ours,theirs) → {clean|conflict, paths}` 的纯包装（薄封装 git，或对 fixture 仓做真 git 断言）；`isolationNeeded(node)` 恒 true 的锁；`residualConflictMarkers(text)` 纯函数（grep 标记）。
- **集成（真 git fixture 仓）**：
  - 两并发写节点改不同文件 → 主树含并集、无冲突（AC-5）。
  - 改同文件不重叠 hunk → 自动并（AC-5）。
  - 改同一行 → 合并 agent（mock 成功）→ 主树解（AC-7）；mock 失败 → awaiting_human（AC-8）。
  - 失败节点零污染主树（AC-6）。
  - wrapper-git 并行 vs 串行 `git_diff` 等价（AC-10）。
  - fanout shard 并行 + shard-rerun 等价性（AC-12 + §8.3 D9）。
  - 多仓逐仓隔离/冲突隔离（AC-13）。
  - 单节点重试从当前主树重分叉（AC-14）；resume 清孤立隔离树。
- **并发窗口断言**：两节点运行时间窗重叠（AC-1）——用 mock runNode 记录 start/end 时间戳断言 overlap（现有 `scheduler-boundary-*` 测试有 mock runNode 惯例）。
- **源码文本锁（兜底）**：`scheduler.ts` 不再出现 `agent.readonly`；`writeSem.acquire()` 不再罩整个 runNode（锁「段①段③ 两短临界」形态）。
- **回归**：线性工作流最终产物逐字等价（AC-17）；readonly grep 全清（AC-15）。

## 16. 决策记录

- **D1** 隔离粒度 = per-node-run（每重试/rerun 独立隔离树），对齐 node_runs。
- **D2** 隔离起点 = **全量快照（含 untracked）**，新增 `snapshotFullState`（临时 index），不复用 `gitStashSnapshot`（后者漏 untracked）。
- **D3** 合并机制 = `git merge-tree --write-tree`（内存三路、主树永不半合并），materialize=read-tree+checkout-index，保「未提交」模型。
- **D4** 合并回收在**释放 globalSem 之后**、持 writeSem 的短临界区做。
- **D5** 冲突解全程持 writeSem（罕见），换主树一致性 + 免优化 lock；后续可拆解冲突专用锁。
- **D6** 合并成功/失败由框架 grep 残留标记判定，不依赖合并 agent 自报（不发 clarify）。
- **D7** 要求 git ≥ 2.38（merge-tree --write-tree），daemon 启动版本门。
- **D8** former-untracked 经合并回收变已暂存 = 良性（仍「未提交」，diff/commit&push 不受影响）。
- **D9** fanout shard-rerun 等价性是最高风险子案，末位交付 + 定向撤销上次 shard delta + 专项回归。
- **D10** 保留 RFC-092/098 主树回滚代码作纵深防御（新模型下对隔离节点空转），不删。
- **D11** 隔离 base pin 丢失不致命（主树不依赖它回滚）：告警 + 退化二路应用；区别于 pre_snapshot 丢失的 `snapshot-lost` 升级。
- **D12** 合并 agent 绕 `globalSem`（防 writeSem↔globalSem 死锁）。
- **D13** readonly 彻底删（含 claude 软沙箱），旧 `readonly:` 键降级进 frontmatterExtra。
- **D14**（Codex 设计 gate P1-1）隔离/解冲突 worktree **放主 repo 之外**（`{appHome}/iso/{taskId}/{nodeRunId}`），杜绝 `snapshotFullState` 的 `git add -A` 把嵌入 worktree gitlink 暂存进快照树；加 `.git/info/exclude` 兜底。
- **D15**（Codex 设计 gate P1-2）**完成门控**：`status='done'` 只在 `merge_state='merged'` 后置；成功但未合并落 `pending-merge` + pin `iso_node_tree`；下游就绪沿用「done 才放行」→ 天然不在 delta 落主树前派发；崩溃 resume 从 node_tree replay merge-back 不重跑 agent。新增 `iso_node_tree` 列。
- **D16**（Codex 设计 gate P1-3）隔离运行下**所有承载文件系统路径的模板令牌/字段**（含 `{{__repo_path__}}` 的源 `templateMeta.repoPath`）一并改指隔离树，不止 `worktreePath`；编码前逐令牌核对 `renderUserPrompt` 语义（plan T-token-audit）。
- **D17**（Codex 设计 gate P2-1）**同会话 follow-up 重试保留隔离树**（RFC-042/049 续跑同 opencode session 记得已写文件）；仅 fresh-session 重试弃隔离树重快照。平移既有 `!followup` 分叉。
- **D18**（Codex 设计 gate 二轮 P1）auto commit&push 把「暂存→本地 commit」收进**单个 writeSem 临界**（不再 add 后释放）、message 生成前置，防兄弟 merge-back 插进「暂存↔提交」缝。
- **D19**（Codex 设计 gate 二轮 P1）隔离树保留**扩展到 clarify 内联续跑**（`inlineMode`/`effectiveResumeSessionId`）：逻辑节点跨 clarify 轮复用同一隔离树，**只在最终产出那次 merge-back**、done 才弃；awaiting_human 中途不 merge。
- **D20**（Codex 设计 gate 二轮 P2）`createIsolatedWorktree` add 后跑 `syncSubmodules`（git.ts:396-404），隔离树 submodule 与主树一致；否则 agent 读/改 submodule 见空 checkout。
- **D22**（Codex 设计 gate 三轮 P2）submodule **工作区脏编辑（未在 submodule 内提交）= v1 已知限制**：超级项目 `git add -A` 只记 gitlink、丢脏文件；v1 **检测到即 fail-loud（`submodule-dirty-unsupported`）不静默丢**；递归 submodule 隔离/合并列后续 RFC。
- **D23**（Codex 设计 gate 三轮 P2）隔离树 **HEAD = 任务原始 base HEAD、累积改动作未提交工作区状态铺上**（而非把快照当已提交 HEAD）→ 保住下游 agent `git diff HEAD` 能看到上游未提交产物（对齐现状共享树语义）。
- **D24**（Codex 设计 gate 三轮 P1）commit-push **提交冻结快照树**（`commit-tree`）而非提交时 `git add -A`：message 输入 diff 与被提交树同源、并发 merge-back 不卷入本次提交。
- **D25**（Codex 设计 gate 三轮 P2）`runGit` 加可选 `{ env }`（merge 在 `nonInteractiveGitEnv()` 上）以支持 `GIT_INDEX_FILE` 临时 index；`snapshotFullState` 依赖它。

## 17. 性能与后续

- **成本**：每 node run 一次 `worktree add`（checkout）+ 两次全量快照 + 一次 merge-tree。大仓 / 高扇出（如 50 shard）成本显著。
- **v1 取正确性优先，一律隔离**。后续优化（不在本 RFC）：
  - **免隔离快路径**：按 agent permission 证明「不写盘」（edit=deny ∧ bash=deny）→ 免建隔离树、共享只读快照视图（**不复活 readonly 手填标记**，纯 permission 自动推导、对用户不可见）。
  - 隔离树 checkout 用 `--no-checkout` + 按需 sparse。
  - base 快照对「主树自上次快照未变」复用同一 sha。
