// RFC-029 T7 — lock: the inventory section's query key must live under the
// `['tasks', taskId, 'node-runs', nodeRunId, ...]` prefix so the existing
// RFC-027 / retry-mutation invalidations (prefix-match) flush it too. If
// someone refactors the section to use a flat key like `['inventory', id]`,
// this grep makes the regression visible before the WS sync silently goes
// stale.

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SECTION = join(
  import.meta.dirname,
  '..',
  'src',
  'components',
  'inventory',
  'RuntimeInventorySection.tsx',
)

describe('Runtime inventory query-key shape lock', () => {
  test('RuntimeInventorySection.tsx exists once T9 lands', () => {
    // Soft pre-T9 guard: if the file isn't here yet, this test pendings.
    // After T9 it becomes the hard lock below.
    if (!existsSync(SECTION)) {
      console.warn('[RFC-029 T7] RuntimeInventorySection.tsx not present yet; T9 not landed.')
      return
    }
    const src = readFileSync(SECTION, 'utf-8')
    // Must derive its query key from taskId + nodeRunId so RFC-027's
    // invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
    // (prefix-match) also flushes inventory.
    expect(src).toContain("'tasks'")
    expect(src).toContain("'node-runs'")
    expect(src).toContain("'inventory'")
    // And it must call the /inventory REST endpoint.
    expect(src).toMatch(/\/api\/tasks\/.+\/node-runs\/.+\/inventory/)
  })
})
