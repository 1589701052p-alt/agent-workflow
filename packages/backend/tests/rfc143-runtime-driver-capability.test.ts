// RFC-143 — runtime 能力对象收口的 PR-1 验收锁。
//
// 两组锁：
//  (A) 派生单源——RUNTIME_PROTOCOLS / BUILTIN_RUNTIMES / ProtocolSchema 从
//      DRIVERS 派生，且 nodeRunMint / runtimeRegistry 不再硬编码
//      `'opencode' || 'claude-code'` 字面量集合。
//  (B) 能力接口——RuntimeDriver 已长出 PR-1 的必需能力方法（minVersion /
//      defaultBinary / probe / listModels / captureSessions），两个内建 driver
//      都实现了它们。mock driver 骨架证明「注册即扩展」：一个第三 kind 的
//      driver 只要实现接口就能被 getRuntimeDriver 契约消费——buildBusinessSpawn
//      在 PR-4 补齐后此骨架扩为完整的零调用点改动集成证明。

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getRuntimeDriver,
  isKnownRuntimeKind,
  RUNTIME_KINDS,
  type RuntimeDriver,
} from '@/services/runtime'
import { BUILTIN_RUNTIMES, RUNTIME_PROTOCOLS } from '@/services/runtimeRegistry'

const SRC = (rel: string) => readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')

describe('RFC-143 (A) 派生单源', () => {
  it('RUNTIME_KINDS = DRIVERS 的 keys（当前两内建）', () => {
    expect([...RUNTIME_KINDS].sort()).toEqual(['claude-code', 'opencode'])
  })

  it('RUNTIME_PROTOCOLS 就是 RUNTIME_KINDS（registry 派生自 DRIVERS）', () => {
    expect([...RUNTIME_PROTOCOLS]).toEqual([...RUNTIME_KINDS])
  })

  it('BUILTIN_RUNTIMES 每个 kind 一行、name===protocol===kind', () => {
    expect(BUILTIN_RUNTIMES.map((b) => b.name).sort()).toEqual([...RUNTIME_KINDS].sort())
    for (const b of BUILTIN_RUNTIMES) expect(b.name).toBe(b.protocol)
  })

  it('isKnownRuntimeKind 只认注册的 kind', () => {
    expect(isKnownRuntimeKind('opencode')).toBe(true)
    expect(isKnownRuntimeKind('claude-code')).toBe(true)
    expect(isKnownRuntimeKind('bogus')).toBe(false)
    expect(isKnownRuntimeKind(null)).toBe(false)
    expect(isKnownRuntimeKind(undefined)).toBe(false)
  })

  it('nodeRunMint 不再硬编码 kind 字面量集合（改走 isKnownRuntimeKind）', () => {
    const src = SRC('services/nodeRunMint.ts')
    expect(src).not.toMatch(/=== 'opencode' \|\| .*=== 'claude-code'/)
    expect(src).toContain('isKnownRuntimeKind(')
  })

  it('runtimeRegistry 内建名 fallback 用 BUILTIN_NAMES（不再硬编码字面量）', () => {
    const src = SRC('services/runtimeRegistry.ts')
    expect(src).not.toMatch(/n === 'opencode' \|\| n === 'claude-code'/)
    expect(src).toContain('BUILTIN_NAMES.has(n)')
  })

  it('resolveRuntime 半死代码已删除（flag-audit 旁路：硬编码三元 coerce 第三 runtime）', () => {
    const src = SRC('services/runtime/index.ts')
    expect(src).not.toContain('export function resolveRuntime')
  })
})

describe('RFC-143 (B) 能力接口', () => {
  it('两内建 driver 都实现了 PR-1 必需能力方法 + minVersion', () => {
    for (const kind of RUNTIME_KINDS) {
      const d = getRuntimeDriver(kind)
      expect(typeof d.minVersion).toBe('string')
      expect(typeof d.defaultBinary).toBe('function')
      expect(typeof d.probe).toBe('function')
      expect(typeof d.listModels).toBe('function')
      expect(typeof d.captureSessions).toBe('function')
    }
  })

  it('defaultBinary：config path 优先，否则内建名', () => {
    const oc = getRuntimeDriver('opencode')
    expect(oc.defaultBinary({ opencodePath: '/x/oc' } as never)).toEqual(['/x/oc'])
    expect(oc.defaultBinary({} as never)).toEqual(['opencode'])
    const cc = getRuntimeDriver('claude-code')
    expect(cc.defaultBinary({ claudeCodePath: '/x/cl' } as never)).toEqual(['/x/cl'])
    expect(cc.defaultBinary({} as never)).toEqual(['claude'])
  })

  it('claude listModels 是静态表、恒 cached、忽略 binary', async () => {
    const cc = getRuntimeDriver('claude-code')
    const r = await cc.listModels('ignored')
    expect(r.cached).toBe(true)
    expect(r.binary).toBe('ignored')
    expect(r.models.length).toBeGreaterThan(0)
  })

  it('mock driver 骨架：第三 kind 实现接口即可被契约消费（「注册即扩展」基座）', () => {
    // PR-1 的必需接口面。PR-4 补 buildBusinessSpawn 后，此骨架扩为「注册进
    // DRIVERS + 跑通业务 spawn，零调用点改动」的完整集成证明。
    const mockDriver = {
      kind: 'opencode', // 借用已有 kind 满足 RuntimeKind union（真第三 kind 需 widen union）
      minVersion: '0.0.0',
      parseEvent: () => null,
      buildSpawn: () => ({ cmd: ['mock'], env: {} }),
      defaultBinary: () => ['mock'],
      probe: async (binary: string) => ({ binary, version: '9.9.9', compatible: true }),
      listModels: async (binary: string) => ({ binary, models: [], cached: true }),
      captureSessions: async () => {},
    } satisfies RuntimeDriver
    expect(mockDriver.kind).toBe('opencode')
    expect(mockDriver.minVersion).toBe('0.0.0')
    // satisfies RuntimeDriver 已在编译期证明接口完备——运行时冒烟其能力方法可调。
    expect(typeof mockDriver.captureSessions).toBe('function')
  })
})
