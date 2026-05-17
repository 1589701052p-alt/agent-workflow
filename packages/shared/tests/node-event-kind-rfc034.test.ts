// RFC-034 T7 — locks the two new node_run_events kinds for submodule
// warnings (init failure on worktree create, sync failure on warm-fetch /
// refresh of a cached repo). Both schema sources (NODE_EVENT_KIND in
// schemas/task.ts and NodeEventKindSchema in schemas/ws.ts) must agree.

import { describe, expect, test } from 'bun:test'

import { NODE_EVENT_KIND } from '../src/schemas/task.js'
import { NodeEventKindSchema } from '../src/schemas/ws.js'

describe('RFC-034 node event kinds', () => {
  test('NODE_EVENT_KIND includes submodule_init_failed', () => {
    expect((NODE_EVENT_KIND as readonly string[]).includes('submodule_init_failed')).toBe(true)
  })

  test('NODE_EVENT_KIND includes submodule_sync_failed', () => {
    expect((NODE_EVENT_KIND as readonly string[]).includes('submodule_sync_failed')).toBe(true)
  })

  test('NodeEventKindSchema parses both new kinds', () => {
    expect(NodeEventKindSchema.parse('submodule_init_failed')).toBe('submodule_init_failed')
    expect(NodeEventKindSchema.parse('submodule_sync_failed')).toBe('submodule_sync_failed')
  })

  test('the two schema sources stay in lock-step on all RFC-034 kinds', () => {
    for (const kind of ['submodule_init_failed', 'submodule_sync_failed']) {
      expect((NODE_EVENT_KIND as readonly string[]).includes(kind)).toBe(true)
      expect(() => NodeEventKindSchema.parse(kind)).not.toThrow()
    }
  })
})
