// RFC-120 — locks `deriveQuestionPhase`: the pure mapping from (round status,
// confirmation overlay, staged flag, resolved handler run) to the displayed
// kanban phase.
//
// v2 (2026-06-28 design discussion): 「下发」(minting the handler rerun) is the
// pending/staged → processing boundary — once a handler run EXISTS the entry is
// 处理中 (dispatched), regardless of whether the run has started. design §11.2/11.6.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * canceled/abandoned source round → 'closed' (反问 withdrawn), checked FIRST.
//   * confirmation === 'confirmed' → 'done' (the only manual terminal).
//   * NOT dispatched (no handler run) + isStaged → 'staged' (待下发, approved
//     awaiting batch dispatch); NOT dispatched + not staged → 'pending' (待指派).
//   * **dispatched (handler run present) → 'processing' even when the run is
//     still queued (status 'pending', no startedAt)** — dispatch is the boundary,
//     not run start. This is the v2 change from the original startedAt-based rule.
//   * staged is ONLY a pre-dispatch state — once dispatched, processing wins.
//   * **handler 'failed' → 'processing'** (decision D3: failure stays 处理中).
//   * handler 'done' WITH output → 'awaiting_confirm'; done WITHOUT output →
//     'processing' (defensive).

import { describe, expect, test } from 'bun:test'
import {
  deriveQuestionPhase,
  type DeriveQuestionPhaseInput,
  type HandlerRunView,
} from '../src/task-questions'

const input = (over: Partial<DeriveQuestionPhaseInput>): DeriveQuestionPhaseInput => ({
  roundStatus: 'answered',
  confirmation: 'open',
  isStaged: false,
  handlerRun: null,
  ...over,
})

const handler = (over: Partial<HandlerRunView> = {}): HandlerRunView => ({
  status: 'running',
  startedAt: 1,
  hasOutput: false,
  ...over,
})

describe('deriveQuestionPhase (v2)', () => {
  test('canceled round → closed (checked before everything)', () => {
    expect(
      deriveQuestionPhase(
        input({
          roundStatus: 'canceled',
          confirmation: 'confirmed',
          handlerRun: handler({ status: 'done', hasOutput: true }),
        }),
      ),
    ).toBe('closed')
  })

  test('abandoned round → closed', () => {
    expect(deriveQuestionPhase(input({ roundStatus: 'abandoned' }))).toBe('closed')
  })

  test('confirmed → done', () => {
    expect(
      deriveQuestionPhase(
        input({
          confirmation: 'confirmed',
          handlerRun: handler({ status: 'done', hasOutput: true }),
        }),
      ),
    ).toBe('done')
  })

  test('not dispatched + not staged → pending (待指派)', () => {
    expect(deriveQuestionPhase(input({ handlerRun: null, isStaged: false }))).toBe('pending')
  })

  test('not dispatched + staged → staged (待下发)', () => {
    expect(deriveQuestionPhase(input({ handlerRun: null, isStaged: true }))).toBe('staged')
  })

  test('staged is pre-dispatch only — once dispatched, processing wins', () => {
    expect(
      deriveQuestionPhase(input({ isStaged: true, handlerRun: handler({ status: 'running' }) })),
    ).toBe('processing')
  })

  test('v2: dispatched but still queued (run pending, no startedAt) → processing', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'pending', startedAt: null }) })),
    ).toBe('processing')
  })

  test('handler running → processing', () => {
    expect(deriveQuestionPhase(input({ handlerRun: handler({ status: 'running' }) }))).toBe(
      'processing',
    )
  })

  test('handler failed → processing (D3: failure stays 处理中)', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'failed', startedAt: 5 }) })),
    ).toBe('processing')
  })

  test('handler done + output → awaiting_confirm', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'done', hasOutput: true }) })),
    ).toBe('awaiting_confirm')
  })

  test('handler done WITHOUT output → processing (defensive)', () => {
    expect(
      deriveQuestionPhase(input({ handlerRun: handler({ status: 'done', hasOutput: false }) })),
    ).toBe('processing')
  })
})
