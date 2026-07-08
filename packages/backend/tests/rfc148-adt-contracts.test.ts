// RFC-148 T3 — promptMode / clarifyChannel 判别联合契约。
//
// 为什么这条测试存在：八个散装字段（envelopeFollowup 四件套 + clarify 四
// 布尔）收敛为两个判别联合后，本文件锁三层契约：
//   1. 非法状态类型不可表示（followup 无 session / stopped 无接线）——
//      编译期 @ts-expect-error 断言；
//   2. 渲染投影格：directive 三态 × 渲染面（mandatory=ask-back preamble、
//      suppressed/none=输出协议、stopped+notice=STOP trailer）——特别是
//      设计门 high 要求的 suppressed-cross 回归（review 重跑抑制下 prompt
//      不得带 mandatory preamble）；
//   3. runner 源码形态锁：解析 cap 只随接线族（kind==='cross'）不随
//      directive——suppressed cross 自愿 clarify 仍享无上限 cap。

import type { ClarifyChannel, PromptMode } from '@agent-workflow/shared'
import { renderUserPrompt } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const BASE = {
  promptTemplate: 'Work on {{spec}}.',
  inputs: { spec: 'S' },
  meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
  agentOutputs: ['out'],
}

describe('RFC-148 — 非法状态类型不可表示（编译期断言）', () => {
  test('followup 臂必须携带 resumeSessionId；stopped 必须有接线族', () => {
    // @ts-expect-error — followup without resumeSessionId is unrepresentable
    const bad1: PromptMode = { kind: 'followup', reason: 'envelope-missing' }
    // @ts-expect-error — a directive requires a wired kind ('none' has no directive)
    const bad2: ClarifyChannel = { kind: 'none', directive: 'stopped', injectStopNotice: false }
    const good1: PromptMode = {
      kind: 'followup',
      resumeSessionId: 'ses_1',
      reason: 'envelope-missing',
    }
    const good2: ClarifyChannel = {
      kind: 'cross',
      directive: 'suppressed',
      injectStopNotice: false,
    }
    expect([bad1, bad2, good1, good2].length).toBe(4)
  })
})

describe('RFC-148 — clarifyChannel 渲染投影格', () => {
  const render = (clarifyChannel?: ClarifyChannel) =>
    renderUserPrompt({ ...BASE, ...(clarifyChannel !== undefined ? { clarifyChannel } : {}) })

  test('mandatory：注入 MANDATORY ASK-BACK preamble、无输出协议', () => {
    const out = render({ kind: 'self', directive: 'mandatory', injectStopNotice: false })
    expect(out).toContain('MANDATORY ASK-BACK')
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })

  test('suppressed-cross（设计门回归）：review 重跑抑制下 prompt 是纯输出协议——cap 语义留给 runner', () => {
    const out = render({ kind: 'cross', directive: 'suppressed', injectStopNotice: false })
    expect(out).not.toContain('MANDATORY ASK-BACK')
    expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(out).not.toContain('STOP CLARIFYING')
  })

  test('stopped + injectStopNotice：注入 STOP trailer + 输出协议', () => {
    const out = render({ kind: 'self', directive: 'stopped', injectStopNotice: true })
    expect(out).toContain('STOP CLARIFYING')
    expect(out).toContain('You MUST end your reply with a `<workflow-output>` block')
    expect(out).not.toContain('MANDATORY ASK-BACK')
  })

  test('stopped 不带 notice / none / 缺省：三者字节相同（纯输出协议）', () => {
    const stopped = render({ kind: 'self', directive: 'stopped', injectStopNotice: false })
    const none = render({ kind: 'none' })
    const absent = render(undefined)
    expect(stopped).toBe(none)
    expect(none).toBe(absent)
  })
})

describe('RFC-148 — runner 源码形态锁（cap 随接线族、门随 directive）', () => {
  const runnerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
    'utf8',
  )

  test('解析 cap 判定锚 kind===cross（不看 directive——suppressed cross 仍无上限）', () => {
    expect(runnerSrc).toMatch(
      /channel\.kind === 'cross' \? \{ maxQuestions: Number\.POSITIVE_INFINITY \}/,
    )
  })

  test('clarify-required 门锚 mandatory、clarify-forbidden 门锚 stopped', () => {
    expect(runnerSrc).toContain("clarifyWired && channel.directive === 'mandatory'")
    expect(runnerSrc).toContain("clarifyWired && channel.directive === 'stopped'")
  })

  test('followup 判别单点派生（散装 !== true 守卫不得回潮）', () => {
    expect(runnerSrc).toContain("opts.promptMode?.kind === 'followup'")
    expect(runnerSrc).not.toMatch(/envelopeFollowup !== true/)
    expect(runnerSrc).not.toMatch(/\?\? 'envelope-missing'/)
  })
})
