// RFC-120 — locks `deriveQuestionPhase`: the pure mapping from (round status,
// confirmation overlay, resolved handler run) to the displayed lifecycle phase.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * canceled/abandoned source round → 'closed' (反问 withdrawn), and that
//     check comes FIRST (a withdrawn round is closed regardless of overlay).
//   * confirmation === 'confirmed' → 'done' (the only manual terminal).
//   * no handler run, or a handler still 'pending' (no startedAt) → 'pending'
//     — matches the user's "未交给 agent 执行 = 待处理".
//   * handler 'running' → 'processing'.
//   * **handler 'failed' → 'processing'** (decision D3: failure stays 处理中,
//     system retries / awaits manual rerun; the 4-state machine adds no failed
//     state). This lock guards that decision.
//   * handler 'done' WITH output → 'awaiting_confirm'.
//   * handler 'done' WITHOUT output → 'processing' (defensive; a real done run
//     always has output else it'd be failed).

import { describe, expect, test } from 'bun:test'
import { deriveQuestionPhase, type HandlerRunView } from '../src/task-questions'

const handler = (over: Partial<HandlerRunView>): HandlerRunView => ({
  status: 'running',
  startedAt: 1,
  hasOutput: false,
  ...over,
})

describe('deriveQuestionPhase', () => {
  test('canceled round → closed (checked before everything)', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'canceled',
        confirmation: 'confirmed',
        handlerRun: handler({ status: 'done', hasOutput: true }),
      }),
    ).toBe('closed')
  })

  test('abandoned round → closed', () => {
    expect(
      deriveQuestionPhase({ roundStatus: 'abandoned', confirmation: 'open', handlerRun: null }),
    ).toBe('closed')
  })

  test('confirmed → done', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'confirmed',
        handlerRun: handler({ status: 'done', hasOutput: true }),
      }),
    ).toBe('done')
  })

  test('no handler run → pending', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'awaiting_human',
        confirmation: 'open',
        handlerRun: null,
      }),
    ).toBe('pending')
  })

  test('handler minted but not started (startedAt null) → pending', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'open',
        handlerRun: handler({ status: 'pending', startedAt: null }),
      }),
    ).toBe('pending')
  })

  test('handler running → processing', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'open',
        handlerRun: handler({ status: 'running' }),
      }),
    ).toBe('processing')
  })

  test('handler failed → processing (D3: failure stays 处理中)', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'open',
        handlerRun: handler({ status: 'failed', startedAt: 5 }),
      }),
    ).toBe('processing')
  })

  test('handler done + output → awaiting_confirm', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'open',
        handlerRun: handler({ status: 'done', hasOutput: true }),
      }),
    ).toBe('awaiting_confirm')
  })

  test('handler done WITHOUT output → processing (defensive)', () => {
    expect(
      deriveQuestionPhase({
        roundStatus: 'answered',
        confirmation: 'open',
        handlerRun: handler({ status: 'done', hasOutput: false }),
      }),
    ).toBe('processing')
  })
})
