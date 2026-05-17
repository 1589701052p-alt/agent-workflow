// RFC-030 T10 — locks the mcps.probe.* i18n keys exist in both bundles with
// non-empty values. The symmetry test already enforces that the *set* of
// keys is identical; this test additionally pins the structure (so removing
// e.g. status.unknown gets caught even if some other key is renamed in
// compensation).

import { describe, expect, test } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

const REQUIRED_PROBE_KEYS = [
  'btnRun',
  'btnRunning',
  'viewFull',
  'expandRow',
  'collapseRow',
  'expandNotProbed',
  'expandNoTools',
  'moreCount',
  'lastProbed',
  'neverProbed',
] as const

const REQUIRED_STATUS_KEYS = ['unknown', 'probing', 'ok', 'error'] as const
const REQUIRED_SECTION_KEYS = ['tools', 'resources', 'prompts', 'capabilities'] as const
const REQUIRED_ERROR_CODE_KEYS = [
  'codeConnectFailed',
  'codeHandshakeFailed',
  'codeAuthRequired',
  'codeTimeout',
  'codePartial',
  'codeInternalError',
  'codeMcpDisabled',
] as const

describe('RFC-030 mcps.probe.* i18n keys', () => {
  test('top-level probe keys exist + non-empty in both bundles', () => {
    for (const k of REQUIRED_PROBE_KEYS) {
      expect((zhCN.mcps.probe as Record<string, unknown>)[k]).toBeTruthy()
      expect((enUS.mcps.probe as Record<string, unknown>)[k]).toBeTruthy()
    }
  })

  test('status.{unknown,probing,ok,error} all set', () => {
    for (const k of REQUIRED_STATUS_KEYS) {
      expect(zhCN.mcps.probe.status[k]?.length).toBeGreaterThan(0)
      expect(enUS.mcps.probe.status[k]?.length).toBeGreaterThan(0)
    }
  })

  test('section.{tools,resources,prompts,capabilities} all set', () => {
    for (const k of REQUIRED_SECTION_KEYS) {
      expect(zhCN.mcps.probe.section[k]?.length).toBeGreaterThan(0)
      expect(enUS.mcps.probe.section[k]?.length).toBeGreaterThan(0)
    }
  })

  test('error.code* keys mirror McpProbeErrorCode enum', () => {
    for (const k of REQUIRED_ERROR_CODE_KEYS) {
      expect((zhCN.mcps.probe.error as Record<string, string>)[k]?.length).toBeGreaterThan(0)
      expect((enUS.mcps.probe.error as Record<string, string>)[k]?.length).toBeGreaterThan(0)
    }
  })

  test('colStatus / colLatency / colToolCount columns exist', () => {
    expect(zhCN.mcps.colStatus.length).toBeGreaterThan(0)
    expect(enUS.mcps.colStatus.length).toBeGreaterThan(0)
    expect(zhCN.mcps.colLatency.length).toBeGreaterThan(0)
    expect(enUS.mcps.colLatency.length).toBeGreaterThan(0)
    expect(zhCN.mcps.colToolCount.length).toBeGreaterThan(0)
    expect(enUS.mcps.colToolCount.length).toBeGreaterThan(0)
  })
})
