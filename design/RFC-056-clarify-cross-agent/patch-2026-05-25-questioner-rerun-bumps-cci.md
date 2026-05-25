# RFC-056 patch 2026-05-25 — questioner rerun mint helper must bump cross_clarify_iteration

Status: **Done after merge**.
Owner: RFC-056 implementer follow-up.
Scope: bug-fix patch. Per `CLAUDE.md` RFC workflow §6 exception,
documented as an RFC-056 patch rather than a new RFC.

Pairs with:

- [`patch-2026-05-22-downstream-cascade.md`](./patch-2026-05-22-downstream-cascade.md)
- [`patch-2026-05-23-designer-retry-index.md`](./patch-2026-05-23-designer-retry-index.md)
- [`patch-2026-05-24-retry-preserves-cross-clarify-iteration.md`](./patch-2026-05-24-retry-preserves-cross-clarify-iteration.md)
- [`patch-2026-05-25-questioner-cascade-no-skip.md`](./patch-2026-05-25-questioner-cascade-no-skip.md)
- [`patch-2026-05-26-review-dispatch-respects-cci.md`](./patch-2026-05-26-review-dispatch-respects-cci.md)

## 1. Symptom (live task `01KSESDVXQVRQX1FXG6N432C52`)

User flow: cross-clarify questioner asks 4 questions. User opens
`/clarify/{nodeRunId}`, switches **every** question's scope to
"反问者 (questioner)", clicks **"提交并继续反问"** (submit + continue).

Expected (per RFC-059 §S2): the designer is NOT rerun (correct);
the questioner reruns with the full Q&A injected into its prompt
and proceeds to emit `<workflow-output>` (or another clarify round
if it genuinely still has unresolved questions).

Actually observed: the questioner reruns having NO record of the
just-completed round and re-emits the SAME `<workflow-clarify>`
envelope. The user sees the same questions appear again and never
makes progress.

DB evidence:

| node_run | node | ri | cci | status | started_at |
|----------|------|----|----|--------|------------|
| 01KSETCRB8N5D39VM27Z8HYZN6 | agent_b48d63 (questioner) | 0 | 0 | done | …645569 |
| 01KSETFZVR25PSJM696XQ8CF95 | cross_clarify_6c910f | 0 | 0 | done | …751544 |
| 01KSETHZPGANSGRR24W7834BEY | agent_b48d63 (questioner, fast-path mint) | 0 | **0** ← never bumped | done | …816951 |
| 01KSETKNNT6NP32PARS4XMW4F9 | cross_clarify_6c910f | 0 | 1 | awaiting_human | …872186 |

Sessions for this task:

| session | cross_clarify_node_run | status | directive | iter | question_scopes |
|---------|------------------------|--------|-----------|------|-----------------|
| 01KSETFZVRV5AE9TY53940RP8F | 01KSETFZVR…XJ | answered | continue | 0 | all `questioner` |
| 01KSETKNNT3TMPKCCJ6M980BSS | 01KSETKNNT…EY | awaiting_human | NULL | 1 | NULL |

Session 1 was answered, fast path minted a new questioner row 43ms
later (`…816951`) — but with `crossClarifyIteration=0` instead of
the expected 1. The questioner reran, was prompted as if it had
never asked anything, repeated the same envelope, and the runner
created session 2.

## 2. Root cause

`packages/backend/src/services/crossClarify.ts mintQuestionerRerun`
(shared helper for both `triggerQuestionerContinueRerun` (RFC-059
fast path) and `triggerQuestionerStopRerun` (RFC-056 reject path))
inserted the new node_run with:

```ts
crossClarifyIteration: lastRun.crossClarifyIteration ?? 0,
```

The questioner's previous run was at `cci=0` (the one that emitted
the first `<workflow-clarify>` envelope), so the new run also
landed at `cci=0`.

The scheduler's gate for routing the clarify context build
(`packages/backend/src/services/scheduler.ts:1425`) is:

```ts
const isQuestionerCrossClarifyRerun =
  clarifyMode === 'cross' && currentCrossClarifyIteration > 0
```

With `cci=0`, this is false. The else branch builds prompt context
with `consumerKind='self'`, which only returns rows where
`clarifyRounds.kind='self'` AND `askingNodeId=questioner`. For a
cross-clarify questioner there are zero such rows. Result:
`clarifyContext = undefined`. The questioner reruns blind.

`triggerDesignerRerun` did NOT have this bug — at
`crossClarify.ts:826` it explicitly computes
`newCrossClarifyIteration = maxParticipantCci + 1`, scanning both
`nodeRuns` at this iteration and `crossClarifySessions` at this
loopIter. The mint helper for the questioner side simply omitted
this step.

The reject path was symptomatically masked: even though the
STOP CLARIFYING anchor never reached the questioner's prompt (no
Q&A context → no trailer), `dispatchCrossClarifyNode`'s
`hasPersistentStop` short-circuits the cross-clarify NODE to
'done' before a new session is created. So a rejected questioner
who re-emits clarify hits a closed door at the cross-clarify node
boundary. The fast-path / continue case has no such second-line
defense — it just loops.

## 3. Fix

In `mintQuestionerRerun`, compute `newCrossClarifyIteration` with
the same algorithm as `triggerDesignerRerun`:

```ts
const loopIter = lastRun.iteration
const peerRunsAtIter = await args.db
  .select({ c: nodeRuns.crossClarifyIteration })
  .from(nodeRuns)
  .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.iteration, loopIter)))
const sessionRowsAtIter = await args.db
  .select({ iter: crossClarifySessions.iteration })
  .from(crossClarifySessions)
  .where(
    and(
      eq(crossClarifySessions.taskId, args.taskId),
      eq(crossClarifySessions.loopIter, loopIter),
    ),
  )
const maxParticipantCci = Math.max(
  0,
  ...peerRunsAtIter.map((r) => r.c ?? 0),
  ...sessionRowsAtIter.map((r) => r.iter ?? 0),
)
const newCrossClarifyIteration = maxParticipantCci + 1
```

Applied at `packages/backend/src/services/crossClarify.ts` ~line
1117 (mintQuestionerRerun body). Both `triggerQuestionerStopRerun`
and `triggerQuestionerContinueRerun` benefit since they share the
helper.

## 4. Why the unit tests didn't catch this

`packages/backend/tests/cross-clarify-question-scope-prompt.test.ts`
calls `buildPromptContext` directly with `targetIteration: 1`,
bypassing the scheduler's `isQuestionerCrossClarifyRerun` gate
that decides WHETHER to call it with `consumerKind='cross-questioner'`
at all. The pure-function test passes; the production path never
takes the branch the test asserts.

`packages/backend/tests/cross-clarify-fast-path-isolation.test.ts`
asserts outcomes (`questioner-continue-triggered`) and peer-row
isolation but never inspects the newly-minted questioner row's
`crossClarifyIteration`.

This patch adds two narrow guards in that file (the fast-path
continue mint and the reject mint) that read the new row and
assert `crossClarifyIteration > 0`. The chosen condition is
deliberate: any bump value above the participant ceiling fixes the
production bug — pinning the exact value would couple the test to
the (irrelevant-to-the-bug) maxParticipantCci arithmetic.

## 5. Tests

Files touched:

- `packages/backend/src/services/crossClarify.ts` (mintQuestionerRerun + 1 doc-comment block on rationale)
- `packages/backend/tests/cross-clarify-fast-path-isolation.test.ts` (+2 regression tests)

Existing tests that explicitly assert questioner cci=0 after a
fast-path/reject mint: none found. The closest neighbour
(`cross-clarify-service.test.ts:394-398`) only asserts that NO
designer row exists at cci ≥ 1; it does not care about the
questioner side's value, so the bump is invisible to it.

Run after merging:

```
bun run typecheck && bun run test && bun run format:check
```

## 6. Out of scope

- **No envelope / API contract change.** Submit body still accepts
  `questionScopes` exactly as RFC-059 specified.
- **No DB migration.** Pure runtime fix in the mint helper.
- **No change to `triggerDesignerRerun`.** That path was already
  correct.
- **No change to the cross-clarify NODE_RUN cci.** The cross-clarify
  node's own iteration is bumped by `createCrossClarifySession`
  already (correctly).
