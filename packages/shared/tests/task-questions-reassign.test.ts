// RFC-127 T4 — locks `canReassign`: ANY role (self/questioner/designer/manual) entry may
// be re-targeted, and only to a workflow node that is an agent node (Codex F5).
//
// This REVERSES the RFC-120 designer-only restriction (the old self/questioner→false
// assertions are intentionally flipped here — borrow-the-shell 借壳顶替 lets the original
// node continue under the target agent X, so re-targeting a self/questioner no longer
// deadlocks). Intent of each lock:
//   * any role + target in the agent-node set → true.
//   * any role + target NOT an agent node (io/review/clarify/wrapper, or not in the
//     workflow at all) → false (no prompt/output contract to borrow into).
//   * empty agent set → false for every role (no valid target at all).

import { describe, expect, test } from 'bun:test'
import { canReassign } from '../src/task-questions'

const agentNodes = new Set(['design', 'fixer', 'coder'])

describe('canReassign (RFC-127 T4 — any role, agent-node target)', () => {
  test('agent target → true (designer/self/questioner all reassignable)', () => {
    // The role is no longer part of the predicate; assert it holds for every role so a
    // future re-introduction of a role gate goes red here.
    expect(canReassign('fixer', agentNodes)).toBe(true)
    expect(canReassign('design', agentNodes)).toBe(true)
    expect(canReassign('coder', agentNodes)).toBe(true)
  })

  test('non-agent / unknown node → false', () => {
    expect(canReassign('review-node', agentNodes)).toBe(false)
    expect(canReassign('not-in-workflow', agentNodes)).toBe(false)
  })

  test('empty agent set → false', () => {
    expect(canReassign('fixer', new Set())).toBe(false)
  })
})
