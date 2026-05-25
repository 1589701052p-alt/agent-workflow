# RFC-056 patch 2026-05-25 — `isFresherNodeRun` 必须把 `crossClarifyIteration` 纳入比较

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up（第六份 RFC-056 patch）。
Scope: bug-fix patch。按 `CLAUDE.md` RFC workflow §6 例外条款，
作为 RFC-056 patch 落档而非独立 RFC。

Pairs with（同根因 / 同症状的前序 patch）：

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)
- [`patch-2026-05-25-questioner-rerun-bumps-cci.md`](./patch-2026-05-25-questioner-rerun-bumps-cci.md)
- [`patch-2026-05-25-questioner-cascade-no-skip.md`](./patch-2026-05-25-questioner-cascade-no-skip.md)
- [`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)

## 1. Symptom (live task `01KS7FAW50V9KV2SPH859NV8ER`)

工作流 `01KS7C0K5ZRJ29AZD7J13C42C2`（"跨节点反问"）拓扑：

```
in_0ck111 ─requirement─▶ agent_m7p3n1 ─doc─▶ rev_5h9xpz ─approved_doc─▶ ...
                                                                          ▲
                              cross_clarify_6c910f ───────────────────────┤
                                       │                                   │
agent_b48d63 (questioner) ─docpath─▶ rev_cbkatx ─approved_doc─▶ out_hdp1q4
```

事件链：

1. `agent_b48d63` retry=0（cci=0）失败 — `clarify-questions-malformed`
   （JSON 内含中文"零"等汉字数字）。
2. `agent_b48d63` retry=1（cci=0）走 RFC-042 same-session followup，
   退出码 0、**status=done**，但 envelope 类型是 `<workflow-clarify>`
   反问问题，**没有 `<workflow-output>` / `docpath` 端口产物**
   （`node_run_outputs` 该行 0 条）。
3. Cross-clarify session 创建（questioner=`agent_b48d63`、designer=
   `agent_m7p3n1`），`awaiting_human`。
4. 用户答题并选 `continue`。`mintQuestionerRerun`（patch-2026-05-25
   `questioner-rerun-bumps-cci` 已修）正确 mint 新 pending 行：
   `crossClarifyIteration=1, retryIndex=0`。
5. 14 秒后任务被标 `failed`，错误：
   `review node rev_cbkatx: upstream 'agent_b48d63' did not emit port 'docpath'`
   （错误码 `review-source-port-missing`）。

DB 证据 —— `agent_b48d63` 全部 3 行：

| node_run                   | cci | ri  | status  | docpath 端口                        |
| -------------------------- | --- | --- | ------- | ----------------------------------- |
| 01KSEX6H6A8YPK2S9QA3PDSHY0 | 1   | 0   | pending | —（未跑）                           |
| 01KS7GPRZ11RWZ6NTXN2VVAAKR | 0   | 1   | done    | **缺**（只发 `<workflow-clarify>`） |
| 01KS7GNNGSVE497F90ZSJAS0PT | 0   | 0   | failed  | —                                   |

## 2. Root cause — comparator 忽略 `crossClarifyIteration`

`packages/backend/src/services/scheduler.ts:327-339` 的 `isFresherNodeRun`：

```ts
export function isFresherNodeRun(
  candidate: typeof nodeRuns.$inferSelect,
  incumbent: typeof nodeRuns.$inferSelect | undefined,
): boolean {
  if (incumbent === undefined) return true
  if (candidate.clarifyIteration !== incumbent.clarifyIteration) {
    return candidate.clarifyIteration > incumbent.clarifyIteration
  }
  if (candidate.retryIndex !== incumbent.retryIndex) {
    return candidate.retryIndex > incumbent.retryIndex
  }
  return candidate.id > incumbent.id
}
```

只看 `clarifyIteration → retryIndex → id`，**不读 `crossClarifyIteration`**。
`packages/backend/src/services/clarifyRounds.ts:137-149` 的本地副本
`isFresherForCutoff` 同样存在该缺口。

对本 task 的两条候选行（cli 都为 0）：

- pending `(cli=0, cci=1, ri=0)` —— mintQuestionerRerun 刚 mint 的真正
  "本轮重跑"行。
- done `(cli=0, cci=0, ri=1)` —— 上一轮 RFC-042 same-session followup
  跑出的"反问问题"行，**没有产生 docpath**。

`isFresherNodeRun` 在 cli 相等后立刻按 retryIndex 比较：`1 > 0` →
挑中陈旧 done 行。下游 `rev_cbkatx` 进入 `dispatchReviewNode`
（review.ts:390-406），用同一 comparator 选 source run，挑到陈旧 done →
该行 `node_run_outputs` 没有 `docpath` → review.ts:424-429
返回 `review-source-port-missing` → 整个 task 被标 failed。

`patch-2026-05-23-designer-retry-index.md` 已经为 designer 侧打了
"bump retry_index = max+1"绕过 patch；`patch-2026-05-22-downstream-cascade.md`
为下游 cascade 同样 bump retry_index；`patch-2026-05-25-questioner-rerun-bumps-cci.md`
让 questioner mint 时正确把 cci+1。但 questioner mint 路径仍把 retryIndex
hardcode 为 0（`crossClarify.ts:1186`）——因为它"信任 cci 是 freshness 信号"。
comparator 不读 cci 这条 invariant 被打破后，所有"只 bump cci 不 bump
retryIndex"的 mint 路径都会随机踩坑：只要历史上有 retryIndex>0 的 done 行，
新 mint 的 cci=N 行立刻被压住。

旧 patch（特别是 2026-05-23 / 2026-05-22）的注释都已经把这个缺陷点出来：

```text
scheduler's `isFresherNodeRun` (keyed on clarifyIteration + retryIndex + id,
NOT crossClarifyIteration) ALWAYS picks ...
```

修正策略写在那条注释里——所谓"ALWAYS 选中新行"是靠 retryIndex bump
绕开 comparator 缺陷，本 patch 直接把缺陷修掉。

## 3. Fix — comparator 加 cci 维度

`isFresherNodeRun` 改写为：

```ts
export function isFresherNodeRun(
  candidate: typeof nodeRuns.$inferSelect,
  incumbent: typeof nodeRuns.$inferSelect | undefined,
): boolean {
  if (incumbent === undefined) return true
  if (candidate.clarifyIteration !== incumbent.clarifyIteration) {
    return candidate.clarifyIteration > incumbent.clarifyIteration
  }
  if (candidate.crossClarifyIteration !== incumbent.crossClarifyIteration) {
    return candidate.crossClarifyIteration > incumbent.crossClarifyIteration
  }
  if (candidate.retryIndex !== incumbent.retryIndex) {
    return candidate.retryIndex > incumbent.retryIndex
  }
  return candidate.id > incumbent.id
}
```

排序顺序：`clarifyIteration → crossClarifyIteration → retryIndex → id`。
理由：

- `clarifyIteration` 仍排第一：维持 RFC-023 self-clarify 路径的既有语义；
  comparator 在所有 cci=0 场景下行为字节级不变。
- `crossClarifyIteration` 排在 `retryIndex` 之前：cci bump 是 cross-
  clarify 路径的 freshness 信号，必须凌驾于 process-retry 计数器（任何
  跨 clarify 通信后的 mint 行 cci 一定 > 历史行）；这正是 `mintQuestionerRerun`
  / `triggerDesignerRerun` / `cascadeDownstreamFromDesigner` mint
  时 bump cci 的预期。
- `retryIndex` 保留：同一轮 clarify+cross-clarify 内多次 process-retry
  仍然按 retryIndex 排（RFC-042 same-session followup 等）。
- `id` 兜底 ULID 单调性。

`packages/backend/src/services/clarifyRounds.ts:isFresherForCutoff` 同步
修改，保留"本地副本避免循环依赖"的注释。

## 4. 不退化保证

1. **cci 全 0 路径**（绝大多数 self-clarify / 无 cross-clarify 工作流）：
   两条候选行 cci 都为 0，新的条件 `candidate.cci !== incumbent.cci`
   恒假，fallthrough 到 `retryIndex` 比较 → 与旧 comparator 字节级等价。
   既有 `cross-clarify-retry-preserves-iteration.test.ts` 用例的
   "done(ri=9,ci=6,cci=0) vs pending(ri=10,ci=6,cci=1)"断言（pending
   被选中）也仍然成立：cli 相等后 cci 差异先比 → pending（cci=1）胜出。
2. **`triggerDesignerRerun` 已有的"bump retry_index = max+1"**
   （patch-2026-05-23）：保留，作为深度防御。本 patch 后 cci 比较已经
   足够让新行胜出，retry_index bump 变成 belt-and-suspenders；不必删，
   也不引入回归。
3. **`cascadeDownstreamFromDesigner` 同样 bump retry_index**
   （patch-2026-05-22）：同上，保留。
4. **C7 ulid tiebreak**（`dispatch-multi-row-consistency.test.ts:417`）：
   两条行 ci=0, cci=0, retry=0，fallthrough 到 id 比较，行为不变。
5. **review.ts 内 4 处 `isFresherNodeRun` 调用**（reuse pick、source pick、
   pickFreshestReviewRun 内两次）：
   - source pick（行 405）现在能挑到正确 source run（本 patch 主目标）。
   - reuse / latestDone pick：cci 高的 review 行会被优先选；与 2026-05-26
     patch（`dispatchReviewNode` cci-aware `alreadyDone`）方向一致、互
     不冲突——那条 patch 解决的是"latestDone 存在但 cci 落后于 source"
     的短路问题；本 patch 解决的是"latestDone 自己被错的兄弟行替换"的
     选择问题。两条 patch 落地后语义闭合。

## 5. Tests

新增 `packages/backend/tests/scheduler-fresher-noderun-cci.test.ts`，
4 个 case：

1. **本 task 复现 case**：`done(cli=0,cci=0,ri=1)` + `pending(cli=0,cci=1,ri=0)`
   → comparator 选 pending（修复主断言）。
2. **cli 优先于 cci**：`done(cli=1,cci=0,ri=0)` + `pending(cli=0,cci=5,ri=0)`
   → comparator 选 done。锁定 cli 是最高优先级。
3. **cci 优先于 retryIndex**：`done(cli=0,cci=0,ri=9)` + `pending(cli=0,cci=1,ri=0)`
   → comparator 选 pending。锁定 cci > retryIndex 排序。
4. **同 cli、同 cci → 退回 retryIndex / id 旧语义**：
   `done(cli=0,cci=0,ri=0,id=A)` + `pending(cli=0,cci=0,ri=1,id=B)`
   → comparator 选 ri=1 那条；再用同 ri 的 id 单调测试兜底 ULID 平局。

新增 `packages/backend/tests/clarify-rounds-fresher-for-cutoff-cci.test.ts`，
1 个 case：通过 `computeHistoryCutoff` 间接断言 `isFresherForCutoff` 同
样按 cci 排序——同 cli、cci=1 的 done 行胜出，cutoff 返回 1 而非 0。

文件改动清单：

- `packages/backend/src/services/scheduler.ts`（`isFresherNodeRun` body +
  comment 同步更新）
- `packages/backend/src/services/clarifyRounds.ts`（`isFresherForCutoff`
  body + comment 同步更新）
- `packages/backend/tests/scheduler-fresher-noderun-cci.test.ts`（新文件，4 case）
- `packages/backend/tests/clarify-rounds-fresher-for-cutoff-cci.test.ts`
  （新文件，1 case）

运行：

```
bun run typecheck && bun run test && bun run format:check
```

按 [feedback_post_commit_ci_check]，push 后立刻查 GitHub Actions。

## 6. Out of scope

- **不动 `mintQuestionerRerun` / `triggerDesignerRerun` / `cascadeDownstreamFromDesigner`
  的 retryIndex bump 逻辑**：这些 bump 现在变成 belt-and-suspenders，不
  删（删它们等于把"comparator 修对了"和"mint 行能被 dispatch"两条
  invariant 耦合到一行代码上，未来 comparator 一旦再被人误改即全军覆没）。
- **不改 `dispatchReviewNode` 的源选择代码**：该函数复用 `isFresherNodeRun`，
  修了 comparator 就自动修了 source 选择，零本地改动。
- **不改 schema / migration**：纯运行时 comparator 修复。
- **不改 cross-clarify session 数据流**：仅改 freshness 比较语义。
- **不改 RFC-023 self-clarify 路径**：cci=0 时行为字节级不变。

## 7. 实时任务恢复

任务 `01KS7FAW50V9KV2SPH859NV8ER` 已落 `status=failed`、`finished_at` 标记
2026-05-25 14:30:01。本 patch 落地后**不会**自动 resume 已 failed task。
用户如需继续此任务，需走"重试节点 / 重新 launch"现有交互；本 patch 仅
确保此后再触发同形态 task 不会重蹈覆辙。
