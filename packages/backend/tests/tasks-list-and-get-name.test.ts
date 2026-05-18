// RFC-037 T3 — locks `services/task.ts` rowToTask + rowToSummary returning
// `name`. The list + single endpoints both rely on the row mapper functions;
// if either drops `name` the inbox / list pages will render undefined.
//
// This is a thin contract test against the row mappers (no HTTP). The 422
// validation flow lives in tasks-create-name.test.ts (T5).

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTask(db: ReturnType<typeof createInMemoryDb>, name: string) {
  const wfId = ulid()
  const tId = ulid()
  const now = Date.now()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(tasks)
    .values({
      id: tId,
      name,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${tId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: now,
    })
    .run()
  return tId
}

describe('RFC-037 — task row mappers include `name`', () => {
  test('getTask returns name', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = seedTask(db, 'PR-1234 fix pagination')
    const t = await getTask(db, id)
    expect(t?.name).toBe('PR-1234 fix pagination')
  })

  test('listTasks returns name per row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedTask(db, 'one')
    seedTask(db, 'two')
    const rows = await listTasks(db, { limit: 100 })
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(['one', 'two'])
  })
})
