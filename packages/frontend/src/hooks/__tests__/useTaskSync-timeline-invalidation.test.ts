// RFC-W002 - source-level guard for the timeline's WS invalidation wiring.
// useTaskSync is a WS-driven hook (hard to exercise at runtime without a socket
// harness), so per CLAUDE.md「最低限度兜底」we lock the wiring at the source
// level. RFC-152 factored the message handlers into a WsInvalidationRules table
// with shared reviewKeys / clarifyKeys helpers. The ['task-timeline', taskId]
// invalidation must appear in:
//   - reviewKeys  (covers review.created / decision_made / comment_* / selection_changed)
//   - clarifyKeys (covers clarify.created/answered AND cross-clarify.* - those rules
//     spread clarifyKeys)
//   - the node.status rule (a run flipping to done surfaces a node_output item)
// node.event is INTENTIONALLY excluded - it fires per opencode event (per token)
// and the feed only changes on the done transition, which node.status covers.
// If a refactor drops or mis-scopes the invalidation, this goes red.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(resolve(__dirname, '..', 'useTaskSync.ts'), 'utf8')

describe('useTaskSync timeline invalidation (RFC-W002)', () => {
  it("invalidates ['task-timeline'] in reviewKeys / clarifyKeys / node.status", () => {
    // reviewKeys helper body (covers review.*).
    const reviewKeysStart = src.indexOf('reviewKeys')
    const clarifyKeysStart = src.indexOf('clarifyKeys', reviewKeysStart + 1)
    expect(src.slice(reviewKeysStart, clarifyKeysStart)).toContain("['task-timeline', taskId]")

    // clarifyKeys helper body (covers clarify.* AND cross-clarify.*).
    const rulesStart = src.indexOf('const rules', clarifyKeysStart)
    expect(src.slice(clarifyKeysStart, rulesStart)).toContain("['task-timeline', taskId]")

    // node.status rule body (slice to the next rule key, 'node.event').
    const nodeStatusStart = src.indexOf("'node.status'")
    const nodeEventStart = src.indexOf("'node.event'", nodeStatusStart + 1)
    expect(src.slice(nodeStatusStart, nodeEventStart)).toContain("['task-timeline', taskId]")
  })

  it('does NOT invalidate the timeline on node.event (per-token chatty; done covered by node.status)', () => {
    // RFC-152 rules table: isolate the 'node.event' rule body (slice to the next
    // rule key 'review.created') and assert it has no timeline invalidation.
    const nodeEventStart = src.indexOf("'node.event'")
    expect(nodeEventStart).toBeGreaterThan(-1)
    const reviewCreatedStart = src.indexOf("'review.created'", nodeEventStart + 1)
    const nodeEventBlock = src.slice(nodeEventStart, reviewCreatedStart)
    expect(nodeEventBlock).not.toContain("'task-timeline'")
  })
})
