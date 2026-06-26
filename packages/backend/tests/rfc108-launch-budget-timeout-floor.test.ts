// RFC-108 PR-B (AR-01 / AR-02) — launch-path config wiring regression lock.
//
// 为什么这条测试存在：`defaultPerNodeTimeoutMs`（config 默认 30min）与
// `defaultPerTaskMaxDurationMs` / `defaultPerTaskMaxTotalTokens` 在 RFC-108 之前
// 全部「定义了但消费方为零」——`resolveLaunchRuntimeConfig` 只返回 commitPush +
// maxConcurrentNodes，于是 default 配置下节点跑在「无硬超时」、任务无预算
// （hung-but-alive 子进程实质永生）。本测试锁定：
//   ① resolveLaunchRuntimeConfig 现在把 per-node timeout floor + per-task 预算
//      从 settings 解析出来（>0 才返回；0 视为 unlimited → 省略）；
//   ② startTask 插入用 deps 的 per-task 预算作 fallback（源码层文本断言防再漂）；
//   ③ shipped 默认 per-task duration = 0（unlimited），避免对合法长跑任务的
//      不可恢复（canceled 非 resumable）误杀——Codex 设计 gate 折入的 D5 微调。
// 关联：RFC-103 T2 同范式 + Codex 设计 gate P2（repair 路径也须带 floor）。

import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '@agent-workflow/shared'

import { resolveLaunchRuntimeConfig } from '../src/routes/tasks'

describe('RFC-108 T4/T5 resolveLaunchRuntimeConfig — 接线 timeout floor + per-task 预算', () => {
  let tmp: string
  let path: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-rfc108-cfg-'))
    path = join(tmp, 'config.json')
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('正值 timeout/budget 全部从 settings 解析出来', () => {
    writeFileSync(
      path,
      JSON.stringify({
        $schema_version: 1,
        defaultPerNodeTimeoutMs: 120_000,
        defaultPerTaskMaxDurationMs: 900_000,
        defaultPerTaskMaxTotalTokens: 50_000,
      }),
    )
    const out = resolveLaunchRuntimeConfig(path)
    expect(out.defaultPerNodeTimeoutMs).toBe(120_000)
    expect(out.defaultPerTaskMaxDurationMs).toBe(900_000)
    expect(out.defaultPerTaskMaxTotalTokens).toBe(50_000)
  })

  test('per-node timeout floor 默认 30min 也被接线（不再恒 undefined）', () => {
    // 不写 timeout 字段 → loadConfig 回填 DEFAULT_CONFIG 的 30min。
    writeFileSync(path, JSON.stringify({ $schema_version: 1 }))
    const out = resolveLaunchRuntimeConfig(path)
    expect(out.defaultPerNodeTimeoutMs).toBe(DEFAULT_CONFIG.defaultPerNodeTimeoutMs)
    expect(out.defaultPerNodeTimeoutMs).toBe(30 * 60 * 1000)
  })

  test('per-task 预算 0=unlimited → 省略（不在 deps 里强加不可恢复的 cap）', () => {
    writeFileSync(
      path,
      JSON.stringify({
        $schema_version: 1,
        defaultPerTaskMaxDurationMs: 0,
        defaultPerTaskMaxTotalTokens: 0,
      }),
    )
    const out = resolveLaunchRuntimeConfig(path)
    expect(out.defaultPerTaskMaxDurationMs).toBeUndefined()
    expect(out.defaultPerTaskMaxTotalTokens).toBeUndefined()
  })

  test('shipped 默认 per-task duration = 0（unlimited，D5 微调，防误杀长任务）', () => {
    expect(DEFAULT_CONFIG.defaultPerTaskMaxDurationMs).toBe(0)
    expect(DEFAULT_CONFIG.defaultPerTaskMaxTotalTokens).toBe(0)
  })
})

describe('RFC-108 T5 源码层接线断言（防再漂）', () => {
  const taskSrc = readFileSync(join(import.meta.dir, '../src/services/task.ts'), 'utf8')
  const routesSrc = readFileSync(join(import.meta.dir, '../src/routes/tasks.ts'), 'utf8')

  test('startTask 插入用 deps 的 per-task 预算作 fallback', () => {
    expect(taskSrc).toContain('input.maxDurationMs ?? deps.defaultPerTaskMaxDurationMs ?? null')
    expect(taskSrc).toContain('input.maxTotalTokens ?? deps.defaultPerTaskMaxTotalTokens ?? null')
  })

  test('resolveLaunchRuntimeConfig 现读 defaultPerNodeTimeoutMs（接线 floor）', () => {
    expect(routesSrc).toContain('cfg.defaultPerNodeTimeoutMs')
    expect(routesSrc).toContain('cfg.defaultPerTaskMaxDurationMs')
  })
})
