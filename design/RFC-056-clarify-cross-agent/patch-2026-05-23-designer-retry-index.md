# RFC-056 patch 2026-05-23 — designer rerun retry_index = max(existing)+1

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (second patch under RFC-056).
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception, documented
as an RFC-056 patch rather than a new RFC.

## 1. Live failure

Production task `01KS86DPCSERV7S41GQA5Y81RN` (workflow
`01KS7C0K5ZRJ29AZD7J13C42C2` "跨节点反问") sat in `awaiting_human` after the
user clicked Submit on a cross-clarify. The visible symptom: **the
questioner re-executed, the designer did not**. The questioner emitted a
second `<workflow-clarify>` envelope and the task parked on a fresh
cross-clarify awaiting row — the designer was never given a chance to
incorporate the answers.

Timeline reconstructed from `node_runs`:

| time | node | event |
| --- | --- | --- |
| 17:36 → 22:14 | `agent_m7p3n1` (designer) | many self-clarify rounds + RFC-042 same-session retries pushed the latest done to `clarify_iter=6, retry_index=9` |
| 22:14:46 | `agent_b48d63` (questioner) | done at `retry_index=2`, emitted `<workflow-clarify>` |
| 22:14:47 | `cross_clarify_6c910f` | user clicked Submit (directive=continue) |
| 22:14:47 | designer pending row minted | **`retry_index=0`**, `cross_clarify_iter=1`, `clarify_iter=6`, `started_at=NULL` (never dispatched) |
| 22:14:47 | questioner pending row minted | `retry_index=3` (max(2)+1) — cascade-minted via `cascadeDownstreamFromDesigner` |
| 22:14:47 → 22:14:57 | questioner | actually ran (scheduler picked it up because retry_index=3 beats prior done at retry_index=2), emitted ANOTHER `<workflow-clarify>` |
| 22:14:57 → now | cross-clarify awaiting_human | task parked; designer still has unscheduled pending row sitting at `retry_index=0` |

Root cause: the scheduler's freshness comparator `isFresherNodeRun`
(`packages/backend/src/services/scheduler.ts:309`) keys on
`(clarifyIteration, retryIndex, id)` — `crossClarifyIteration` is NOT a
factor. The designer's new pending row at `(clarify_iter=6, retry_index=0)`
**lost** to the prior done row at `(clarify_iter=6, retry_index=9)`.
`latestPerNode` resolved the designer to the prior done row → scheduler
treated the designer as "completed", never dispatched the new row.

The downstream questioner row was fine because
`cascadeDownstreamFromDesigner` already uses
`Math.max(existing retry_index) + 1` (see `crossClarify.ts:801`, locked in
by patch-2026-05-22-downstream-cascade.md §Gap A). That same fix was
**never applied** to the designer's OWN new row inside `triggerDesignerRerun`
— `retry_index` there was hardcoded to 0.

## 2. The fix

`crossClarify.ts:triggerDesignerRerun` now computes the designer's new
`retry_index` the same way `cascadeDownstreamFromDesigner` already does for
every downstream row: `max(top-level designer rows at this iteration) + 1`.

```ts
const topLevelDesignerRows = designerRows.filter(
  (r) => r.parentNodeRunId === null && r.iteration === lastDesigner.iteration,
)
const newDesignerRetryIndex =
  topLevelDesignerRows.length === 0
    ? 0
    : Math.max(...topLevelDesignerRows.map((r) => r.retryIndex)) + 1
```

Iteration filter is required: wrapper-loop iterations restart `retry_index`
counters, so the bump only considers same-iteration rows. Without the
filter, an iteration=1 cross-clarify resolve would inflate retry_index off
iteration=0's history and skew RFC-042 same-session retry decisions.

## 3. Why patch-2026-05-22 didn't already cover this

The 2026-05-22 patch's `Gap A` fix added the cascade for **downstream**
nodes — `cascadeDownstreamFromDesigner` correctly uses `max+1` for every
node it cascades. But the designer's own row is minted by
`triggerDesignerRerun` directly, not via the cascade. That direct mint kept
the original `retry_index: 0` hardcode.

The patch's freshness invariant (`applyCrossClarifyFreshnessInvariant`,
Layer B / "Layer C" in the doc) does not catch this either: it demotes a
downstream node whose `latestPerNode` row has `crossClarifyIteration`
strictly less than an upstream's. In the live failure, the designer's
`latestPerNode` row IS the prior done (retry=9, cross_iter=0). Its upstream
(`input`) also has `cross_iter=0`. No mismatch → no demotion.

The cascade rows for downstream nodes did get minted and won the freshness
race, but a designer that never dispatches means no new docpath, so
downstream that ran on prior docpath will eventually be re-dispatched by
the cascade — running on the SAME prior docpath since the designer never
re-wrote it. In this specific task the symptom was even simpler: the
questioner re-ran on the SAME prior docpath (designer never bumped it),
emitted a second clarify envelope (it had no new info to chew on), and the
task parked on a second awaiting cross-clarify.

## 4. Tests

| test file | what it locks |
| --- | --- |
| `packages/backend/tests/cross-clarify-designer-retry-index.test.ts` | 3 cases: (a) prior retry_index=9 → new pending strictly greater; (b) first-ever rerun (prior retry=0) → new pending retry=1; (c) wrapper-loop iteration isolation — bump considers same-iteration rows only |
| `packages/backend/tests/cross-clarify-service.test.ts` | existing test renamed to "retry_index=max(existing)+1" + assertion flipped from `toBe(0)` to `toBe(1)` (locking the new contract) |

The new test file header explicitly cites task
`01KS86DPCSERV7S41GQA5Y81RN` so any future refactor that turns the test
red has a clear trail back to the live failure.

## 5. Data rescue for the live task

`01KS86DPCSERV7S41GQA5Y81RN` was minted before this patch landed; its
designer pending row sits at `retry_index=0`. After the fix lands, an
operator can rescue the task by either:

1. Manually bumping the pending designer row's `retry_index` past every
   prior row's value:
   ```sql
   UPDATE node_runs
   SET retry_index = (
     SELECT MAX(retry_index) + 1
     FROM node_runs
     WHERE task_id = '01KS86DPCSERV7S41GQA5Y81RN'
       AND node_id = 'agent_m7p3n1'
       AND iteration = 0
       AND parent_node_run_id IS NULL
   )
   WHERE id = '01KS8BSG1VTKDF80VPKKBFP8SC';
   ```
   then invoking `resumeTask` (or letting the scheduler's next tick pick
   it up).
2. Cancelling and retrying from the user side if the data isn't worth
   keeping.

## 6. Out of scope

- Generalising `cross_clarify_iteration` into the
  `isFresherNodeRun` comparator (so future paths that bump
  cross_clarify_iter without going through `triggerDesignerRerun` are
  caught at comparator level). Long-term direction; not done here because
  it touches a hot comparator used across the scheduler and warrants
  its own RFC.
- Detecting the symptom shape in `applyCrossClarifyFreshnessInvariant`
  (i.e. "designer has a pending row at lower retry_index than its prior
  done"). The invariant is for upstream/downstream mismatch; defending
  against intra-node retry-index inversions is a different invariant.
