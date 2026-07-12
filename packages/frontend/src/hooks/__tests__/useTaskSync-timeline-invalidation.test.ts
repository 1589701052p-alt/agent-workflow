// RFC-W002 - source-level guard for the timeline's WS invalidation wiring.
// useTaskSync is a WS-driven hook (hard to exercise at runtime without a socket
// harness), so per CLAUDE.md「最低限度兜底」we lock the wiring at the source
// level: the ['task-timeline', taskId] invalidation must appear in each
// interaction-changing branch (node.status / review.* / clarify.* /
// cross-clarify.*). node.event is INTENTIONALLY excluded - it fires per
// opencode event (per token) and the feed only changes on the done transition,
// which node.status already covers. If a refactor drops or mis-scopes the
// invalidation, this goes red.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(resolve(__dirname, '..', 'useTaskSync.ts'), 'utf8')

describe('useTaskSync timeline invalidation (RFC-W002)', () => {
  it("invalidates ['task-timeline'] in node.status / review / clarify / cross-clarify branches", () => {
    const matches = src.match(/\['task-timeline', taskId\]/g)
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  it('does NOT invalidate the timeline on node.event (per-token chatty; done covered by node.status)', () => {
    // Isolate the node.event branch and assert it has no timeline invalidation.
    const start = src.indexOf("if (msg.type === 'node.event')")
    expect(start).toBeGreaterThan(-1)
    const blockEnd = src.indexOf('}', start)
    const block = src.slice(start, blockEnd)
    expect(block).not.toContain("'task-timeline'")
  })
})
