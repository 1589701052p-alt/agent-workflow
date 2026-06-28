// LOCKS: RFC-056 patch 2026-06-22 — the cross-clarify designer rerun must NOT
// roll the worktree back to pre_snapshot.
//
// Before the patch, `triggerDesignerRerun` unconditionally called
// `rollbackNodeRunWorktrees(..., { resetOnEmptySnapshot: false })`, i.e.
// `git reset --hard HEAD && git clean -fd && git stash apply <pre_snapshot>`
// against the designer's worktree — erasing the designer's output AND any
// downstream work written on top. The user reported this as unexpected: a
// cross-clarify `continue` is a *revise-with-feedback* continuation, not a
// retry, so the worktree must be preserved (the prior draft is re-supplied via
// the scheduler's `## Prior Output (to update or regenerate)` prompt block).
//
// design/RFC-056-clarify-cross-agent/patch-2026-06-22-designer-rerun-no-rollback.md
//
// Determinism: pure local git (init / commit / stash create), no network / no
// clone / no stash push-pop — the non-flaky class per
// scheduler-audit-s11-stash-gc-prune-rollback.test.ts; NOT RUN_GIT_NETWORK-gated.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { triggerDesignerRerun } from '../src/services/crossClarify'
import { gitStashSnapshot, runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Repo {
  path: string
  cleanup: () => void
}

async function buildRepo(): Promise<Repo> {
  const path = mkdtempSync(join(tmpdir(), 'aw-designer-norollback-'))
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  writeFileSync(join(path, 'a.txt'), 'original\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** Seed a workflow + task + a single `done` designer node_run. The task's
 *  worktreePath points at the REAL repo and the designer carries a REAL stash
 *  sha — so a future reintroduction of the rollback (which loads the target via
 *  `loadRollbackTarget(db, taskId)` → tasks.worktreePath) would actually fire
 *  and flip this test red. */
async function seedTaskAndDesigner(
  db: DbClient,
  taskId: string,
  worktreePath: string,
  preSnapshot: string,
): Promise<void> {
  const def = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: worktreePath,
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: 1,
  })
  await db.insert(nodeRuns).values({
    id: 'nr_designer_done',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot,
  })
}

describe('RFC-056 patch 2026-06-22: cross-clarify designer rerun does not roll back the worktree', () => {
  let repo: Repo
  beforeEach(async () => {
    repo = await buildRepo()
  })
  afterEach(() => repo.cleanup())

  test('designer rerun preserves the worktree — designer + downstream output survive', async () => {
    // Dirty TRACKED change at snapshot time → non-empty stash sha (the value
    // the designer's pre_snapshot would hold in production).
    writeFileSync(join(repo.path, 'a.txt'), 'snapshot-state\n')
    const sha = await gitStashSnapshot(repo.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)

    // The designer's output + a downstream node's output, written ON TOP as
    // untracked files. `git clean -fd` (the old rollback's second step) is
    // exactly what would delete these.
    writeFileSync(join(repo.path, 'design.md'), 'designer v1\n')
    writeFileSync(join(repo.path, 'downstream.txt'), 'coder output\n')

    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'task_norollback'
    await seedTaskAndDesigner(db, taskId, repo.path, sha)

    const out = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 0,
      now: () => 1,
    })

    // The rerun ran to completion: a fresh pending designer row was minted.
    const fresh = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, out.designerNodeRunId))
    )[0]
    expect(fresh?.status).toBe('pending')

    // CORE LOCK: the worktree is untouched. The pre-patch rollback would have
    // `git clean -fd`'d both untracked files (RED). No rollback → both survive
    // with their post-snapshot content intact.
    expect(existsSync(join(repo.path, 'design.md'))).toBe(true)
    expect(existsSync(join(repo.path, 'downstream.txt'))).toBe(true)
    expect(readFileSync(join(repo.path, 'design.md'), 'utf8')).toBe('designer v1\n')
  })

  test('source guard: triggerDesignerRerun no longer references the rollback helpers', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'crossClarify.ts'),
      'utf8',
    )
    expect(src).not.toContain('rollbackNodeRunWorktrees')
    expect(src).not.toContain('loadRollbackTarget')
  })
})
