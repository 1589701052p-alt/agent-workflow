// 2026-05-24 → 2026-07-07 regression lock 演进史：
//
// RFC-060 PR-E 删除 agent-multi 后 fanoutSourceSync 全模块退化为 no-op 存根；其中
// `isValidSourcePortConnection` 仍被 WorkflowCanvas.isValidConnection 当 pass-guard 调用
// （`if (!fn(...)) return false`）。PR-E 初版存根误返回 `false`，一度令画布上所有
// drag-to-connect（wrapper 输出、agent 间连线）全部静默失效。本文件当时锁定「no-op 必须
// 返回 true」。
//
// 标志位控流审计 W0（design/flag-audit-2026-07-07.md §3 死代码型）按存根文件头预告的
// "A follow-up cleanup PR can inline-delete the call sites" 将模块与全部 7 个调用位内联
// 删除——守卫不复存在，「守卫误拒一切连接」的回归形态从此结构性不可能。本文件相应改为
// **源码层删除锁**：fanoutSourceSync 模块不得复活、WorkflowCanvas 不得再引用其任何导出。
// 若未来真要恢复 sourcePort 类机制，请以新命名 + 新测试落地，并有意识地更新本锁。

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CANVAS_DIR = resolve(__dirname, '../src/components/canvas')

describe('fanoutSourceSync 内联删除锁（flag-audit W0）', () => {
  test('no-op 存根模块已删除，不得复活', () => {
    expect(existsSync(resolve(CANVAS_DIR, 'fanoutSourceSync.ts'))).toBe(false)
    expect(existsSync(resolve(CANVAS_DIR, 'fanoutSourceSync.tsx'))).toBe(false)
  })

  test('WorkflowCanvas 不再引用任何 fanoutSourceSync 导出（守卫误拒回归不可能）', () => {
    const src = readFileSync(resolve(CANVAS_DIR, 'WorkflowCanvas.tsx'), 'utf8')
    for (const ident of [
      'fanoutSourceSync',
      'isValidSourcePortConnection',
      'applySourcePortConnection',
      'buildSourcePortDisplayEdges',
      'clearSourcePortOnNodeRemoved',
      'clearSourcePortsForSyntheticIds',
      'parseSyntheticSourcePortEdgeId',
      'MULTI_SOURCE_PORT_HANDLE_ID',
    ]) {
      expect(src).not.toContain(ident)
    }
  })
})
