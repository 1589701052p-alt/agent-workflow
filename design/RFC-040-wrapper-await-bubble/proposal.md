# RFC-040 — Wrapper 节点上抛 awaiting_human / awaiting_review 并在原 iteration 续跑

| 字段     | 值                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号     | RFC-040                                                                                                                                                                                                                                                                                                                                                                                                       |
| 状态     | Draft                                                                                                                                                                                                                                                                                                                                                                                                         |
| 作者     | binquanwang                                                                                                                                                                                                                                                                                                                                                                                                   |
| 提交日期 | 2026-05-19                                                                                                                                                                                                                                                                                                                                                                                                    |
| 关联     | [RFC-005 human review](../RFC-005-human-review/proposal.md), [RFC-016 wrapper container UX](../RFC-016-wrapper-container-ux/proposal.md), [RFC-023 agent clarify](../RFC-023-agent-clarify/proposal.md)（特别是 bug 13 修复历史）, [RFC-026 clarify inline session](../RFC-026-clarify-inline-session/proposal.md), [RFC-027 node session view](../RFC-027-node-session-view/proposal.md)                       |

## 1. 背景

用户实测：把一个 `wrapper-loop`（`maxIterations=10`）配置成"内含 1 个 Agent + 1 个 clarify（反问）节点"，期望 Agent 第一轮抛 clarify、循环挂起、用户回答后**在同一轮**续跑。实际观察到的是：**10 次 Agent 跑、10 条独立 clarify_session 堆出来**，wrapper 状态 `exhausted`，task 卡 `awaiting_human` 但用户即使逐条答完也没有任何 Agent 真正消费答案——产出彻底丢失。

代码读到的根因（`packages/backend/src/services/scheduler.ts`）：

- `runScope`（`:296-454`）正确按 RFC-023 bug 13 修复把内层节点的 `awaiting_human` / `awaiting_review` 信号在 batch 收尾时上抛，返回 `{ kind: 'awaiting_human' | 'awaiting_review' }`。
- `runLoopWrapperNode`（`:1000-1048`）的 for 循环只显式 match `canceled` / `failed`，**`awaiting_*` 直接落穿**，进入 exit_condition 评估；典型 exit_condition（监视 Agent 真实输出端口）评不出来，于是 `i++` 进入下一轮，再起一个 Agent run、再排一条 clarify。重复 `maxIterations` 次。
- `runGitWrapperNode`（`:1072-1142`）同一种缺陷：awaiting_* 被吞、直接 `gitDiffSnapshot` 算 diff、把 wrapper 标 `done`。下游基于错误 diff 继续跑；用户答 clarify 之后，`submitClarifyAnswers` mint 的 Agent rerun 行没有任何调度入口，成为孤儿。

这是一个**静默正确性 bug**——产生 N 条幽灵 review / clarify、wrapper 计算出错误 diff、答完也没人消费——不仅仅是 UX 烦人。`packages/backend/tests/` 下 20 个 `*clarify*` 测试 + review 套件都没覆盖 "wrapper 内含人工节点" 这条正交维度，所以 bug 在 RFC-023 / RFC-005 落地后至今活了多个版本没有被发现。

## 2. 目标

1. **Wrapper 必须上抛 awaiting_***：`wrapper-loop` 和 `wrapper-git` 在内层 scope 返回 `awaiting_human` / `awaiting_review` 时，返回同样 kind 给上层调度器；不进入下一轮、不计算 diff、不进入终态。
2. **Wrapper 状态镜像内层挂起态**：wrapper 自身的 `node_runs.status` 在内层挂起时同步标 `awaiting_human` / `awaiting_review`（同一 `recomputeTaskStatus` 优先级链路），让 UI 一眼看出"是 wrapper 在等人"。
3. **Wrapper 持久化进度，可在原 iteration / 原 baseline 续跑**：`node_runs` 新增 `wrapper_progress_json` 列，存当前 loop iteration 或 git baseline 等续跑必需上下文。Dispatcher 在重入时识别 wrapper 处于挂起态 → 调用 wrapper 的 resume 路径（不重新 init、不从 iter 0 重启、不重新 capture baseline）。
4. **用户答 clarify / 决定 review 之后正确续跑**：`submitClarifyAnswers` / `submitReviewDecision` mint 的 Agent rerun 行能被 wrapper resume → `runScope` 内的 `rescanScopeForNewPendingRows`（RFC-023 bug 13 引入）正确拾起 → Agent 续跑 → wrapper 在原 iteration 评估 exit_condition / 算 diff → 决定继续 / 结束。
5. **既有 wrapper 行为零退化**：`wrapper-loop` 的 exit_condition 三种 kind（port-empty / port-not-empty / port-equals / port-count-lt）、`wrapper-git` 的 baseline+diff 语义、嵌套（loop in git / git in loop / loop in loop）、cancellation 路径全部保留契约。
6. **测试矩阵补足**：5 个 broken 场景每个一条 scheduler 测试（loop+clarify / loop+review / git+clarify / git+review / loop 内 multi-process），加 clarify-answer-resume / review-decision-resume / 残留迭代不能跨清晰边界等 7+ 条新测试。
7. **多人协作安全**：本 RFC 仅触碰 wrapper 调度路径 + nodeRuns schema + 新增测试；与正在 in-flight 的 RFC-036 多用户协作 / RFC-038 agent deps 自动识别完全正交，rebase 时只在 `nodeRuns` 表声明追加列。

## 3. 非目标

- **不改 wrapper 的产品语义**：max_iterations / exit_condition 三种 kind / git baseline 语义 / 嵌套规则一律不动。
- **不改 clarify / review 的产品语义**：clarify_session 生命周期、reuse 规则、`clarify_iteration` 计数、review_doc_versions 决策语义保持现状。
- **不引入新 wrapper kind**（如 wrapper-await / wrapper-pause），不在 workflow definition 里加任何字段，YAML import / export 零改动；不 bump workflow `schema_version`。
- **不改 dispatcher 对 awaiting_* 的 task-level 处理**（`scheduler.ts:218-232` 的 `runOnce` 终态分流），只在 wrapper 内部加一层正确的上抛。
- **不重写 wrapper-loop 的内部循环为事件驱动 / 一 iteration 一个 dispatch tick**——本 RFC 用最小改动的"上抛 + 持久化进度 + resume re-call"模式，不动到 dispatcher 的主控制流。事件驱动重写是更大的 follow-up，超出本 RFC 范围。
- **不改 review-iterate / single-node retry / loop 跨 iter 强制 isolated** 等已有路径（`scheduler.ts:2107` 附近 review reject path / fanout retry / RFC-026 inline session 规则）。
- **不改 daemon 重启恢复策略**：本 RFC 让重启**后**新创建的 wrapper 行带 progress，旧 wrapper 行（progress 列为 NULL）保持当前 daemon-restart 行为（init 路径从 iter 0 重启）。这是已知 caveat 而非回归。
- **不新增 wrapper 自定义"continue-on-awaiting"逃生口**——awaiting_* 永远上抛，没有"忽略反问继续轮"这种开关。若用户确实要并发 N 轮反问，应使用 multi-process 节点（已正确 park）而非 wrapper-loop。

## 4. 用户故事

### US-1 — 循环修复 + 反问

> Alice 配了一个 `wrapper-loop(maxIterations=10)`，内含 `agent-fixer + clarify`，期望 Agent 每一轮根据上一轮 diff 决定是否还要继续修。Agent 第一轮跑到一半提了一个 clarify（"你想修哪一类 lint？"）。Alice 在 inbox 答了"只修 unused-vars"。**期望**：Agent 在**第 0 轮**收到答案续跑、产出 fix；exit_condition 评估；如果没 break，进第 1 轮。**今天**：10 轮 Agent 排队跑、产生 10 条同样的 clarify，Alice 看到 inbox 里 10 个"你想修哪一类 lint？"问号，无论怎么答任务都修不出东西。

### US-2 — 循环修复 + 人工审查

> Bob 配了 `wrapper-loop(maxIterations=5)` 内含 `agent-writer + review`，期望 Agent 每轮写一段文档、人审决定 accept/reject/iterate。Agent 写完第 0 轮的文档、review 节点进入 awaiting_review。**期望**：循环挂起等 Bob 决定；Bob accept → 评估 exit_condition → break；Bob reject → 第 1 轮 Agent 看 review 评论重写。**今天**：循环不等 Bob，直接连写 5 版，5 个 review_doc 同时进 awaiting_review；Bob 只能挨个对，且即使他对完决策 wrapper 已经 exhausted，决策也无效。

### US-3 — Git wrapper + 反问

> Carol 配了 `wrapper-git ∋ agent-refactor + clarify`，期望"Agent 改完 repo / 中间问了 Carol / Carol 答完再继续 / wrapper 算最终 diff"。**期望**：Agent 提 clarify → wrapper 挂起、不算 diff；Carol 答完 → Agent 续跑、改文件 → wrapper 算 final diff。**今天**：Agent 提 clarify 瞬间 wrapper 把"半成品工作树"算成 diff、marks done、下游基于半成品 diff 跑；Carol 答完没人消费，Agent rerun 行成孤儿。**这条最危险**——它产出了一个看似成功但完全错误的 diff，下游 Agent / 测试都在错误前提上工作。

### US-4 — 循环 + 多进程（fanout）

> Dave 配了 `wrapper-loop(maxIterations=3) ∋ multi-process(agent-shard, sourcePort=git_diff)`。预期每轮把上一轮 diff 重新 fanout、shard 各跑一轮、可能问 clarify。Agent 每个 shard 提一个 clarify 等于一轮内 N 个并发 clarify（multi-process 自身正确 park）。**期望**：本轮 N 个 clarify 全部答完 → 进入下一轮、新一组 fanout、新 N 个 clarify。**今天**：本轮 N 个 clarify 一进 awaiting_human、wrapper-loop 把信号吞了直接进下一轮、再 fanout 一组 N → 3 轮下来 3×N 条 clarify 满屏。

### US-5 — 用户答完应该看到任务真的恢复

> 在前 4 个故事的"答完之后"，用户期望 `/tasks/$id` 状态从 `awaiting_human` 自动回到 `running`、wrapper 节点的 chip 从黄色挂起态变绿/红、最终 task 收尾。**今天**：答完后状态原地不动（wrapper 早已终态、不再重入）；用户只能 cancel 重启。

## 5. 验收

- **AC-1**：DB migration `0022_rfc040_wrapper_progress.sql` 跑完后 `node_runs.wrapper_progress_json` 列存在，类型 `TEXT NULL`，老行 NULL。
- **AC-2**：`wrapper-loop ∋ {agent, clarify}` 跑到 Agent 抛 clarify → **仅 1 条 clarify_session 行**（不是 maxIterations 条），wrapper `node_runs.status = 'awaiting_human'`，task 状态 `awaiting_human`，`wrapper_progress_json` 含 `{kind:'loop', iteration:0, phase:'awaiting'}`。
- **AC-3**：续接 AC-2，用户 POST `/api/clarify/sessions/{id}/answers` → Agent rerun 行被 wrapper resume 路径调度 → Agent 这次正常出 port → exit_condition 评估 → 若 break wrapper 落 `done`，否则进 iter 1。
- **AC-4**：`wrapper-loop ∋ {agent, review}` 同等效：1 条 review_doc，wrapper `awaiting_review`，用户 accept/reject 后续跑。
- **AC-5**：`wrapper-git ∋ {agent, clarify}` 跑到 clarify → **不计算 diff**（`nodeRunOutputs` 表无 git_diff 行），wrapper `awaiting_human`；答完后 Agent 续跑 → wrapper 之后才算 diff，且 diff 反映完整工作（含 clarify 前后所有改动）。
- **AC-6**：`wrapper-loop ∋ multi-process(agent)` 一轮 N shard、每 shard 抛 clarify → 一轮 N 条 clarify、wrapper 不进下一轮；用户全部答完后 → wrapper 评估 exit_condition → 决定续 / 停。
- **AC-7**：嵌套场景 `wrapper-git ∋ wrapper-loop ∋ {agent, clarify}` 同样正确上抛——内 loop 把 awaiting 上抛给外 git，外 git 不算 diff、不 marks done，等内 loop resume 完才算最终 diff。
- **AC-8**：daemon 重启场景（杀进程再起）：wrapper 持久化的 `wrapper_progress_json` 仍在 → 重启后 dispatcher 识别挂起 wrapper、resume 续跑；clarify_session / review_doc 行不被重复创建。
- **AC-9**：取消任务（POST `/api/tasks/$id/cancel`）在 wrapper 挂起态生效——wrapper `node_runs.status = 'canceled'`、未答的 clarify_session 行保留（按现有 RFC-023 §5.2）。
- **AC-10**：既有 wrapper 测试零退化——`scheduler-wrapper-*.test.ts` / `scheduler-loop-*.test.ts` / `scheduler-git-*.test.ts` 全部跑通；既有 clarify / review 测试零退化（含 `scheduler-clarify-mid-batch.test.ts` 等 20 条 clarify 测试 + review 系列）。
- **AC-11**：本地 `bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions HEAD CI 六 jobs 全绿。
- **AC-12**：新增测试 ≥ 12 条（详见 design.md §6）。
- **AC-13**：multi-person working tree 安全 —— 不删 / 不改他人 untracked 文件，commit 仅按路径精确 `git add` 自己的改动。

## 6. 风险

1. **Resume 路径的并发安全性**：用户答 clarify 时 `submitClarifyAnswers` 调 `resumeTask`，但 task 可能本来就 `running`（旁路 scope 仍在跑）。当前 `runScope` 已经有 RFC-023 bug 13 引入的 `rescanScopeForNewPendingRows` 解决跨批次拾取。本 RFC 在 wrapper 层加 resume 不能破坏这条契约——design.md §4.3 钉死："wrapper resume 等价于以 wrapper_progress_json.iteration 为参数重新调用 runScope，进入 rescan 路径"。
2. **wrapper_progress_json 损坏 / schema 漂移**：v1 字段简单（kind + iteration + baseline + phase），若未来需要追加新字段不破坏旧值，统一走 zod `.passthrough()`；parse 失败 → 视为"未持久化进度"走 init 路径（最坏退化到当前 bug 行为，可观察）。
3. **既有 in-flight wrapper 行升级后 progress 列为 NULL**：daemon 升级前的 running wrapper 没有 progress，重启后走 init 路径 → 从 iter 0 重启（**与当前升级体验一致，无回归**）。文档 release note 提一句即可。
4. **resume re-call runScope 会不会重复创建 clarify_session**：现有 `clarify.ts:118-176 createClarifySession` 已经按 `(clarify_node_id, source_shard_key, iterationIndex)` 幂等。同一 iteration 内 resume 重入不会双开。
5. **wrapper 的 `node_runs.status = 'awaiting_*'` 是否被其它消费者误判终态**：grep 结果显示当前 `awaiting_*` 已经是合法 status（`scheduler.ts:87,1495`、review.ts、clarify.ts 都识别）。本 RFC 仅扩大其使用面。需要审一遍 frontend `TaskStatusChip` / `NodeStatusChip` 是否能正确渲染（应该可以，因为 review/clarify 节点本来就用这些 status）。
6. **wrapper resume 与 `recomputeTaskStatus` 优先级**：现有优先级 `canceled > awaiting_human > awaiting_review > failed > ok`（`scheduler.ts:337-339`）不动；wrapper 标 awaiting_* 自然进入这套优先级。
7. **multi-process 内嵌 clarify 在 wrapper-loop 里的乘性效应**：当前 multi-process 自身正确 park（`scheduler.ts:1373, 1413`），bug 完全发生在 wrapper-loop 这层。本 RFC 修了 wrapper-loop，乘性效应消失，不需要碰 multi-process。
8. **review-iterate 的"retry from review"路径**：review 决策 = iterate 时 scheduler 给 source agent mint retry 行（`scheduler.ts:2107` 附近）。如果该路径与 wrapper-loop resume 同时触发（review 在 wrapper 内），需要确认 retry 是给的 iter N 还是 iter 0；当前实现已按 review 的 iteration 字段 mint。design.md §4.5 复检并加守卫测试。
9. **跨 iteration 的 wrapper resume 漏调**：如果 wrapper iter N 完成后 i++、之后才被中断（极少见），resume 应该从 iter N+1 续，不能回退到 iter N。phase 字段（`'inner-running' | 'awaiting' | 'iter-done'`）显式区分，避免歧义。
10. **写测试时 mock-opencode 已有的 clarify stub**：现有 e2e 用 `stub-opencode-clarify.sh` 状态机驱动；本 RFC 走 backend 单元测试为主（直接构造 db + 调 scheduler，不需要真 opencode），mock 复杂度低。e2e 增不强求。
11. **multi-person**：当前活跃 in-flight RFC（RFC-038）不动 scheduler / nodeRuns；rebase 时仅 nodeRuns 表声明追加列即可。RFC-036 已落 main。

## 7. 备选方案

- **方案 A（已选）**：wrapper 上抛 awaiting_* + persist progress + resume re-call runScope。最小改动面，复用 RFC-023 bug 13 已有的 rescan 机制。
- **方案 B（被否）**：wrapper 退化为"调度声明"——每 iteration 作为独立 dispatch 单元、由主 dispatcher 驱动迭代。优点：彻底事件驱动、wrapper 实现极简。缺点：把 wrapper 控制流从局部 for 循环解构到全局调度状态机，改动面巨大；与 wrapper-git baseline 语义、嵌套 wrapper 都需要重新设计；和当前 task-level dispatch 模型脱节。RFC-040 不动主控制流。
- **方案 C（被否）**：wrapper 内显式阻塞等待用户输入（同步 promise 等 clarify 答完）。优点：续跑天然不需要 persist 进度。缺点：daemon 重启即丢上下文、长时间 awaiting 锁住进程内 promise、与 task-level cancel 信号难以协调、违反"daemon 重启可恢复"原则。
- **方案 D（被否）**：在 workflow 定义里加 `pauseOnAwait: boolean` 让用户显式选择"挂起 vs 继续轮"。缺点：今天的"继续轮"行为没有任何场景是正确的（10 条幽灵 clarify、错误 diff），不需要给用户开关；正确行为应该是默认且唯一行为。
- **方案 E（被否）**：只修 wrapper-loop 不修 wrapper-git（两个 RFC）。缺点：用户问答阶段已确认"一个 RFC 覆盖两个 wrapper"——同源代码模式 + 同 schema 变更，分两次实现等于两次回归 + 两次设计讨论，得不偿失。
