// RFC-056 PR-D C2 — prompt-injection source-text 守门.
//
// `shared/prompt.ts` exposes 3 cross-clarify builtin tokens
// (__external_feedback__ / __external_feedback_iteration__ /
// __external_feedback_sources__) that designer agent prompt templates may
// reference. `shared/clarify-cross.ts` defines the auto-append section
// heading literal `## External Feedback`. If any of these literals get
// renamed or removed the designer rerun prompt silently breaks; this test
// pins the source text byte-for-byte.
//
// LOCKS (grep on source):
//   1. packages/shared/src/prompt.ts contains all 3 token literals
//      (`{{__external_feedback__}}`, `{{__external_feedback_iteration__}}`,
//      `{{__external_feedback_sources__}}`).
//   2. packages/shared/src/clarify-cross.ts contains the
//      `## External Feedback` block title literal (matches
//      CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE).
//   3. The exported `CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE` constant
//      really resolves to the literal `## External Feedback`.
//
// If this goes red the cross-clarify designer rerun prompt has silently
// drifted away from the agent contract — investigate before relaxing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE } from '@agent-workflow/shared'

const SHARED_ROOT = resolve(import.meta.dir, '..')
const PROMPT_TS = resolve(SHARED_ROOT, 'src', 'prompt.ts')
const CLARIFY_CROSS_TS = resolve(SHARED_ROOT, 'src', 'clarify-cross.ts')

describe('RFC-056 C2 — prompt token + auto-append literal grep guard', () => {
  test('packages/shared/src/prompt.ts references {{__external_feedback__}}', () => {
    const src = readFileSync(PROMPT_TS, 'utf-8')
    expect(src).toContain('__external_feedback__')
  })

  test('packages/shared/src/prompt.ts references {{__external_feedback_iteration__}}', () => {
    const src = readFileSync(PROMPT_TS, 'utf-8')
    expect(src).toContain('__external_feedback_iteration__')
  })

  test('packages/shared/src/prompt.ts references {{__external_feedback_sources__}}', () => {
    const src = readFileSync(PROMPT_TS, 'utf-8')
    expect(src).toContain('__external_feedback_sources__')
  })

  test('packages/shared/src/clarify-cross.ts contains the `## External Feedback` block title literal', () => {
    const src = readFileSync(CLARIFY_CROSS_TS, 'utf-8')
    expect(src).toContain('## External Feedback')
  })

  test('CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE constant resolves to the literal `## External Feedback`', () => {
    expect(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE).toBe('## External Feedback')
  })
})
