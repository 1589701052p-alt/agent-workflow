// RFC-W004 T14 - to-agent rerun cause registration + gate-2 membership.
//
// Complements rfc098-rerun-cause-gates.test.ts (which is exhaustive over the
// full RERUN_CAUSES enum) with a focused to-agent contract doc: WHY each of
// the three new causes is or isn't in the isClarifyRerun (gate-2) set.
//
//   'clarify-to-agent-park'             - park cause (awaiting_human); NOT a
//                                         rerun-with-answer -> gate-2 closed.
//   'clarify-to-agent-answer'           - answerer A is a FRESH rollback run
//                                         (rolls back to pre_snapshot to answer
//                                         B); mirrors the cross-clarify designer
//                                         update exclusion (gate-3 path, re-
//                                         derives Clarify Request from
//                                         generation order) -> gate-2 closed.
//   'clarify-to-agent-questioner-rerun' - B resumes its session carrying A's
//                                         answer (final output with the answer
//                                         injected as flat Q&A); SAME resume
//                                         semantics as cross-clarify-questioner
//                                         -rerun -> gate-2 OPEN.

import { describe, expect, test } from 'bun:test'
import { RERUN_CAUSES } from '@agent-workflow/shared'
import { isClarifyRerunCause } from '../src/services/nodeRunMint'

describe('RFC-W004 T14 - to-agent rerun causes', () => {
  test('all three to-agent causes are registered in RERUN_CAUSES', () => {
    expect(RERUN_CAUSES).toContain('clarify-to-agent-park')
    expect(RERUN_CAUSES).toContain('clarify-to-agent-answer')
    expect(RERUN_CAUSES).toContain('clarify-to-agent-questioner-rerun')
  })

  test('clarify-to-agent-questioner-rerun opens gate-2 (B resumes its session)', () => {
    expect(isClarifyRerunCause('clarify-to-agent-questioner-rerun')).toBe(true)
  })

  test('clarify-to-agent-answer does NOT open gate-2 (A is a fresh rollback answer run)', () => {
    expect(isClarifyRerunCause('clarify-to-agent-answer')).toBe(false)
  })

  test('clarify-to-agent-park does NOT open gate-2 (park cause, not an answer rerun)', () => {
    expect(isClarifyRerunCause('clarify-to-agent-park')).toBe(false)
  })

  test('the to-agent causes do not collide with the cross-clarify cause names', () => {
    // `cross-clarify-questioner-rerun` and `clarify-to-agent-questioner-rerun`
    // are distinct strings (the gate-2 set holds both); the to-agent park /
    // answer causes are distinct from `cross-clarify-park` / `cross-clarify-answer`.
    const cross = ['cross-clarify-answer', 'cross-clarify-questioner-rerun', 'cross-clarify-park']
    const toAgent = [
      'clarify-to-agent-answer',
      'clarify-to-agent-questioner-rerun',
      'clarify-to-agent-park',
    ]
    for (const c of toAgent) {
      expect(cross).not.toContain(c)
    }
  })
})
