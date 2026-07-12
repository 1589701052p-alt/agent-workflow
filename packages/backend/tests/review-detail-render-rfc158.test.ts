// RFC-158 — getReviewDetail robustness the canvas nav oracle depends on:
//   R2b: the summary is built DIRECTLY by nodeRunId, not by scanning
//        listReviewSummaries(limit: 500) — so a review whose doc_versions aged
//        out of the global newest-500 window still renders (was a silent 404).
//   R6:  a single-doc review whose body FILE is missing renders with body=''
//        (the multi-doc path already tolerated it) — so "has doc_version ⟹
//        getReviewDetail renders" holds, which is what reviewNavKind !== null
//        promises the canvas.

import { rimrafDir } from './helpers/cleanup'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { getReviewDetail } from '../src/services/review'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskAndWorkflow(db: DbClient): { taskId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: '{}',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId }
}

function seedReviewRun(db: DbClient, taskId: string): string {
  const id = ulid()
  db.insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: 100,
      finishedAt: null,
    })
    .run()
  return id
}

function seedDocVersion(
  db: DbClient,
  taskId: string,
  reviewNodeRunId: string,
  opts: { versionIndex: number; createdAt: number; decision?: 'pending' | 'approved' },
): { bodyPath: string } {
  const bodyPath = `reviews/rev/docpath/${reviewNodeRunId}-v${opts.versionIndex}.md`
  db.insert(docVersions)
    .values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId,
      sourceNodeId: 'agent',
      sourcePortName: 'docpath',
      versionIndex: opts.versionIndex,
      reviewIteration: 0,
      bodyPath,
      decision: opts.decision ?? 'pending',
      createdAt: opts.createdAt,
      decidedAt: null,
    })
    .run()
  return { bodyPath }
}

function writeBody(appHome: string, bodyPath: string, text: string): void {
  const abs = join(appHome, bodyPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
}

describe('RFC-158 — getReviewDetail renders whenever a doc_version exists', () => {
  let db: DbClient
  let appHome: string
  beforeEach(() => {
    resetBroadcastersForTests()
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc158-detail-'))
  })
  afterEach(() => {
    resetBroadcastersForTests()
    rimrafDir(appHome)
  })

  test('R2b: a review whose versions fall outside the global newest-500 window still renders', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    // The target review — its single OLD doc_version (createdAt far in the past).
    const targetRun = seedReviewRun(db, taskId)
    const { bodyPath } = seedDocVersion(db, taskId, targetRun, {
      versionIndex: 1,
      createdAt: 1_000,
      decision: 'pending',
    })
    writeBody(appHome, bodyPath, '# target body')

    // 600 NEWER doc_versions on other runs — pushing the target out of the
    // global `ORDER BY created_at DESC LIMIT 500` window listReviewSummaries used.
    for (let i = 0; i < 600; i++) {
      const otherRun = seedReviewRun(db, taskId)
      seedDocVersion(db, taskId, otherRun, {
        versionIndex: 1,
        createdAt: 2_000_000 + i, // all newer than the target's 1_000
      })
    }

    const detail = await getReviewDetail(db, appHome, targetRun)
    expect(detail.summary.nodeRunId).toBe(targetRun)
    expect(detail.currentVersion.versionIndex).toBe(1)
    expect(detail.currentBody).toBe('# target body')
  })

  test('R6: single-doc review with a MISSING body file renders body="" (no doc-version-body-missing throw)', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const run = seedReviewRun(db, taskId)
    // Row exists but we deliberately DO NOT write the body file to appHome.
    seedDocVersion(db, taskId, run, { versionIndex: 1, createdAt: 5_000, decision: 'pending' })

    const detail = await getReviewDetail(db, appHome, run)
    expect(detail.summary.nodeRunId).toBe(run)
    expect(detail.currentBody).toBe('')
  })
})
