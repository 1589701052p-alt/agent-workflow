# RFC-056 patch 2026-05-26 — review dispatch must respect crossClarifyIteration

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (fifth patch under RFC-056).
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception,
documented as an RFC-056 patch rather than a new RFC.

Pairs with:

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)
- [`patch-2026-05-25-questioner-cascade-no-skip.md`](./patch-2026-05-25-questioner-cascade-no-skip.md)

## 1. Symptom (live task 01KS86DPCSERV7S41GQA5Y81RN, fifth visit)

Workflow `01KS7C0K5ZRJ29AZD7J13C42C2`（"跨节点反问"）topology:

```
in_0ck111 ─requirement─▶ agent_m7p3n1 ─doc─▶ rev_5h9xpz ─approved_doc─▶ agent_b48d63 ─doc─▶ rev_cbkatx ─▶ out_hdp1q4
                              │                                              ▲   │
                              │            cross_clarify_6c910f ─to_q───────┘   │
                              │                  ▲    │                          │ __clarify__
                              │ __ext_fb__       │    └── to_d ──────────────────┘
                              └──────────────────┘
```

User observes: 每次 cross-clarify 重跑后 `agent_m7p3n1` → `agent_b48d63`
直跑、**`rev_5h9xpz` 从未在 cci > 0 上再跑过一次**。

DB evidence — `rev_5h9xpz` 全部 4 行：

| node_run | ri | cci | status       | started_at | finished_at      |
|----------|----|-----|--------------|------------|------------------|
| NXA731   | 0  | 0   | done         | 23:56:13   | 00:11:57         |
| 45E40E   | 1  | 1   | interrupted  | **null**   | 02:07:45         |
| VR6DAG   | 2  | 3   | interrupted  | **null**   | 08:46:48         |
| QEXMDH   | 3  | 4   | pending      | **null**   | –                |

后三行都是 `cascadeDownstreamFromDesigner`（patch-2026-05-22 + 2026-05-25
之后）真实 mint 出来的，但**从未被 dispatch**：`startedAt = null`，要么被下一轮 cascade /
daemon 重启冲成 `interrupted`，要么持续 `pending`。同期 `agent_b48d63`
在 cci=1 / 1 / 3 / 4 上各跑了一遍 `done`，每次读到的 `approved_doc` 都是
**NXA731 第一次审查的产物**——`agent_m7p3n1` 经过 9 轮 self-clarify + 多轮 cross-
clarify 不断改写的 `docpath` 从未再走过 review、`b48d63` 后段全部基于陈旧 approved_doc 闭环空转。

## 2. Root cause — `dispatchReviewNode` 的 `alreadyDone` 短路

`packages/backend/src/services/review.ts:418-427`：

```ts
let reuse: (typeof reviewRuns)[number] | undefined
let alreadyDone = false
for (const r of reviewRuns) {
  if (r.parentNodeRunId !== null) continue
  if (r.status === 'done') alreadyDone = true
  if (isFresherNodeRun(r, reuse)) reuse = r
}
if (alreadyDone) {
  return { kind: 'ok', summary: '', message: '' }
}
```

短路语义是 RFC-052 防御：同一 iteration 上只要存在任意一行 `done`、就视作 review
已审完，scheduler 不再 dispatch（防 retry placeholder 误升 awaiting_review 的回归）。

**该短路完全无视 `crossClarifyIteration`。** Cross-clarify cascade 在更高 cci
mint 出来的 pending review 行无论何时夹带，遇见 cci=0 那条历史 done 都立刻被
打回 `kind: 'ok'`、不再分发。Cascade 看似在工作（pending 行确实写入了 DB），
但 dispatcher 永远不会触碰它们；scheduler 把 review 节点归入 `completed`
通过 `latestPerNode → status='pending'` 走 `applyCrossClarifyFreshnessInvariant`
也救不回来——invariant 只 demote `completed` 集合内的节点、对 dispatch 短路掉
的 review 没有效力。

下游 `agent_b48d63` 不是 review 节点，走的是正常 agent dispatch 流程：
upstream `rev_5h9xpz` 在 scheduler 的 `latestPerNode` 视角下被认为已经 done
（NXA731 ri=0 输给 45E40E ri=1，但**只要 dispatchReviewNode 不动 45E40E**、
runScope 下一次 rescan 看到的 latestPerNode 仍然停在 pending 行→ scheduler
进入 awaiting/stall→ 但 b48d63 的 cascade-minted 行此时已经被 `latestPerNode`
选中`status=pending`、ready 检查 `ups.every(completed)` 也通过——因为
runScope 在 cascade mint 之前的旧迭代里已经把 rev_5h9xpz 的 NXA731 done 归入
completed，这一帧的状态尚未被 invariant 推翻——所以 b48d63 跑了起来）。

简而言之：

- **Layer A** (`cascadeDownstreamFromDesigner`) 正常 mint review pending 行；
- **Layer B** (`applyCrossClarifyFreshnessInvariant`) 不操作 review；
- **dispatcher** 短路掉 review → review pending 行永远不出闸；
- 下游 `agent_b48d63` 在拿到 cascade mint 的同时进入 ready set，读到陈旧 approved_doc 即跑。

## 3. 修复 — `dispatchReviewNode` cci-aware `alreadyDone`

将 `dispatchReviewNode` 中的 `alreadyDone` 短路改写为**与 upstream cci 对齐**：
仅当存在一条 `done` review 行的 `crossClarifyIteration` ≥ `sourceRun.crossClarifyIteration`
时才短路；否则 cascade 已经把 upstream 推到更高 cci、prior 审批不再覆盖当前
upstream → 必须分发 pending 行。

### 3.1 落码（review.ts 局部深重构）

抽两个 helper 到模块顶部（便于直接 unit-test 不必拉起 dispatchReviewNode）：

```ts
interface ReviewRunsPicked {
  reuse: typeof nodeRuns.$inferSelect | undefined
  latestDone: typeof nodeRuns.$inferSelect | undefined
}

/**
 * Pick the freshest top-level review row (`reuse`) and the freshest
 * top-level done review row (`latestDone`) from a list of review_runs for
 * one (taskId, nodeId, iteration). Skips fan-out child rows. Uses
 * isFresherNodeRun (clarifyIteration → retryIndex → ulid) as the
 * comparator — same one the scheduler picks `latestPerNode` with.
 */
export function pickFreshestReviewRun(
  reviewRuns: ReadonlyArray<typeof nodeRuns.$inferSelect>,
): ReviewRunsPicked {
  let reuse: typeof nodeRuns.$inferSelect | undefined
  let latestDone: typeof nodeRuns.$inferSelect | undefined
  for (const r of reviewRuns) {
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, reuse)) reuse = r
    if (r.status === 'done' && isFresherNodeRun(r, latestDone)) latestDone = r
  }
  return { reuse, latestDone }
}

/**
 * RFC-056 patch-2026-05-26: a review's prior `done` approval covers the
 * upstream state at THAT row's `crossClarifyIteration`. When the upstream
 * source agent has subsequently re-run via cross-clarify cascade and now
 * sits at a higher cci, the prior approval is stale and the cascade-
 * minted pending review row MUST run — even though RFC-052 originally
 * declared "any done row in this iteration is decisive".
 *
 * Returns true iff `latestDone` exists AND its cci is at least as fresh
 * as the upstream source row's cci (i.e. the approval is still valid for
 * the upstream output that the review would now be looking at).
 */
export function isReviewCciAlignedWithUpstream(
  latestDone: typeof nodeRuns.$inferSelect | undefined,
  sourceRun: typeof nodeRuns.$inferSelect,
): boolean {
  if (latestDone === undefined) return false
  return (latestDone.crossClarifyIteration ?? 0) >= (sourceRun.crossClarifyIteration ?? 0)
}
```

然后 `dispatchReviewNode` 内部替换为：

```ts
const { reuse, latestDone } = pickFreshestReviewRun(reviewRuns)
if (isReviewCciAlignedWithUpstream(latestDone, sourceRun)) {
  return { kind: 'ok', summary: '', message: '' }
}
```

`reuse` 后续逻辑保持不变（pending → awaiting_review transition / fresh mint
分支等）。`latestDone` 只用于 alignment 判定，不参与 reuse 选择——这点很重要：
当 cci 错位时，cascade-minted pending 行就是要 dispatch 的目标，不能因为某条
done 行存在而被 reuse 替换。

### 3.2 RFC-052 invariant 不退化

RFC-052 patch 锁定的"retry placeholder 不会被误升 awaiting_review"现象在 cci=0
（即没有任何 cross-clarify 发生过的工作流）下行为字节级不变——`sourceRun.cci=0`
+ `latestDone.cci=0` → `isReviewCciAlignedWithUpstream === true` → 仍走 `kind: 'ok'`
短路。

### 3.3 RFC-056 canonical 不退化

RFC-056 canonical（designer ↔ questioner 直连、无 review 在中间）压根不进
`dispatchReviewNode`，零影响。

### 3.4 RFC-058 scope=questioner 不退化

RFC-058（仍在 Draft）"全题 scope=questioner"路径下 designer 不重跑、cci 不 bump、
review 不重 mint pending 行 → 与 cci=0 路径同形态、无回归。RFC-058 落地后只需
在该 patch unit test 里补一条 case：scope=questioner cascade rerun 触达 review
dispatch 时 cci 不 bump→ alignment 返回 true→ 短路 → 不要求人重新审。

## 4. 实时任务恢复（`scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts`）

任务 01KS86DPCSERV7S41GQA5Y81RN 已经在生产里跑到 cci=4、user 多轮答 cross-clarify、
m7p3n1 最新 done = `B7P1T8`（cci=4 docpath 已写新内容）、b48d63 最新 done = `5K080W`
（cci=4 但消耗陈旧 approved_doc）、cross_clarify_6c910f 当前 `C78YX0` awaiting_human。

恢复策略（user 选择"跳到最新 cci 重审 / 先取消后重走上游"）：

1. **dry-run 默认**。脚本接 `--task-id <id>` + `--apply` 才落 DB 改动；不带 `--apply`
   只打印计划。
2. **取消 C78YX0**：`transitionNodeRunStatus({ kind: 'abandon-cross-clarify' })` →
   cross_clarify_sessions.status = 'abandoned'、node_runs.status = 'done'（abandoned
   状态机沿用 RFC-053 CR-1 invariant 升级路径）。无新 Q&A 注入。
3. **激活 QEXMDH**：把 rev_5h9xpz 在该 task 上**比 QEXMDH 新但被 daemon-restart 弄成
   interrupted-with-startedAt=null** 的中间行（45E40E / VR6DAG）保留 interrupted（已是
   终态、不动；它们的 cci < QEXMDH.cci，不会被 isFresherNodeRun 选中）。QEXMDH 本身
   保持 pending；后续 `resumeTask` 进入 runScope 时 latestPerNode → QEXMDH (pending)、
   completed 不含 rev_5h9xpz、ready 检查通过、dispatchReviewNode 在新版本下不再短路
   → QEXMDH 进 awaiting_review。
4. **新 mint b48d63 cci=4 ri=10 pending**（max(`5K080W.ri=9`) + 1）。这一行在
   QEXMDH 被人 approve 后会被 scheduler 用 latestPerNode 选中、dispatch 时读 QEXMDH
   的新 approved_doc。
5. **新 mint rev_cbkatx + out_hdp1q4 cci=4 ri+1 pending**（沿用 cascadeDownstreamFromDesigner
   的算法继续走完下游 BFS）。idempotent：已有 cci=4 done 的下游节点跳过。
6. **`resumeTask`**。

脚本输出形如：

```
[dry-run] task 01KS86DPCSERV7S41GQA5Y81RN
  cancel cross_clarify_6c910f session C78YX0 (awaiting_human → abandoned)
  reuse rev_5h9xpz QEXMDH (cci=4 pending) for re-review; user must approve in UI
  mint agent_b48d63 ri=10 cci=4 pending  → will consume new approved_doc after approval
  mint rev_cbkatx ri=N cci=4 pending     → cascades after b48d63 finishes
  mint out_hdp1q4 ri=N cci=4 pending     → cascades after rev_cbkatx finishes
  resume task (status: awaiting_human → running)
```

加 `--apply` 后实际落 DB 改动并最终 `console.log('applied')` 标记完工。

## 5. RFC-057 Diagnose Panel 一键修复 rule (新增 S5：cascaded review never dispatched)

加入诊断面板，未来同型现场 user 不必跑脚本就能修：

### 5.1 LifecycleAlertRule "S5"（命名沿 S 系列 cascade-stuck 编号）

`packages/shared/src/lifecycle-alerts.ts` 新增：

```ts
{
  id: 'S5',
  kind: 'task',
  severity: 'warning',
  // Detect: review pending row with startedAt=null AND a done review row at
  // strictly lower cci exists AND the upstream source agent has a done row
  // at the pending review row's cci.
  // Means: cascade minted a fresh review run but dispatcher short-circuited
  // it; downstream nodes that consumed the stale approved_doc are now
  // running on inconsistent data.
}
```

检测逻辑放 `taskAlerts.ts`、用 `lifecycle-alerts.ts` 已有的 `pickFreshestReviewRun`
辅助函数（与 review.ts 共享）。

### 5.2 RepairOptionDef `S5-cci-jump`

`packages/backend/src/services/lifecycleRepair/options-S5.ts`：

```
optionId: 'S5-jump-to-latest-cci-rereview'
preflight: validate stuck pending review row at latest cci is reachable +
           no later session is awaiting_human that would block.
apply:     same logic as scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts
           (extracted into a shared service helper `recoverReviewCascadeStuck`).
```

`recoverReviewCascadeStuck` 同时被脚本（CLI 入口）和 repair option（HTTP 入口）调用，
逻辑单一来源。

### 5.3 i18n（中英对称，~8 个 key）

`lifecycleAlerts.S5.{label,description}`、`repair.S5.jumpToLatestCci.{label,help,preflightOk,applySuccess}`、
`repair.S5.jumpToLatestCci.confirmTitle` / `confirmBody`。

## 6. 测试

新增 backend 测试：

- `packages/backend/tests/review-dispatch-cci.test.ts` — unit 测 helpers + dispatchReviewNode 短路边界：
  1. `pickFreshestReviewRun` 跳过 fan-out child / 选 freshest reuse / latestDone 独立追踪。
  2. `isReviewCciAlignedWithUpstream` 真值表 8 case（undefined / 0/0 / 0/1 / 1/0 / 1/1 / 2/1 / 1/2 / undefined cci 字段视作 0）。
  3. dispatch 短路：`latestDone.cci >= sourceRun.cci` → ok 无 side-effect。
  4. dispatch 非短路：`sourceRun.cci > latestDone.cci` → 走 reuse → awaiting_review transition。
  5. 没有 done 行 → 不短路。
  6. RFC-052 回归锁：cci=0/0 + done row 存在 → 仍短路（不退化）。

- `packages/backend/tests/cross-clarify-cascade-review.test.ts` — 集成测 4 scenarios（user 钦定优先级）：
  1. **主场景** designer→review→questioner：cross-clarify resolve → designer 重跑 cci=N → review pending mint cci=N → dispatch awaiting_review → 测试 driver 模拟 approve → review done cci=N → questioner dispatch with fresh approved_doc。
  2. **canonical 不回归** designer↔questioner 直连：cross-clarify resolve → 不进 review path → 行为字节级与 RFC-056 一致。
  3. **多源 cross-clarify**：两条 cross_clarify_node 指同一 designer + 中间 review；submit 任一 → 其它待提交 → designer-waiting；全部 submit → designer 重跑 → review cascade（两 questioner 各自的 ancestor review 都 mint cci=N pending） → review approve → questioners 各自 dispatch。
  4. **RFC-058 scope=questioner 占位**：`describe.skip("when RFC-058 lands ...", ...)` + TODO comment 指向 RFC-058 plan.md。

- Source-text grep guards（沿 RFC-056 patch 系列风格）：
  - `review.ts` 中 `alreadyDone` 字面不再出现（确保旧短路被替换）。
  - `review.ts` 引用 `isReviewCciAlignedWithUpstream`（确保新短路生效）。
  - 任何调用 `dispatchReviewNode` 的测试帮助函数都用 cci-aware 期望（grep `cci.*<.*=.*sourceRun` 模式）。

新增 frontend / 共享：

- `packages/shared/tests/diagnose-repair.test.ts` 加 1 case：S5 rule 与 S5 option 1:1 绑定。
- `packages/backend/tests/lifecycle-repair-grep-guard.test.ts` 已有"每条 LifecycleAlertRule ≥ 1 RepairOptionDef"
  invariant 自动覆盖。

`bun run typecheck && bun run test && bun run format:check` 三绿是 push 门槛。

## 7. Out of scope

- 调度器侧"pending review 行已停留 X 分钟没人 dispatch 该报警"——监控层面问题，
  上面 S5 lifecycle rule + Diagnose 一键修复已经把用户面承接了，不再加 daemon
  内部告警。
- 自动 approve review（RFC-005 review 节点的人审契约不动）。S5 修复后用户仍需在
  UI 上手动批准 review。
- Multi-tab race 检测 / WS 冲突 — 既有 RFC-053 invariant + RFC-052 reuse pick 已覆盖，
  本 patch 不再扩。

## 8. Rollout

1. Land patch md + code + tests + script + S5 rule/option + i18n + STATE.md/plan.md。
2. CI 三绿后 push。
3. 对 01KS86DPCSERV7S41GQA5Y81RN：用户 / 管理员在本地跑
   `bun scripts/fixup-rfc056-2026-05-26-cci-stuck-review.ts --task-id 01KS86DPCSERV7S41GQA5Y81RN --apply`
   或在 UI 上点 Diagnose → S5 repair → 跳到最新 cci 重审。然后 UI 上 approve `rev_5h9xpz`。
4. 后续同型现场用户自行点 Diagnose 一键修。
