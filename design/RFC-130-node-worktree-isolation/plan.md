# RFC-130 Plan —— 任务分解与 PR 拆分

> 配套：`proposal.md` / `design.md`。本 RFC 体量大，拆为 6 个强序 PR，每个独立门禁全绿（typecheck + test + format + 单二进制 smoke）。用户拍板「一次性做全」= 单 RFC 覆盖全部组合，经下列 PR 序落地。

## 依赖图

```
PR-A 隔离核心（顶层干净路径）── PR-B 冲突/合并 agent/awaiting_human
    └── PR-D wrapper 覆盖（git/loop/fanout）── PR-C readonly 彻底删除 ── PR-E 多仓 + resume/GC
                                             （PR-F 前端并入 C/独立）
```

**强序理由（含 Codex 设计 gate 二轮 P1-3 修正）**：PR-A 先让**顶层 DAG 干净并行**跑起来（最大价值、最可测；**只删顶层写锁门 scheduler.ts:1960**，fanout 门 4061/4351 不动）；PR-B 补冲突路径；PR-D 把隔离推进 wrapper 内部（fanout shard-rerun 是最高风险）；**PR-C（删 readonly）必须在 PR-D 之后**——因为 `dispatchFanoutShard`/aggregator（scheduler.ts:4061/4351）在 PR-D 前仍靠 `innerAgent.readonly ? null : writeSem.acquire()` 串行，若先删 readonly 门而 wrapper 尚未隔离，writer shard/aggregator 会并发写主树（Codex 二轮 P1-3）；PR-E 多仓与恢复。**`agents.readonly` 列的 DROP 只能在所有 readonly 门（1960 已由 PR-A 换隔离、4061/4351 由 PR-D 换隔离）都撤除后（=PR-C）执行。**

---

## PR-A —— 隔离核心 + 顶层单节点隔离/干净合并回收

**目标**：顶层 DAG 的每个 node run 隔离运行 + 干净合并回主树；写锁退化为短临界；`globalSem` 成真并行上限。冲突暂走「占位 awaiting_human」（PR-B 补合并 agent）。

- **RFC-130-T1**：git 原语（`util/git.ts`）
  - `snapshotFullState(worktree, {pinRef})`（临时 index：read-tree HEAD + add -A + write-tree + commit-tree + update-ref）。含 untracked；`add -A` 加 exclude 兜底忽略 `iso/`（D14 双保险）。
  - `createIsolatedWorktree(repoPath, isoPath, baseSha)`（`worktree add --detach` + **add 后 `syncSubmodules`**〔D20，git.ts:396-404〕）；isoPath = `{appHome}/iso/{taskId}/{nodeRunId}`，**主 repo 之外**（D14）。
  - `mergeTreeInMemory(worktree, base, ours, theirs) → {mergedTreeOid, conflicts[]}`（`git merge-tree --write-tree --merge-base`）。
  - `commitTree(worktree, treeOid, parent) → commitSha`（冲突树 worktree add 前 wrap，Codex P2-2）。
  - `materializeTree(worktree, mergedTreeOid)`（read-tree + checkout-index -fa + 定向删）。
  - `residualConflictMarkers(text)` 纯函数 + `isoRefName(taskId, nodeRunId)`。
  - git ≥ 2.38 版本门（`gitVersion.ts` + daemon 启动拒启，config/probe 处）。
  - **测试**：真 git fixture 仓——含 untracked 的全量快照往返；merge-tree 干净/冲突两路；materialize 后 `git diff HEAD` 等价；**iso 在主 repo 外 → `snapshotFullState` 不暂存隔离目录**（D14 回归）；版本门单测。
- **RFC-130-T2**：`node_runs` 记账列 migration（`iso_worktree_path` / `iso_base_snapshot` / `iso_base_snapshot_repos_json` / **`iso_node_tree` / `iso_node_tree_repos_json`** / `merge_state`，纯 ADD COLUMN）+ schema.ts + rolling-upgrade journal 计数 +1（[[reference_migration_bumps_journal_count_test]]）。
- **RFC-130-T3**：`scheduler.ts` `runOneNode` 改写（顶层单节点）
  - 删 `const releaseWrite = agent.readonly ? null : await writeSem.acquire()`（**仅 :1960 顶层**；fanout 门 4061/4351 **不动**，留到 PR-D 换隔离、readonly 列到 PR-C 才 drop——Codex 二轮 P1-3）。
  - 段①`writeSem.run`：`snapshotFullState(主树)` 写 base 列 + `createIsolatedWorktree`（主 repo 外）写 `iso_worktree_path`。
  - **路径令牌路由（D16）**：`runNode.worktreePath` + `templateMeta.repoPath` + `templateMeta.repos[].worktreePath` 全改指隔离树（见 T3b 令牌审计）。
  - 段②末：agent 成功 → 落 `node_run_outputs` + pin `iso_node_tree` + `merge_state='pending-merge'`，**不置 done**（D15）。
  - 段③`writeSem.run`（release globalSem 后）：`canon_tree` 快照 → `mergeTreeInMemory` → 干净则 `materializeTree`；冲突则**占位 awaiting_human**（PR-B 替换）；`merge_state='merged'` **后**才 `status='done'`（D15）；弃隔离树（`removeWorktree` + 删 pin ref；node_tree pin 留）。
  - `runNode` 契约：隔离运行成功不再直接 finalize `done`（改 runOneNode 段③收口，D15）。
  - `deriveFrontier`/`areTransitiveUpstreamsCompleted`：非隔离旧行（`merge_state IS NULL`）逐字不变；隔离行「done ⟹ merged」由 T3 保证，就绪判据不改（D15）。
  - **同会话 follow-up 保留隔离树**（D17）：`!followup` 才弃隔离树重快照；follow-up 保留（平移 scheduler.ts:2040 分叉）。
  - `!agent.readonly` 的回滚(:2049)/pre-snapshot(:2164)门：改为「隔离节点恒不回滚主树、不取旧 pre_snapshot」（§10.1）。
  - **测试**：两并发写节点改不同文件 → 主树并集 + 运行时间窗重叠断言（AC-1/2/5）；有依赖节点 base 含上游改动（AC-3）；失败节点零污染（AC-6）；**done 只在 merged 后（AC-19）——mock 段②③ 间「崩溃」断言下游未派发**；follow-up 保留隔离树（AC-22）；线性工作流最终产物逐字等价（AC-17）；源码锁「runNode 不再被单一 writeSem 罩全程」。
- **RFC-130-T3b（D16 路径令牌审计）**：编码前逐令牌核对 `renderUserPrompt`（`shared/prompt.ts`）/ `templateMeta` 所有承载路径的字段（`__repo_path__`、repos[].repoPath/worktreePath、文件端口绝对路径），隔离运行下全指隔离树；**测试**：prompt 渲染断言 `{{__repo_path__}}` = 隔离树路径（AC-21）。
- **RFC-130-T3c（D19 隔离树跨 clarify 内联续跑保留）**：节点发 `<workflow-clarify>` → awaiting_human **不 merge-back、不弃隔离树**；答完内联续跑（`scheduler.ts:2687-2727` `inlineMode`/`effectiveResumeSessionId`）复用同一隔离树；只在最终产出那次 merge-back、done 才弃。**测试**：写文件→clarify→答→内联续跑，续跑 cwd = 同一隔离树、看得到中途所写文件；最终产出才落主树（AC-22 扩展）。
- **RFC-130-T3d（D18 auto commit&push 写锁窗口）**：`commitPushRunner.ts`（:182-199/238-252）把「暂存→本地 commit」收进单个 writeSem 临界（不再 add 后释放）、message 生成前置、push 锁外。**测试**：commit-push 暂存与提交之间无兄弟 merge-back 可插入（mock 并发 merge-back 断言 commit 不含兄弟改动 / 后节点 diff 不空）。
- **验收**：顶层无冲突并行工作流跑通、并行度受 `globalSem`；门禁全绿。

## PR-B —— 冲突 → 合并 agent → awaiting_human

- **RFC-130-T4**：`services/mergeAgent.ts`（`buildMergeAgent`，仿 commitPush.ts:29；无 readonly）+ config `mergeAgentRuntime`/`mergeAgentModel`（config.ts，仿 commitPushRuntime）+ `RunTaskOptions` 线程 + CLI bootstrap（cli/start.ts）。
- **RFC-130-T5**：冲突流程（scheduler 段③冲突分支替换占位）
  - `commitTree(merged, base)` wrap 成 commit → 建 resolve 隔离树（Codex P2-2）→ `runNode(合并 agent, 绕 globalSem)` → `residualConflictMarkers` 判定 → 成功 materialize resolved / 失败 §6.3。
  - awaiting_human：冲突节点 `park-human` + 任务 `running→awaiting_human`；`merge_state='conflict-human'` + materialize 带标记树到主树。
  - 合并 agent 子 run（`parentNodeRunId` + `cause='merge-resolve'` + keyed `merge:`，仿 commit-push child）。
  - 锁序注释写进 `taskWriteLocks.ts`（§7.2：合并 agent 绕 globalSem 防死锁）。
- **RFC-130-T6**：resume 处理 `conflict-human`（`resumeKick` 首 tick：主树无残留标记 → 合并点续跑标 done；仍有 → 再 awaiting_human）。
- **测试**：同行冲突 mock 合并 agent 成功/失败两路（AC-7/8）；死锁不发生（globalSem 占满时合并 agent 仍能跑）；resume 人工解完续跑；合并 agent 运行时取 config（AC-9）。

## PR-C —— readonly 彻底删除（**落地顺序：PR-D 之后**，Codex 二轮 P1-3）

> ⚠️ 本 PR 撤除 fanout/aggregator 的 `readonly` 写锁门（scheduler.ts:4061/4351）+ DROP `agents.readonly` 列，**必须在 PR-D 把 wrapper/fanout 全部隔离之后**执行；否则 writer shard 失去唯一串行却无隔离 → 并发写主树。

- **RFC-130-T7**：DB drop 列 migration（`agents.readonly`，12 步重建照 0057 模板）+ journal +1。
- **RFC-130-T8**：schema（agent.ts / inventory.ts）删字段 + 旧 `readonly:` 键降级进 frontmatterExtra（agent 解析处，AC-16）。
- **RFC-130-T9**：runner 去 `options.readonly`（:848/1691）；claudeCode/spawn.ts 删 `CLAUDE_READONLY_DISALLOWED_TOOLS` + 门禁（:60/87）；transcoder.ts:48 去 readonly 派生；commitPush.ts:36 去 `readonly:true`。
- **RFC-130-T10（前端，可即 PR-F）**：AgentForm 删开关；DependencyTree/Preview/NodeDependencyTreeSection 删 chip；i18n 删 `fieldReadonly*` + `dependencyTree.readonly/writes`；相关测试更新。
- **测试**：全仓 grep `readonly`（agent 域）无残留（AC-15）；旧 `readonly:` 键 round-trip 进 frontmatterExtra；前端快照/依赖树测试更新绿。

## PR-D —— wrapper 覆盖（git / loop / fanout）

- **RFC-130-T11**：wrapper-git 内部节点走隔离（pre/post 仍主树，diff 等价，AC-10）。
- **RFC-130-T12**：wrapper-loop（git-in-loop / loop-in-git / loop-in-loop）内部节点隔离 + 合并；每迭代/全循环 diff 语义锁（AC-11）。
- **RFC-130-T13**：wrapper-fanout shard（`dispatchFanoutShard` :4056）+ aggregator（:4347）隔离 + 合并；value-hash replay 跳段①③。
- **RFC-130-T14（最高风险，末位）**：shard-rerun 等价性——rerun 前定向撤销本 shard 上次 delta 再建隔离 base（§8.3 D9）；专项回归锁「rerun 不叠加本 shard 旧改动」。
- **测试**：wrapper-git 并行 vs 串行 `git_diff` 等价；fanout 多 shard 并行改不同文件并集；shard-rerun 等价；loop 每迭代累积正确。

## PR-E —— 多仓 + resume/GC 收尾

- **RFC-130-T15**：多仓逐仓隔离 + 逐仓合并回收（一仓冲突不影响他仓，AC-13）；`iso_base_snapshot_repos_json` 落地。
- **RFC-130-T16**：GC（gc.ts）清孤立隔离树 + `refs/agent-workflow/iso/{taskId}/*`；resume 首 tick 清孤立隔离树（AC-14）+ **`pending-merge` replay merge-back**（从 pinned `iso_node_tree` 重算合并、不重跑 agent，D15/AC-19；PR-A 前该态经 interrupted→fresh 重跑兜底、PR-E 优化为 replay）+ `conflict-human` 续跑（§6.3）。
- **RFC-130-T17**：失败模式硬化（§14 表：worktree add 失败 / base pin gc / materialize 崩溃幂等 / 多仓部分失败保守 awaiting_human）。
- **测试**：多仓隔离/冲突隔离；daemon 重启孤立隔离树被 GC；base pin 丢失退化二路 + 告警。

---

## 全局验收清单（映射 proposal §5 AC）

- [ ] AC-1/2/3 并行 + 隔离 + 依赖可见（PR-A）
- [ ] AC-4/5/6 合并回收 / 自动并 / 失败零污染（PR-A）
- [ ] AC-7/8/9 冲突 → 合并 agent → awaiting_human + 运行时配置（PR-B）
- [ ] AC-10/11/12 wrapper-git/loop/fanout（PR-D）
- [ ] AC-13 多仓（PR-E）
- [ ] AC-14 重试/resume/GC（PR-A 重试 + PR-E resume/GC）
- [ ] AC-15/16 readonly 删除 + 旧键降级（PR-C）
- [ ] AC-17 线性零回归（PR-A）
- [ ] AC-18 全门禁（每 PR）

## 风险与缓解

- **调度器高发区**（[[project_hotspot_fortify_refactor]]）：每 PR 保留既有 golden-lock + 源码文本锁；改动前跑既有 `scheduler-boundary-*` 全绿基线。
- **fanout shard-rerun 等价性**（D9）：末位单独 PR + 定向撤销 + 专项回归，不与核心交织。
- **单二进制模块环**（[[reference_binary_build_module_cycle]]）：新 `mergeAgent.ts` / git 原语导出前跑 `bun run build:binary`。
- **migration journal 计数**（[[reference_migration_bumps_journal_count_test]]）：本 RFC 两个 migration（记账列 + drop readonly），各 +1 更新 `upgrade-rolling.test.ts`。
- **协作并发**（[[feedback_shared_index_commit_race]]）：`git commit -- 精确路径`；不碰他人在飞的 RFC-123 代码。
- **Codex 双 gate**（[[feedback_codex_review_after_changes]]）：设计 gate（本文档，approval 前）+ 每 PR impl gate。
