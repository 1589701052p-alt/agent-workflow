# RFC-056 patch 2026-05-27 — questioner aging cutoff must use crossClarifyIteration

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (sixth patch under RFC-056; pairs with
RFC-058 T13 unified aging entry).
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception,
documented as an RFC-056 patch rather than a new RFC.

Pairs with:

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)
- [`patch-2026-05-25-questioner-cascade-no-skip.md`](./patch-2026-05-25-questioner-cascade-no-skip.md)
- [`patch-2026-05-25-questioner-rerun-bumps-cci.md`](./patch-2026-05-25-questioner-rerun-bumps-cci.md)
- [`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)

## 1. 现象

跨节点反问工作流（典型 `designer → questioner → reviewDesign`）：

1. questioner 第一轮跑出 `<workflow-clarify>` 信封；
2. 用户在 `/clarify` 详情页答题、submit；
3. cascade rerun mint 新 questioner 行（`crossClarifyIteration = 1`，
   RFC-056 patch-2026-05-25-questioner-rerun-bumps-cci 之后），上一轮 Q&A
   通过 `__clarify_questions__` / `__clarify_answers__` 注入 → questioner
   产出 `<workflow-output>` markdown；
4. 下游 reviewDesign 对该 markdown 评审、命中 iterate → review-iterate
   mint 新 questioner 行（cci 继承 = 1，retry_index 递增）。

**预期**：第 4 步的 questioner 重跑应该已经把第 2 步的 Q&A "归档"
——`<workflow-output>` 既然产出，那批答案已经织进了 markdown 文本，再注
入一次只会让 agent 重新围着旧问题打转、token 浪费 + 决策回滚。

**实际**：第 4 步 questioner prompt 里依旧出现 `## Clarify Q&A` +
iter=0 那批问题与答案。

## 2. 根因 — scheduler 把 cutoff 喂错了单位

`packages/backend/src/services/scheduler.ts:1413`（patch 前）：

```ts
const priorCompletedCutoff = await computeHistoryCutoff({
  db,
  taskId,
  nodeId: node.id,
  shardKey: currentRunRow?.shardKey ?? null,
  ...(currentRunRow !== undefined ? { currentRunRow } : {}),
  iterationField: 'clarifyIteration',   // ← 始终是 clarifyIteration
})
const historyCutoffClarifyIteration =
  priorCompletedCutoff ?? priorDoneDesigner?.clarifyIteration
```

这个 `historyCutoffClarifyIteration` 被 **同一个变量** 喂给两个不同
consumerKind 的 `buildPromptContext`（line 1463 / 1478），其中
`consumerKind: 'cross-questioner'` 分支读的是 `clarify_rounds` 表中
`kind='cross'` 的行——这些行的 `iteration` 列存的是 cross-clarify
session 的 iteration（= questioner 那次 run 的 `crossClarifyIteration`），
**不是** `clarifyIteration`。

举数据：

- 前一次跑出 markdown 的 questioner row：`clarifyIteration=0`，
  `crossClarifyIteration=1`，并写入了 `node_run_outputs`。
- `computeHistoryCutoff(iterationField='clarifyIteration')` 找到那行作为
  prior completed，返回 `0`。
- 跨节点反问对应的 `clarify_rounds` 行 `iteration=0`、`answered`。
- `applyAgingCutoff(rows, cutoff=0)` 只丢 `iteration < 0` 的行——
  iter=0 行**留下**。
- review-iterate 的新 questioner run `targetIteration=1`，
  `priorRounds.filter(r => r.iteration < 1)` 留下 iter=0 → 注入。

如果把 `iterationField` 改成 `'crossClarifyIteration'`，
`computeHistoryCutoff` 改返回 `1`，`applyAgingCutoff(cutoff=1)` 丢
`iteration < 1` → iter=0 行被剔除 → `buildPromptContext` 返回 `undefined`
→ 干净。

`packages/backend/tests/clarify-rounds-service.test.ts:644`（"cross-questioner
aging fix"）已经为 helper 锁了正确语义——helper 接受任一 `iterationField`
并按对应字段返回 cutoff；问题只在 scheduler 调用方一直传错的字段，所以
RFC-058 §缺口 1 自始未在生产路径上修通。

## 3. 修复 — 按 consumerKind 切 iterationField

`scheduler.ts` 把 `isQuestionerCrossClarifyRerun` 的声明从原先紧贴
`buildPromptContext` 调用的位置**上提到 `computeHistoryCutoff` 调用之前**
（仅一处声明、其它位置照旧引用同名 const），然后用它选择
`iterationField`：

```ts
const isQuestionerCrossClarifyRerun =
  clarifyMode === 'cross' && currentCrossClarifyIteration > 0
const priorCompletedCutoff = await computeHistoryCutoff({
  db,
  taskId,
  nodeId: node.id,
  shardKey: currentRunRow?.shardKey ?? null,
  ...(currentRunRow !== undefined ? { currentRunRow } : {}),
  iterationField: isQuestionerCrossClarifyRerun
    ? 'crossClarifyIteration'
    : 'clarifyIteration',
})
```

### 3.1 不影响 designer 侧

designer 端走的是 `consumerKind: 'self'` 分支
（`hasExternalFeedbackChannel=true` 的 `crossClarifyContext` 是独立的
`buildExternalFeedbackContext` 调用、本身不读 `historyCutoffClarifyIteration`）。
designer 侧的 self-clarify rounds 仍然按 `clarifyIteration` 计 cutoff，
等于 patch 前行为。`priorDoneDesigner?.clarifyIteration` 这条 fallback 同
理只在 designer 侧（`isCrossClarifyTriggeredRerun` 为真时）有意义。

### 3.2 不影响 self-clarify

self-clarify 节点的 `clarifyMode === 'self'`，
`isQuestionerCrossClarifyRerun` 恒为 false → `iterationField` 仍然是
`clarifyIteration`，字节级不变。

### 3.3 不影响 cci=0 路径

`currentCrossClarifyIteration === 0` 时
`isQuestionerCrossClarifyRerun=false`，走老路径——即一个 questioner 节点
还从未触发过任何 cross-clarify 交互的场景。

## 4. 测试

- `packages/backend/tests/cross-clarify-questioner-cutoff-cci.test.ts`
  （新增）：
  1. 集成-级回归：seed 一条 `crossClarifyIteration=1` 的 done questioner
     run + 写 `node_run_outputs` + 一条 `kind='cross'` `iteration=0`
     answered 的 `clarify_rounds`。对比两种 cutoff 路径——
     `iterationField='clarifyIteration'` 时旧 round 被注入（锁住 bug
     形态，避免反向 "fix"），`iterationField='crossClarifyIteration'`
     时 `buildPromptContext` 返回 `undefined`（正确归档行为）。
  2. 源代码 grep 守门：scheduler.ts 必须包含
     `iterationField: isQuestionerCrossClarifyRerun ? 'crossClarifyIteration' : 'clarifyIteration'`
     字面（regex），任何把它改回单写 `'clarifyIteration'` 的回退立刻 CI 红。
- `packages/backend/tests/cross-clarify-update-mode-injection.test.ts`
  （已存在 grep 守门）：因 `isQuestionerCrossClarifyRerun` 声明位置上移，
  patch 前的 regex（要求其紧贴 `const clarifyContext`）需放宽为匹配
  声明行本身。本 patch 同时调整为更稳定的字面匹配 `clarifyMode === 'cross'`
  + `currentCrossClarifyIteration > 0`、不再依赖物理顺序，未来再迁移
  位置不会再次假阳性。

`bun test packages/backend/tests/cross-clarify-*.test.ts
packages/backend/tests/clarify-*.test.ts
packages/backend/tests/scheduler-*.test.ts` 全绿（422 通过 / 0 失败）。
`bun run typecheck` 三个包全绿。

## 5. 不做

- 不动 `computeHistoryCutoff` / `applyAgingCutoff` 的语义（helper 早已
  正确处理 cci-based cutoff，参见
  `clarify-rounds-service.test.ts:194` + `:644`）。
- 不引入新的 `iterationField` 枚举或新的 consumerKind——本 bug 是 scheduler
  调用方"挑错了字段"，不是 helper 缺能力。
- 不动 designer 侧 self-clarify aging（同 §3.1）。
- 不补 frontend 改动——bug 完全发生在 prompt 注入路径上，UI 不感知。

## 6. Rollout

1. Land patch md + scheduler.ts 改动 + 新测试 + grep 守门修复。
2. CI 三绿后 push（按 `feedback_post_commit_ci_check` 推后查 Actions）。
3. 现有任务自然受益：下一次 review-iterate / 下游 cascade 触发的 questioner
   重跑会自动跳过已经被 `<workflow-output>` 吸收的旧 Q&A，无需手动迁移。
