// RFC-103 T5 (调研报告 04-WFM-06/07) — 校验器内置 prompt 变量单一事实源。
//
// 为什么这条测试存在：校验器（workflow.validator.ts）维护了一份 builtin
// prompt-var Set，与替换引擎（shared/prompt.ts BUILTIN_VARS）各写一份并漂移：
// 校验器漏了 RFC-066 多仓（__repos__ / __repo_names__ / __repo_count__）与
// RFC-056 cross-clarify（__external_feedback__ 等），导致合法的 {{__repos__}}
// 模板被误报 prompt-template-unresolved 而阻止 launch。修复后校验器复用 shared
// 的同一个 BUILTIN_VARS。本测试锁定：① 单源集含曾漏的 token；② 校验器不再有
// 本地副本、且 import 了共享集。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BUILTIN_VARS } from '@agent-workflow/shared'

describe('RFC-103 T5 — BUILTIN_VARS 单一事实源含曾被校验器漏掉的 token', () => {
  test('RFC-066 多仓变量在集中', () => {
    expect(BUILTIN_VARS.has('__repos__')).toBe(true)
    expect(BUILTIN_VARS.has('__repo_names__')).toBe(true)
    expect(BUILTIN_VARS.has('__repo_count__')).toBe(true)
  })
  test('RFC-056 cross-clarify 变量在集中', () => {
    expect(BUILTIN_VARS.has('__external_feedback__')).toBe(true)
    expect(BUILTIN_VARS.has('__external_feedback_iteration__')).toBe(true)
    expect(BUILTIN_VARS.has('__external_feedback_sources__')).toBe(true)
  })
  test('基础变量仍在', () => {
    expect(BUILTIN_VARS.has('__repo_path__')).toBe(true)
    expect(BUILTIN_VARS.has('__shard_key__')).toBe(true)
  })
})

describe('RFC-103 T5 — 源码层断言（校验器复用共享集，无本地副本）', () => {
  const validatorSrc = readFileSync(
    join(import.meta.dir, '../src/services/workflow.validator.ts'),
    'utf8',
  )
  test('校验器 import 共享 BUILTIN_VARS 并用它判定', () => {
    expect(validatorSrc).toContain('BUILTIN_VARS')
    expect(validatorSrc).toContain('BUILTIN_VARS.has(ref)')
  })
  test('校验器不再定义本地 BUILTIN_PROMPT_VARS 副本', () => {
    expect(validatorSrc).not.toContain('const BUILTIN_PROMPT_VARS')
  })
})
