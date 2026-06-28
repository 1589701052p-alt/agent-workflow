// RFC-120 §18 (T9 model A) — source-layer wiring guard for the launcher's
// deferred-question-dispatch toggle + the i18n keys for the toggle and the board
// batch-dispatch controls. The launch route DOM is expensive to mount (TanStack
// Router + Query + i18n), so — matching launch-working-branch.test.ts — we grep
// the source for the wiring invariants plus assert i18n parity. A regression that
// drops the body spread would silently never send `deferredQuestionDispatch`; one
// that drops the Switch would hide the control; a dropped i18n key fails typecheck
// parity but the value asserts pin the actual copy.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const LAUNCH_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
  'utf-8',
)
const BOARD_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'tasks', 'TaskQuestionList.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('workflows.launch.tsx — RFC-120 deferred question dispatch toggle', () => {
  test('declares deferredQuestionDispatch state (default false)', () => {
    expect(LAUNCH_SRC).toMatch(
      /const \[deferredQuestionDispatch, setDeferredQuestionDispatch\] = useState\(false\)/,
    )
  })

  test('renders the deferred-dispatch Switch wired to the shared primitive', () => {
    expect(LAUNCH_SRC).toContain("t('launch.deferredDispatch.label')")
    expect(LAUNCH_SRC).toContain("t('launch.deferredDispatch.hint')")
    expect(LAUNCH_SRC).toMatch(/checked=\{deferredQuestionDispatch\}/)
    expect(LAUNCH_SRC).toMatch(/onChange=\{setDeferredQuestionDispatch\}/)
  })

  test('submit payload spreads deferredQuestionDispatch only when true', () => {
    expect(LAUNCH_SRC).toMatch(
      /deferredQuestionDispatch\s*\?\s*\{ deferredQuestionDispatch: true \}/,
    )
  })
})

describe('TaskQuestionList.tsx — RFC-120 §18 batch-dispatch wiring', () => {
  test('posts to the dispatch endpoint with { entryIds }', () => {
    expect(BOARD_SRC).toMatch(/questions\/dispatch`, \{ entryIds \}/)
  })

  test('only staged cards are selectable + the bar is golden-locked to staged cards', () => {
    // checkbox guarded by phase === 'staged'
    expect(BOARD_SRC).toMatch(/phase === 'staged' &&[\s\S]*?type="checkbox"/)
    // action bar only renders when there is at least one staged card
    expect(BOARD_SRC).toMatch(/stagedShown\.length > 0 &&/)
  })

  test('invalidates the task + node-runs queries on a successful dispatch', () => {
    expect(BOARD_SRC).toMatch(/invalidateQueries\(\{ queryKey: \['tasks', taskId\] \}\)/)
    expect(BOARD_SRC).toMatch(
      /invalidateQueries\(\{ queryKey: \['tasks', taskId, 'node-runs'\] \}\)/,
    )
  })

  test('treats task-question-target-changed as retryable (re-fetch + retry notice)', () => {
    expect(BOARD_SRC).toContain("err.code === 'task-question-target-changed'")
    expect(BOARD_SRC).toContain("t('taskQuestions.dispatchTargetChanged')")
  })
})

describe('i18n — RFC-120 deferred dispatch + batch-dispatch keys parity', () => {
  test('zh-CN type declares launch.deferredDispatch + taskQuestions batch keys', () => {
    expect(ZH).toMatch(/deferredDispatch:\s*\{[\s\S]*?label: string[\s\S]*?hint: string[\s\S]*?\}/)
    expect(ZH).toContain('batchDispatch: string')
    expect(ZH).toContain('dispatchInFlight: string')
    expect(ZH).toContain('dispatchTargetChanged: string')
  })

  test('zh-CN launch + board values present', () => {
    expect(ZH).toContain("label: '问题延迟下发（任务中心批量处理）'")
    expect(ZH).toContain("batchDispatch: '批量下发'")
    expect(ZH).toContain("dispatchTargetChanged: '目标已变，请重试'")
  })

  test('en-US launch + board values present', () => {
    expect(EN).toContain("label: 'Defer question dispatch (batch from the task center)'")
    expect(EN).toContain("batchDispatch: 'Batch dispatch'")
    expect(EN).toContain("dispatchTargetChanged: 'Target changed, please retry'")
  })
})
