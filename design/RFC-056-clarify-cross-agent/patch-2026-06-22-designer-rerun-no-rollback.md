# RFC-056 patch 2026-06-22 — cross-clarify designer rerun must NOT roll back the worktree

Status: **In Progress → Done after merge**.
Owner: RFC-056 implementer follow-up (twelfth patch under RFC-056).
Scope: product-behavior bug-fix patch. Amends RFC-056 design §5.2 step 1
and §5.5. Per `CLAUDE.md` RFC workflow, documented as an RFC-056 patch
rather than a new RFC (consistent with the eleven prior patch docs).

User decision on file: when a cross-node clarify (跨节点反问) is answered
`continue` and the **designer** node is re-triggered, the framework MUST
NOT roll the designer's git worktree back to its `pre_snapshot`. The
designer rerun revises **incrementally on the existing worktree**,
regardless of `sessionModeForDesigner` (`inline` or `isolated`).

## 1. Symptom

After a cross-clarify `continue`, `triggerDesignerRerun` reruns the
designer node, and the designer's git tree is rolled back — its prior
file output (and every downstream node's output sitting on top of it)
disappears from the worktree. The user reports this rollback as
**不符合预期 (unexpected)**: the designer is *revising with feedback*,
not retrying a failed attempt, so its prior work should be preserved.

## 2. Root cause

### 2.1 The designer rerun rolls back unconditionally

`packages/backend/src/services/crossClarify.ts:801-825`
(`triggerDesignerRerun`):

```ts
// RFC-014: roll worktree back to designer's pre_snapshot before reruns so
// file-level effects are erased. ...
if (
  (lastDesigner.preSnapshot !== null || lastDesigner.preSnapshotReposJson !== null) &&
  args.worktreePath !== ''
) {
  const target = await loadRollbackTarget(args.db, args.taskId)
  if (target !== null) {
    try {
      await getTaskWriteSem(args.taskId).run(() =>
        rollbackNodeRunWorktrees(target, lastDesigner, { resetOnEmptySnapshot: false }, log),
      )
    } catch (err) { /* warn + suppress */ }
  }
}
```

`rollbackNodeRunWorktrees(..., { resetOnEmptySnapshot: false })` runs
`git reset --hard <pre_snapshot> && git clean -fd` against the designer's
worktree (per-sub-repo for multi-repo tasks). Because `pre_snapshot` is
the state captured **before the designer's first run**, this erases the
designer's output **and everything downstream wrote on top of it**. The
designer then regenerates from the `## Prior Output (to be updated)`
block injected into its prompt (`scheduler.ts` `isCrossClarifyTriggeredRerun`
path), so the file content is *rebuilt*, but the live worktree state is
destroyed first.

This was RFC-056 design §5.2 step 1 (`RFC-014 rollbackBeforeRetry`) /
§5.5, modeled on RFC-014's **retry**-before-regen. The "revise with
external feedback" rerun is semantically a continuation, not a retry, and
the user wants the worktree preserved.

### 2.2 Asymmetry with self-clarify (RFC-026)

The same-node clarify rerun already declines to roll back when it would
desync a resumed session — `packages/backend/src/services/clarify.ts:417-459`:

> *"in inline session mode, skip the worktree rollback. The agent is about
> to resume its prior opencode session... Rolling files back to
> pre_snapshot now would desynchronise the agent's 'I just touched file X'
> memory from the actual filesystem and produce confusing failures."*

The cross-clarify designer path never received an equivalent gate.

### 2.3 `sessionModeForDesigner` is dead config (context, not fixed here)

The canvas editor exposes a **"Designer rerun session: inline | isolated"**
segmented control (`NodeInspector.tsx:1166-1186`), and RFC-056 design
§5.5 (line 218) specifies that `inline` should resume
`--session <designer.opencode_session_id>`. But nothing in the backend
ever reads `sessionModeForDesigner`:

- The designer rerun is minted with `cause: 'cross-clarify-answer'`
  (`crossClarify.ts:854`).
- `isClarifyRerunCause('cross-clarify-answer')` returns **false**
  (`nodeRunMint.ts:209-211`, deliberately excluded).
- So at `scheduler.ts:2143-2146` the designer is forced to
  `sessionMode: 'isolated'` with `priorSessionId: null` — it always runs a
  fresh isolated session and never resumes inline.

This is **out of scope** for this patch (it is a separate gap), but it
matters for the decision: because the designer can never be `inline`, the
"skip-rollback-only-when-inline" parity fix from §2.2 would never fire.
The user therefore chose the simpler, mode-independent behavior: **never
roll back** (see §3). It also means the editor's designer session-mode
toggle is now fully cosmetic — flagged as follow-up in §6.

## 3. Fix

Remove the rollback from `triggerDesignerRerun` entirely. The designer
rerun keeps the existing worktree; it revises in place using the
`## Prior Output (to be updated)` prompt block already supplied by the
scheduler. No `git reset --hard` / `clean -fd` is issued on the
cross-clarify-answer path.

Concretely in `crossClarify.ts`:

- Delete the rollback block (`:801-825`).
- Drop the now-unused imports `loadRollbackTarget`, `rollbackNodeRunWorktrees`
  (`:88`) and `getTaskWriteSem` (`:89`) — they have no other use in the file.
- Drop the now-vestigial `worktreePath` field from `TriggerDesignerRerunArgs`
  (`:751`), its caller `submitCrossClarifyAnswers` (`:585-591`), and the
  `worktreePath: ''` / `worktreePath: taskRow.worktreePath` args in the
  test callers. (`worktreePath` existed *only* as the rollback seal gate.)
- Update the function/file header comments (`:25`, `:742`, `:765-771`) that
  describe the RFC-014 rollback.

What is intentionally **unchanged**:

- The downstream cascade stays lazy (RFC-074): the designer's fresh `done`
  row still triggers `recomputeFreshnessAndDemote`, which demotes + re-
  dispatches stale downstream nodes. That path is DB/provenance-driven, not
  worktree-driven, so it is unaffected. Downstream reruns now start from a
  worktree that retains the designer's incremental edits plus their own
  prior output, instead of a wiped-clean base — the intended new behavior.
- The new designer `node_run`'s own `pre_snapshot` is still captured at
  dispatch, so a genuine **process retry** (RFC-042, `cause='process-retry'`)
  of the designer rerun still rolls back to *that* snapshot. Only the
  cross-clarify-answer rerun stops rolling back. (`triggerDesignerRerun` is
  the sole caller on the cross-clarify-answer path — grep-verified — so the
  blast radius is exactly this rerun.)

## 4. Affected files

- `packages/backend/src/services/crossClarify.ts` — remove rollback block +
  unused imports + `worktreePath` arg + comment edits (§3).
- `packages/backend/tests/cross-clarify-service.test.ts` (+ any sibling
  cross-clarify test that constructs `TriggerDesignerRerunArgs`) — drop the
  `worktreePath` field from the call sites; add the regression test (§5).
- `design/RFC-056-clarify-cross-agent/design.md` — amend §5.2 step 1 and
  §5.5 to state "no worktree rollback on designer rerun".
- `STATE.md` — 进行中 RFC pointer + completed-row on merge.

## 5. Tests

New file `packages/backend/tests/cross-clarify-designer-rerun-no-rollback.test.ts`
(top comment links this patch + the prior unconditional-rollback behavior):

1. **Behavioral red/green lock — real worktree, files survive the rerun.**
   Reuse the local-git pattern from
   `scheduler-audit-s11-stash-gc-prune-rollback.test.ts` (`mkdtempSync` +
   `runGit init/commit`, no network — non-flaky class):
   - build a repo, commit a baseline, leave a dirty tracked change, capture
     `sha = gitStashSnapshot(path)` (non-empty) — this is the designer's
     `pre_snapshot`;
   - write `design.md` (designer output) + `downstream.txt` (downstream
     output) as untracked files on top;
   - seed a task (`worktreePath = path`) + a `done` designer `node_run`
     with `preSnapshot = sha`;
   - call `triggerDesignerRerun({...})` (no `worktreePath` arg after §3);
   - assert `design.md` and `downstream.txt` **still exist** and the dirty
     tracked change is intact. Before the fix, the `reset --hard sha` +
     `clean -fd` deletes both → test is RED; after the fix → GREEN.

2. **Source-text guard (belt-and-braces, CLAUDE.md minimum).** Assert
   `crossClarify.ts` source no longer references `rollbackNodeRunWorktrees`
   / `loadRollbackTarget`, so a future refactor cannot silently reintroduce
   the rollback on this path.

3. **Existing assertions preserved.** The current cross-clarify service
   tests already pass `worktreePath: ''` (rollback disabled), so their
   designer-rerun assertions (retryIndex bump, shard_key/parent passthrough,
   `designerRunTriggeredAt` set, lazy no-cascade) remain valid once the
   `worktreePath` field is dropped from their call sites.

`bun run typecheck && bun run test && bun run format:check` green before push.

## 6. Out of scope / follow-up

- **Dead `sessionModeForDesigner` toggle (§2.3).** RESOLVED by the same-day
  follow-up below (§8): the user chose to remove the cosmetic toggle and the
  dead config behind it. (The alternative — wiring `inline` to resume
  `--session` on the designer rerun — was declined.)
- **Downstream rerun base state.** Documented in §3 as intended; no
  behavior knob added.

## 7. Design-doc amendments (applied with the code)

- `design.md` §5.2 step 1: replace
  "1. RFC-014 `rollbackBeforeRetry(designerNodeRunId)`." with a note that
  the designer rerun does **not** roll back the worktree (revises in place;
  prior output supplied via the prompt block), cross-referencing this patch.
- `design.md` §5.5: drop the rollback implication; keep the External
  Feedback aggregation + prompt construction unchanged.

## 8. Follow-up (same patch, 2026-06-22): remove the dead `sessionModeForDesigner`

The editor exposed a "Designer rerun session: inline | isolated" segmented
control whose value the backend never consumed (§2.3). With the rollback gone it
was doubly dead. Per the user's instruction it is removed in full:

- **shared** — dropped the `sessionModeForDesigner` field from
  `ClarifyCrossAgentNodeSchema`; `resolveCrossClarifySessionMode(node)` lost its
  `direction` param (questioner-only now — the only rerun with a configurable
  session mode). `ClarifyCrossAgentSessionMode` (enum/type) stays — the
  questioner field still uses it.
- **backend** — `scheduler.ts` call site drops the `'questioner'` arg.
- **frontend** — removed the designer segmented control + its i18n
  (`crossClarify.inspector.sessionModeForDesigner`: en value + zh value + zh
  type). The questioner control is untouched (functional — RFC-056 A16).
- **back-compat** — the schema is `.passthrough()`, so a stored workflow that
  still carries `sessionModeForDesigner` parses unchanged. The v4 fixture
  `workflow-schema-versions/v4-with-cross-clarify.json` deliberately RETAINS the
  legacy key as the passthrough back-compat lock (compat-workflow-schema.test.ts
  asserts every version fixture still parses cleanly).
- **tests** — collapsed the designer dimension out of
  `cross-clarify-inline-fallback` / `clarify-cross-rfc056` /
  `cross-clarify-rfc056-shared` / `cross-clarify-rfc056-migrate`; the inspector
  test now POSITIVELY asserts the designer control is ABSENT, and its source
  guard asserts `sessionModeForDesigner` no longer appears in NodeInspector.tsx.

The questioner inline path (`sessionModeForQuestioner`, RFC-056 A16) is
unaffected throughout. Gate: typecheck (3 pkgs) + shared/backend/frontend tests
+ format all green.
