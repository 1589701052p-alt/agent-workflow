# RFC-056 patch 2026-05-22 — designer-rerun downstream cascade + questioner Q&A injection + scheduler freshness invariant

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up.
Scope: bug-fix patch under RFC-056. Per `CLAUDE.md` RFC workflow §6 exception
(non-trivial bug fix that does not introduce new product surface), this is
documented as an RFC-056 patch rather than a new RFC.

## 1. Live failure

Production task `01KS7GQ3PACG3YX6S9ZH8QC0WV` (workflow
`01KS7C0K5ZRJ29AZD7J13C42C2` "跨节点反问") failed at `22:16:23` with:

```
review node rev_cbkatx: upstream 'agent_b48d63' did not emit port 'docpath'
code = review-source-port-missing
```

Timeline reconstructed from `node_runs`:

| time | node | event |
| --- | --- | --- |
| 17:36–17:54 | designer → review → … | normal flow until rev_5h9xpz approved |
| 17:55–17:56 | `agent_b48d63` (questioner) | emitted `<workflow-clarify>` (cross-clarify questions); NO `<workflow-output>` |
| 17:57 | `cross_clarify_6c910f` | user clicked Continue |
| 17:57–18:02 | designer `agent_m7p3n1` | reran at `cross_clarify_iteration=1`, produced new `docpath` |
| 18:02–22:16 | (nothing) | scheduler idle 4h |
| 22:16:23 | rev_cbkatx | `review-source-port-missing`; task=failed |

Root cause: the questioner's only "done" `node_run` (17:56:39) emitted only
a `<workflow-clarify>` envelope and zero `<workflow-output>` ports. Its
`node_run_outputs` rows were empty. When the next downstream review
(`rev_cbkatx`) was eventually dispatched, the source-port lookup failed.

The reason `rev_cbkatx` was dispatched at all: the scheduler treated the
questioner's stale "done" row as authoritative, even though designer had
re-run at a fresher `crossClarifyIteration`.

## 2. Three implementation gaps the fix closes

### Gap A — `triggerDesignerRerun` never cascade-resets downstream

`packages/backend/src/services/crossClarify.ts:593-671` minted ONE new
designer `node_run` and left a comment claiming:

> NOTE: the cascade is therefore implicit: stale outputs from prior runs are
> overwritten by the next dispatch pass.

This comment was a fiction. The scheduler's freshness comparator
`isFresherNodeRun` (scheduler.ts:307) keys on
`(clarifyIteration, retryIndex, id)` — `crossClarifyIteration` is NOT a
factor. So a downstream "done" row with `crossClarifyIteration=0` stayed
authoritative even after the upstream designer ran at
`crossClarifyIteration=1`. Result: downstream never re-dispatched.

RFC-056 design `§5.2 step 4` already specified the contract:

> 触发 sibling cascade（下游全 reset pending、复用 RFC-014 helper）

— but the implementation never followed through.

**Fix:** `triggerDesignerRerun` now explicitly BFS-walks the workflow's
edges (skipping clarify-channel edges via the new shared helper
`isClarifyChannelEdge`) downstream of the designer and mints a fresh
pending `node_run` for every reachable node whose latest top-level row has
a stale `crossClarifyIteration`. Idempotent: nodes that already carry the
new iteration are skipped. New `node_run`s inherit the template row's
`shardKey` / `clarifyIteration` / `reviewIteration` / `preSnapshot`; the
only field that bumps is `crossClarifyIteration`. `retryIndex` is set to
`max(existing) + 1` so `isFresherNodeRun` ALWAYS picks the new pending
over any prior done — even when an RFC-042 follow-up inflated retryIndex
above 0.

### Gap B — Questioner reruns with no record of having asked

`RFC-056 §5.4` specified:

> questioner node_run cascade reset 后 dispatch 时：
> - 查所有 cross_clarify_node_id 与本 questioner 关联的 sessions
> - directive=continue → append `## Clarify Q&A` 段 + RFC-039 ask-bias preamble
> - directive=stop → STOP CLARIFYING

— but the scheduler's prompt-assembly path (`runOneNode`) only routed
through `buildClarifyPromptContext` which reads `clarify_sessions`
(self-clarify). For a questioner that asked via cross-clarify, the lookup
returned undefined — the rerun dispatched with **no** record of the prior
Q&A in the prompt.

Production failure mode if the Gap A fix had landed alone: the cascade
would have minted the questioner's pending row, but the rerun would have
been blind to the Q&A and the agent would likely re-emit the SAME
`<workflow-clarify>` envelope, looping back into cross-clarify forever.

**Fix:** new helper `buildQuestionerCrossClarifyContext` reads from
`cross_clarify_sessions WHERE source_questioner_node_id = the about-to-
rerun questioner AND status='answered'`, ordered ascending by `iteration`.
It returns the same `ClarifyPromptContext` shape that
`buildClarifyPromptContext` returns, so the renderer's `## Clarify Q&A`
machinery in `renderUserPrompt` (`packages/shared/src/prompt.ts`) emits
the section verbatim — no new template wiring needed. The questioner sees
its own past questions, the designer-side answers, and the latest
directive (`continue` → ask-bias preamble; `stop` → STOP CLARIFYING
trailer).

Scheduler trigger condition:
```ts
const isQuestionerCrossClarifyRerun =
  clarifyMode === 'cross' &&                          // node is wired to a cross-clarify
  currentCrossClarifyIteration > 0 &&                 // this rerun is post-continue
  (currentRunRow?.retryIndex ?? 0) === 0              // fresh round, not in-attempt retry
```

### Gap C — No freshness invariant defense in scheduler

Even with Gap A's cascade in place, paths that bump an upstream's
`crossClarifyIteration` WITHOUT going through `triggerDesignerRerun`
(manual SQL patches, future queue-replay flows, raw DB edits) would still
leave downstream stale.

**Fix:** `runScope` now runs `applyCrossClarifyFreshnessInvariant` as a
single-pass defense after building `latestPerNode`. For each node in
`completed`, if any of its in-scope upstreams has a strictly greater
`crossClarifyIteration` than the node's own latest row, the node is
demoted back to `remaining` and a fresh pending row minted carrying the
upstream's iteration. The cascade in `triggerDesignerRerun` is the
primary mechanism; this invariant is the safety net.

## 3. Why this couldn't be just one of the three

Each gap independently breaks the workflow:

- A alone: questioner reruns blind, loops forever asking same questions.
- B alone: cascade never mints questioner row; questioner stays "done"
  with empty outputs; downstream review trips review-source-port-missing.
- C alone: same as A — `triggerDesignerRerun` still doesn't mint
  downstream rows, so freshness invariant has nothing to demote (no
  upstream bump signal until a designer rerun bumps it WITHOUT going
  through triggerDesignerRerun).

Only A + B together make the happy path work. C is defense-in-depth for
paths that bypass A in the future.

## 4. Code touched

| file | change |
| --- | --- |
| `packages/shared/src/clarify-cross.ts` | + `isClarifyChannelEdge(edge): boolean` shared classifier |
| `packages/backend/src/services/scheduler.ts` | use shared classifier in `topologicalOrder` + `runScope` (replace duplicated rule); add `applyCrossClarifyFreshnessInvariant` call; add `isQuestionerCrossClarifyRerun` branch in `runOneNode`'s `clarifyContext` build; export `applyCrossClarifyFreshnessInvariant` for the unit test |
| `packages/backend/src/services/crossClarify.ts` | + `buildQuestionerCrossClarifyContext` (Gap B); + `cascadeDownstreamFromDesigner` private helper + call from `triggerDesignerRerun` (Gap A); + `loadDefinitionForTask` private helper; thread optional `definition?: WorkflowDefinition` through `TriggerDesignerRerunArgs` |

## 5. Tests (per `CLAUDE.md` test-with-every-change)

| test file | layer | what it locks |
| --- | --- | --- |
| `packages/backend/tests/cross-clarify-downstream-cascade.test.ts` | A | 4 cases: reachable downstream gets pending; clarify-channel edges skipped; idempotency; template inheritance (shardKey, clarifyIteration, preSnapshot, retryIndex bump) |
| `packages/backend/tests/cross-clarify-questioner-context.test.ts` | B | 6 cases: `iteration<=0` returns undefined; no sessions returns undefined; single round renders; multi-round renders in ascending order with latest directive; only `answered` surfaces (awaiting_human/abandoned skipped); shape compatibility with `ClarifyPromptContext` |
| `packages/backend/tests/scheduler-cross-clarify-freshness-invariant.test.ts` | C | 4 cases: stale downstream gets demoted + pending minted; already-fresh stays completed; no-rows skipped; idempotency across two passes |

All 14 new tests + the 57 pre-existing cross-clarify tests pass. The full
backend suite shows 8 unrelated daemon/WS port-contention failures that
also occur on `main` without these changes (verified via `git stash` round-
trip).

## 6. Out of scope (future)

- e2e test with fake opencode binary that exercises cross-clarify continue
  → designer rerun → questioner rerun → review approve → task done.
- Generalising `cross_clarify_iteration` to a node-agnostic
  `upstream_epoch` (long-term direction discussed in the user-facing
  analysis; explicitly NOT being done here).
- Inline session mode for the questioner cross-clarify rerun
  (`§5.4 inline session 模式` paragraph) — the helper currently returns
  `mode: undefined` so the renderer uses the isolated path. Inline support
  is a follow-up; the workflow already works with isolated mode and the
  agent reads the full Q&A history from the prompt.

## 7. Migration / data fix for the live task

Task `01KS7GQ3PACG3YX6S9ZH8QC0WV` was committed to the database BEFORE
this fix. After the fix lands, the operator can rescue it by manually
minting the cascade pending rows that `triggerDesignerRerun` would have
minted under the new code path. See the patch commit message for the
exact SQL (or run a `resumeTask` invocation after manually patching the
state — the scheduler's freshness invariant from Layer C will pick up the
remaining stale downstream and dispatch them).
