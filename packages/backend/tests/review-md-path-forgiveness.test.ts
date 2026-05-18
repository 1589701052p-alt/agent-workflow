// Integration test for the resolvePortContent forgiveness path inside
// the review flow. Reported by the user on the live /reviews/:id page:
// upstream agent emitted an absolute .md path on its output port without
// declaring outputKinds, so doc_versions.body ended up rendering the path
// string instead of the file body. This test pins the end-to-end fix —
// dispatchReviewNode must now snapshot the file *contents* into
// doc_versions even when the agent skipped the outputKinds: { port:
// markdown_file } declaration.
//
// If this goes red, check packages/backend/src/services/envelope.ts
// (tryReadInWorktreeMarkdownPath) and packages/backend/src/services/
// review.ts (dispatchReviewNode upstream port resolve).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('dispatchReviewNode forgiveness path (path-shaped port content)', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-fp-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  test('doc_versions body contains file contents, not the raw path string', async () => {
    // 1) Agent row WITHOUT outputKinds — frontmatterExtra is the empty object.
    const agentId = ulid()
    await db.insert(agentsTable).values({
      id: agentId,
      name: 'designer',
      description: '',
      outputs: JSON.stringify(['design']),
      readonly: false,
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })

    // 2) Workflow + task rows. workflowSnapshot/inputs unused by
    //    dispatchReviewNode but the columns are non-null.
    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'designer',
          kind: 'agent-single',
          agentName: 'designer',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'designer', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })

    const taskId = ulid()
    await db.insert(tasks).values({
      name: 'fixture-task',

      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!

    // 3) Designer run that ALREADY emitted an absolute path on its output port.
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    const fileBody = '# Generated design\n\nbody of the file the user expects to see.'
    writeFileSync(join(worktree, 'docs', 'test_design.md'), fileBody)
    const absPath = join(worktree, 'docs', 'test_design.md')

    const designerRunId = ulid()
    await db.insert(nodeRuns).values({
      id: designerRunId,
      taskId,
      nodeId: 'designer',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: designerRunId,
      portName: 'design',
      content: absPath,
    })

    // 4) Dispatch the review node.
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    const result = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(result.kind).toBe('awaiting_review')

    // 5) doc_versions body file on disk must hold the file body, not the path.
    const dvs = await db.select().from(docVersions)
    expect(dvs.length).toBe(1)
    const dv = dvs[0]!
    const onDisk = readFileSync(join(appHome, dv.bodyPath), 'utf8')
    expect(onDisk).toBe(fileBody)
    expect(onDisk).not.toContain(absPath)
  })
})
