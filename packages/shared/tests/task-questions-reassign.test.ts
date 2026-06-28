// RFC-120 — locks `canReassign`: only designer-role (修订型) entries may be
// re-targeted, and only to a workflow node that is an agent node (Codex F5).
//
// Intent of each lock:
//   * designer + target in the agent-node set → true.
//   * designer + target NOT an agent node (io/review/clarify/wrapper, or not in
//     the workflow at all) → false (would be a runtime failure / non-handler).
//   * self / questioner (阻塞-产出型) → always false — re-targeting them would
//     deadlock the workflow (the asking node / questioner must run itself).

import { describe, expect, test } from 'bun:test'
import { canReassign } from '../src/task-questions'

const agentNodes = new Set(['design', 'fixer', 'coder'])

describe('canReassign', () => {
  test('designer + agent target → true', () => {
    expect(canReassign({ roleKind: 'designer' }, 'fixer', agentNodes)).toBe(true)
  })

  test('designer + non-agent / unknown node → false', () => {
    expect(canReassign({ roleKind: 'designer' }, 'review-node', agentNodes)).toBe(false)
    expect(canReassign({ roleKind: 'designer' }, 'not-in-workflow', agentNodes)).toBe(false)
  })

  test('self entry → false (阻塞-产出型, deadlock if re-targeted)', () => {
    expect(canReassign({ roleKind: 'self' }, 'fixer', agentNodes)).toBe(false)
  })

  test('questioner entry → false (阻塞-产出型)', () => {
    expect(canReassign({ roleKind: 'questioner' }, 'fixer', agentNodes)).toBe(false)
  })

  test('empty agent set → false even for designer', () => {
    expect(canReassign({ roleKind: 'designer' }, 'fixer', new Set())).toBe(false)
  })
})
