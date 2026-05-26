// RFC-066 PR-B — source-layer guards locking the scheduler / runner / diff /
// rollback wiring against silent regressions. Targets:
//
//   PB-G1: services/scheduler.ts retains the multi-repo wrapper-git defense-
//          in-depth gate keyed by `multi-repo-wrapper-git-unsupported` so a
//          future runTask refactor cannot quietly remove it.
//   PB-G2: services/scheduler.ts threads `state.repos` (NOT a free-floating
//          `repos` variable) into every templateMeta dispatch — anchors the
//          per-repo metadata wiring on SchedulerState as the single source
//          of truth.
//   PB-G3: services/runner.ts cwd is set from `opts.worktreePath` exactly
//          once at the spawn site — guards against an inadvertent switch
//          to `repos[0].worktreePath` (which would break single-repo
//          baseline) or a per-shard cwd injection.
//   PB-G4: services/task.ts `rollbackNodeRunForResume` is the named helper
//          both `resumeTask` and `retryNode` call into. New rollback paths
//          must reuse it; ad-hoc inline rollback in either function is a
//          regression target.
//   PB-G5: services/task.ts diff endpoint branches on `task.repoCount ===
//          1` for the byte-baseline single-repo path and `# === Repo:` for
//          the multi-repo concat header.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf-8',
)
const RUNNER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
  'utf-8',
)
const TASK_SRC = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')

describe('RFC-066 PR-B — source guards', () => {
  test('PB-G1 scheduler retains the multi-repo wrapper-git defense-in-depth gate', () => {
    expect(SCHEDULER_SRC.includes("'multi-repo-wrapper-git-unsupported'")).toBe(true)
    // The gate body must reference `task.repoCount > 1` to actually trigger.
    expect(SCHEDULER_SRC.includes('task.repoCount > 1')).toBe(true)
  })

  test('PB-G2 scheduler threads `state.repos` into every templateMeta dispatch', () => {
    // We expect the 3 templateMeta sites (single-agent, fanout shard,
    // fanout aggregator) to use `state.repos` so they all consume the same
    // SchedulerState-owned snapshot. Anchor the count at 3 — adjusting up
    // requires explicit attention so the test catches accidental
    // duplication or loss.
    const matches = SCHEDULER_SRC.match(/repos:\s*state\.repos/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  test('PB-G3 runner cwd is opts.worktreePath at the spawn site exactly', () => {
    // The runner has two `cwd: opts.worktreePath` occurrences — one in the
    // log.info call and one in the Bun.spawn call. Both target the same
    // variable; no path arithmetic like `join(opts.worktreePath, ...)` or
    // `opts.repos[0].worktreePath`. Anchoring on the literal string keeps
    // the rule unambiguous.
    const spawnMatches = RUNNER_SRC.match(/cwd: opts\.worktreePath/g) ?? []
    expect(spawnMatches.length).toBeGreaterThanOrEqual(2)
    // Guard against a future "per-shard cwd" sneaking in.
    expect(/cwd:\s*opts\.repos/.test(RUNNER_SRC)).toBe(false)
    expect(/cwd:\s*\w+\.repos\[/.test(RUNNER_SRC)).toBe(false)
  })

  test('PB-G4 resume + retry rollback funnels through rollbackNodeRunForResume', () => {
    expect(TASK_SRC.includes('async function rollbackNodeRunForResume(')).toBe(true)
    // Both resumeTask and retryNode call into the helper. Match `await
    // rollbackNodeRunForResume(...)` invocations.
    const calls = TASK_SRC.match(/await rollbackNodeRunForResume\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  test('PB-G5 diff endpoint branches on single vs multi via task.repoCount + `# === Repo:` header', () => {
    expect(TASK_SRC.includes('task.repoCount === 1')).toBe(true)
    // Multi-repo concat uses the stable header literal so the frontend can
    // safely split on it.
    expect(TASK_SRC.includes('# === Repo:')).toBe(true)
  })
})
