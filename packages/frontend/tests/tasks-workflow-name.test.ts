// Locks in that both the tasks list table and the task detail header render
// the joined workflow name (with a fallback to workflow id when the row was
// deleted). Without these assertions, a refactor could silently revert to
// "show the opaque ULID only" — which is exactly what we just moved away
// from. We pin the source text instead of driving the routed components
// because tasks.tsx / tasks.detail.tsx both register at runtime against
// TanStack Router and that wiring is awkward to mount in happy-dom.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const LIST_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/routes/tasks.tsx',
)
const DETAIL_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/routes/tasks.detail.tsx',
)

describe('tasks list shows workflow name', () => {
  test('table header includes the Workflow column', async () => {
    const src = await fs.readFile(LIST_SRC, 'utf8')
    expect(src).toMatch(/<th>\{t\('tasks\.colWorkflow'\)\}<\/th>/)
  })

  test('row renders workflowName with workflowId fallback, linked to the workflow', async () => {
    const src = await fs.readFile(LIST_SRC, 'utf8')
    expect(src).toMatch(/row\.workflowName \?\? row\.workflowId/)
    // The cell links into the workflow editor — clicking the name shouldn't
    // be a dead end.
    expect(src).toMatch(/to="\/workflows\/\$id"\s+params=\{\{ id: row\.workflowId \}\}/)
  })
})

describe('task detail shows workflow name', () => {
  test('header dd renders workflowName with workflowId fallback', async () => {
    const src = await fs.readFile(DETAIL_SRC, 'utf8')
    expect(src).toMatch(/tk\.workflowName \?\? tk\.workflowId/)
    // The id is still preserved alongside (parenthesised, muted) so power
    // users can copy the ULID without round-tripping through the editor.
    expect(src).toMatch(/tk\.workflowName !== null/)
  })
})
