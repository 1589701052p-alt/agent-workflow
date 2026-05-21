# RFC-052 — review 节点在上游 retry 级联后卡死 awaiting_review（产品视角）

## 背景

线上 task `01KS1N8WVZWE8FTR4K9WSETRNW`（贪吃蛇设计稿评审）暴露了一个稳定可
复现的 bug：用户对 v5 doc_version 点过"通过"之后，详情页**自动又出现一份
v6 待评审**，看上去什么都没改，只是版本号 +1；用户再次"通过" v6，仍然
回到"等待评审"状态——但这次 UI 再也找不到任何待决策的 doc_version，
任务永远卡在 `awaiting_review`，下游 output 节点没产出，任务详情页的所有
状态 chip 都对不上 doc_versions 表里的实际决策。

DB 实测：

- `tasks.status = 'awaiting_review'`
- `node_runs(rev_976wza, retry=0).status = 'awaiting_review'`，
  `finished_at = 1779329208140`（= v5 的 `decided_at`，**不是** v6 的）
- `node_runs(rev_976wza, retry=1).status = 'failed'`，
  `error_message = 'queued for retry'`
- `doc_versions`：v1–v4 `iterated`，**v5、v6 都 `approved`**，
  `review_iteration` 都是 4

形成这个状态的事件链：

1. 用户对上游 `agent_p69bj1` 点 Retry → `retryNode`（`task.ts:643-669`）
   把 `runRow.nodeId` + 所有下游一起 mint retry+1 占位行（status=failed +
   `errorMessage='queued for retry'`），其中**包括** `rev_976wza`、
   `clarify_*`、`out_*` —— 这些 kind 没有"进程级 retry"语义，但被一视
   同仁地造了占位。
2. agent 重试到 retry=9 时 done。scheduler 的 `latestPerNode`
   （`scheduler.ts:422-431`）按 `isFresherNodeRun`（clarifyIter →
   **retryIndex** → ulid）挑出 rev_976wza retry=1 作为"最新"，status≠done
   → review 留在 `remaining` 里。
3. 进 `dispatchReviewNode`（`review.ts:398-410`）：
   `const reuse = reviewRuns.find(r => r.parentNodeRunId === null)`
   用 `Array.find` 取**第一行**（按插入顺序通常是 retry=0），**与
   scheduler 用的 freshness 比较器不一致**；
   接着无条件 `if (reuse.status !== 'awaiting_review') update status`
   —— 即使这行刚 approve 完为 `done` 也照样改回。于是建出 v6。
4. 用户再次 approve v6 → `submitReviewDecision` 走到
   `db.insert(nodeRunOutputs).values([approved_doc, approval_meta])`
   时撞 `PRIMARY KEY(node_run_id, port_name)`（v5 approve 已写过同一组），
   抛出。`status=done, finishedAt=now` 的 update（`review.ts:1145-1148`）
   **未执行**，于是 `finished_at` 仍停在 v5 approve 时刻，且 `resumeTask`
   也不会被调用（路由 `routes/reviews.ts:170` 在 service 抛后直接返回错误）。
5. 但 v6 的 doc_version 已经先一步被改成 `approved`（`review.ts:1080-1096`
   早于 outputs insert），row-side review_comments 也已删除。此后任务永远
   卡死：node_run 还在 awaiting_review，没有 pending doc_version 可供决策。

## 目标

- **修掉"approve 后回弹"**：review 节点一旦该 row 已 approved 落入终态
  （`done`），任何后续 scheduler 扫描都不应把它复位到 `awaiting_review`、
  也不应再 mint 同一 `review_node_run_id` 的新 doc_version。
- **修掉"上游 retry 级联给 review/clarify/output mint 占位"**：这三类
  非进程节点本来就没有进程级 retry 概念，retryNode 不该给它们造
  `queued for retry` 行——这是后续所有交叉态错位的源头。
- **修掉"approve 第二次撞 UNIQUE 静默丢状态"**：即便上游修了占位行问题，
  approved 路径上的 `nodeRunOutputs.insert` 也要保证幂等（重复 approve
  不会把 node_run 留在中间态）。
- **修掉这条线上的卡死 task**：提供一次性 SQL fix-up，把
  `01KS1N8WVZWE8FTR4K9WSETRNW` 推到合理终态（review 行 done、output
  绑定补齐、task 推下游）。

## 非目标

- 不重写 review 节点的状态机模型。当前模型（一个 review row 上靠
  `reviewIteration` 滚动、`status ∈ {pending, awaiting_review, done}` 三态）
  够用，本 RFC 只修边缘交互。
- 不改 `isFresherNodeRun` 比较器的语义（clarifyIter → retryIndex → ulid）；
  review 节点的特殊性靠"上游级联不再 mint review/clarify/output"消除
  即可。
- 不动评审 UI / 评论 / 历史版本展示路径——所有问题都在 scheduler +
  service 层。

## 用户故事

- **设计师**对一篇评审文档反复迭代 4 轮，最后一轮中途想"先让 agent
  重跑一遍"于是对上游 agent 点 Retry。等 agent 重跑完出来一份新版本，
  评审通过。**期待**：任务进入下游 / done；**实际**：v5 approved，
  v6 又冒出来；再 approved，任务永远停在 awaiting_review。
- **运维**接到用户反馈这条 task 卡住，进 DB 一看 doc_versions 全 approved
  但 node_run 还是 awaiting_review。**期待**：有一份明确的 fix-up 步骤
  把这条 task 推到 done，且类似 task 不会再产生。

## 验收标准

1. 在干净 e2e（agent → review）环境里复现：v(n) iterated 后立刻对上游
   agent 点 Retry，agent 重跑完，dispatchReviewNode 不再把已 approved 的
   row 复位；用户对新版本 approved 后 task 进入下游 / done。
2. `retryNode(...)`：targets 收集时跳过 kind ∈ {review, clarify, output,
   input} 的节点，**不**给它们插 `queued for retry` row。已有的
   review/clarify/output 节点单元测试不应回归。
3. `submitReviewDecision`（approved 分支）的 outputs insert 改为
   `ON CONFLICT(node_run_id, port_name) DO UPDATE SET content=excluded.content`
   或先 delete 再 insert，保证幂等；node_run 的 `status=done` + `finishedAt`
   update **总是**执行到位（不依赖 outputs insert 不抛）。
4. 新增锁回归的单测，至少覆盖：
   - 上游 retry 级联不再为 review/clarify/output mint 占位行。
   - approved 之后再次走 dispatch（resume 路径）不会把该 row 重置回
     awaiting_review、也不会创建新 doc_version。
   - 同一 review_node_run 重复 approve 不破坏 nodeRunOutputs 唯一性、
     且 node_run 最终态确定为 done。
5. 一次性 fix-up：手写 SQL（或 ts 脚本）跑完后 task
   `01KS1N8WVZWE8FTR4K9WSETRNW` 的 status 推到合理终态，UI 上不再卡
   "awaiting_review"。
