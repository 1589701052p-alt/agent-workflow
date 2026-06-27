// RFC-103 T2 (调研报告 01-LIFE-06 / 02-SCHED) — 启动运行期配置透传回归锁。
//
// 为什么这条测试存在：maxConcurrentNodes 从未从任何 HTTP 入口接线（生产恒走
// scheduler 默认 4，无视 settings）；commitPush 只在 JSON start 传，
// resume/repair/retry/multipart-start 均不传，retryNode 内部 runTask 也丢了
// commitPush。本测试锁定：① runtimeConfigOpts 把 StartTaskDeps 的 commitPush +
// maxConcurrentNodes 正确摊进 RunTaskOptions（单一事实源，三处 kick 共用）；
// ② 5 个 route 入口都经 resolveLaunchRuntimeConfig 解析（源码层文本断言防再漂）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { runtimeConfigOpts } from '../src/services/task'

describe('RFC-103 T2 runtimeConfigOpts — 单一事实源摊配置', () => {
  test('commitPush 全字段 + maxConcurrentNodes 摊成 flat RunTaskOptions 键', () => {
    expect(
      runtimeConfigOpts({
        commitPush: { model: 'gpt', maxRepairRetries: 2, diffMaxBytes: 9 },
        maxConcurrentNodes: 7,
      }),
    ).toEqual({
      commitPushModel: 'gpt',
      commitPushMaxRepairRetries: 2,
      commitPushDiffMaxBytes: 9,
      maxConcurrentNodes: 7,
    })
  })

  test('空 deps → 空对象（不污染 RunTaskOptions）', () => {
    expect(runtimeConfigOpts({})).toEqual({})
  })

  test('只有 maxConcurrentNodes', () => {
    expect(runtimeConfigOpts({ maxConcurrentNodes: 3 })).toEqual({ maxConcurrentNodes: 3 })
  })

  test('commitPush 部分字段只摊存在的', () => {
    expect(runtimeConfigOpts({ commitPush: { model: 'm' } })).toEqual({ commitPushModel: 'm' })
  })

  // RFC-115: timeout (was hand-spread at each runTask site) + the new retry
  // budget + defaultRuntime (Codex F3: never threaded before) all flow through
  // this single funnel now.
  test('RFC-115: defaultPerNodeTimeoutMs / defaultNodeRetries / defaultRuntime 经同一漏斗摊出', () => {
    expect(
      runtimeConfigOpts({
        defaultPerNodeTimeoutMs: 1000,
        defaultNodeRetries: 5,
        defaultRuntime: 'claude-code',
      }),
    ).toEqual({
      defaultPerNodeTimeoutMs: 1000,
      defaultNodeRetries: 5,
      defaultRuntime: 'claude-code',
    })
  })

  test('RFC-115 (Codex F3): defaultRuntime 单独也摊出 — 修复它从未接进 startTask 的 gap', () => {
    expect(runtimeConfigOpts({ defaultRuntime: 'opencode-opus' })).toEqual({
      defaultRuntime: 'opencode-opus',
    })
  })

  test('RFC-115: defaultNodeRetries 0 也摊出（nonnegative，不被当 falsy 跳过）', () => {
    expect(runtimeConfigOpts({ defaultNodeRetries: 0 })).toEqual({ defaultNodeRetries: 0 })
  })
})

describe('RFC-103 T2 源码层接线断言（防再漂）', () => {
  const routesSrc = readFileSync(join(import.meta.dir, '../src/routes/tasks.ts'), 'utf8')
  const taskSrc = readFileSync(join(import.meta.dir, '../src/services/task.ts'), 'utf8')

  test('routes/tasks.ts 的 8 个入口都调用 resolveLaunchRuntimeConfig', () => {
    const calls = routesSrc.match(/resolveLaunchRuntimeConfig\(deps\.configPath\)/g) ?? []
    // RFC-103 (5): JSON start / multipart-start(fail) / multipart-start(success) / resume / retry
    // RFC-108 T4 (+2, Codex design gate P2): repair-options + repair — a repair
    // option may resumeAfterApply → resumeTask(deps), which must carry the
    // timeout floor + commit&push + concurrency just like the launch entries.
    // RFC-109 (+1): sync-workflow → syncTaskWorkflow(deps), same runtime config.
    expect(calls.length).toBe(8)
  })

  test('routes 不再保留旧的「只 start 传 commitPush」单点写法', () => {
    expect(routesSrc).not.toContain('...(commitPush !== undefined ? { commitPush } : {})')
  })

  test('start/resume/retry 三处 kick 都经 runtimeConfigOpts 透传', () => {
    const spreads = taskSrc.match(/\.\.\.runtimeConfigOpts\(/g) ?? []
    // startTask + resumeTask（同块 replace_all）+ retryNode = 3
    expect(spreads.length).toBe(3)
  })

  test('RFC-115: 三处 runTask 调用点不再手动 spread per-node timeout（收进漏斗）', () => {
    // Before RFC-115 each runTask({...}) hand-spread defaultPerNodeTimeoutMs;
    // now runtimeConfigOpts injects it, so the only remaining textual occurrence
    // of the deps spread is INSIDE runtimeConfigOpts itself, and the retryNode
    // `opts.deps.*` variant is gone entirely (Codex F3 single funnel).
    expect(taskSrc).not.toContain('defaultPerNodeTimeoutMs: opts.deps.defaultPerNodeTimeoutMs')
    const depSpreads =
      taskSrc.match(/defaultPerNodeTimeoutMs: deps\.defaultPerNodeTimeoutMs/g) ?? []
    expect(depSpreads.length).toBe(1) // only the funnel
  })
})
