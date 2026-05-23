# RFC-061 PR-A — e2e baseline lock manifest

This document records the set of existing e2e specs that constitute the
**RFC-061 baseline**. Every PR in the RFC-061 series (PR-A through PR-D)
MUST keep these specs all green. PR-C may refresh visual baseline images
to adapt to the new events-timeline UX, but the behavioral assertions
inside each spec must continue to hold.

Per `design/RFC-061-execution-event-sourced/plan.md` T5, the original
plan called for 20 brand-new specs covering the listed scenarios. After
auditing the existing suite, we found 18 specs already covered ≥ 90% of
that scope. PR-A therefore **declares the existing suite as the baseline**
rather than duplicating coverage; PR-C may add the new `/tasks/:id/timeline`
spec on top.

## Baseline specs (18)

| # | spec                       | scenario locked                                  |
|---|----------------------------|--------------------------------------------------|
| 1 | `main.spec.ts`             | agent-single happy path                          |
| 2 | `clarify.spec.ts`          | RFC-023 self-clarify ask & answer                |
| 3 | `cross-clarify.spec.ts`    | RFC-056 cross-agent clarify + RFC-059 scope      |
| 4 | `review.spec.ts`           | RFC-005 human review approve / iterate / reject  |
| 5 | `task-lifecycle-states.spec.ts` | pending → running → done / canceled / failed |
| 6 | `crash-recovery.spec.ts`   | daemon restart resumes interrupted state         |
| 7 | `collab-multi-user.spec.ts`| multi-user concurrent + permission boundaries    |
| 8 | `auth-isolation.spec.ts`   | per-user task visibility scoping                 |
| 9 | `import-export.spec.ts`    | workflow YAML round-trip + conflict modes        |
| 10 | `memory-manual-create-edit.spec.ts` | memory CRUD + injection                |
| 11 | `workflow-editor.spec.ts`  | xyflow canvas wire / NodeInspector / save        |
| 12 | `nav-redesign.spec.ts`     | left nav + breadcrumb routing                    |
| 13 | `keyboard-flows.spec.ts`   | keyboard navigation through dialogs / forms      |
| 14 | `a11y.spec.ts`             | axe-core a11y audit on each top-level route      |
| 15 | `diagnose-repair.spec.ts`  | RFC-057 diagnose panel + repair options          |
| 16 | `lifecycle-diagnose.spec.ts`| RFC-053 P-3 invariants surfaced in UI           |
| 17 | `git-protocols.spec.ts`    | gitea container HTTPS / SSH clone scenarios      |
| 18 | `visual-regression.spec.ts`| visual baseline (PR-C may refresh)               |

## Coverage gaps (acceptable for PR-A)

These plan scenarios are not currently covered by a dedicated spec; PR-A
accepts this because the underlying behaviors are exercised by integration
tests in `packages/backend/tests/`:

- `wrapper-git` round-trip (covered by backend wrapper-git integration tests)
- `wrapper-loop` exit conditions (covered by `exit-condition.test.ts`)
- `retry budget exhaust` (covered by `runner-retry-budget.test.ts`)
- `nested wrapper` (covered by `workflow-validator.test.ts`)
- `fanout with review inner` (covered by RFC-060 PR-D integration tests)

If PR-B introduces a regression in any of these, the corresponding backend
test will catch it before the e2e suite runs.

## How to verify the baseline

```bash
# Local
cd e2e && bun test

# CI
# All 18 specs run as part of the standard CI matrix; any red spec blocks
# the PR.
```

## What changes per RFC-061 PR

- **PR-A**: no spec changes. This manifest is delivered.
- **PR-B**: backend hard cutover. All 18 specs MUST stay green. No spec body
  edits except where wire DTO renames touch the spec (e.g. `ClarifySession`
  → `SuspensionRow`). Behavioral assertions stay byte-identical.
- **PR-C**: frontend cutover. Visual baseline images may refresh. Wire DTO
  renames cascade through the specs' typed fixtures. NEW spec
  `tasks-timeline.spec.ts` covering the events-timeline UX is added.
- **PR-D**: cleanup. No spec changes.

## Locks file (PR-D enforcement)

PR-D will add `packages/backend/tests/grep-guards-rfc061.test.ts` (or
update an existing grep-guard suite) with assertions that prevent
deleting any of the 18 baseline specs without a corresponding RFC update.
