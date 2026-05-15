// P-5-03 stage 2 Phase A: smoke-test the new agents / skills / workflows /
// tasks / common bundles + the formatRelative helper.
//
// Goals here are narrow: catch missing keys (zh-CN / en-US drift) and
// regressions in tasks.tsx's relative-time formatter when callers pass a
// translated TFunction.

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'
import { formatRelative } from '@/routes/tasks'

describe('Phase A bundles', () => {
  test('zh-CN agents/skills/workflows/tasks core keys are populated', () => {
    setLanguage('zh-CN')
    expect(i18n.t('agents.title')).toBe('代理')
    expect(i18n.t('skills.title')).toBe('技能')
    expect(i18n.t('workflows.title')).toBe('工作流')
    expect(i18n.t('tasks.title')).toBe('任务')
    expect(i18n.t('common.delete')).toBe('删除')
  })

  test('en-US matches the same key tree', () => {
    setLanguage('en-US')
    expect(i18n.t('agents.newButton')).toBe('+ New agent')
    expect(i18n.t('workflows.importButton')).toBe('Import YAML')
    expect(i18n.t('tasks.cancelButton')).toBe('Cancel task')
    expect(i18n.t('skills.tabExternal')).toBe('External')
    setLanguage('zh-CN')
  })

  test('interpolated keys substitute the placeholder', () => {
    setLanguage('en-US')
    expect(i18n.t('tasks.jumpToFailed', { nodeId: 'coder' })).toBe('Jump to failed node (coder)')
    expect(i18n.t('tasks.worktreePreserved', { path: '/wt/abc' })).toContain('/wt/abc')
    setLanguage('zh-CN')
    expect(i18n.t('tasks.jumpToFailed', { nodeId: 'coder' })).toBe('跳到失败节点 (coder)')
  })
})

describe('formatRelative', () => {
  const t = i18n.t.bind(i18n)
  test('seconds bucket', () => {
    setLanguage('en-US')
    const ts = Date.now() - 5_000
    expect(formatRelative(ts, t)).toMatch(/^\d+s ago$/)
  })

  test('minutes bucket', () => {
    setLanguage('en-US')
    const ts = Date.now() - 5 * 60_000
    expect(formatRelative(ts, t)).toMatch(/^\d+m ago$/)
  })

  test('hours bucket', () => {
    setLanguage('en-US')
    const ts = Date.now() - 3 * 60 * 60_000
    expect(formatRelative(ts, t)).toMatch(/^\d+h ago$/)
  })

  test('older than a day falls back to toLocaleDateString', () => {
    setLanguage('en-US')
    const ts = Date.now() - 3 * 24 * 60 * 60_000
    // Just confirm it does NOT contain "ago"; the exact format depends on locale.
    expect(formatRelative(ts, t).includes('ago')).toBe(false)
  })

  test('zh-CN seconds bucket uses Chinese suffix', () => {
    setLanguage('zh-CN')
    const ts = Date.now() - 5_000
    expect(formatRelative(ts, t)).toMatch(/秒前$/)
  })
})
