// RFC-037 T10 — locks the i18n keys added for the task name feature. The
// global `i18n-keys-symmetry.test.ts` already enforces zh ⇄ en union
// equality; this file is the explicit list of which keys must exist.

import { describe, expect, test } from 'vitest'
import { enUS as en } from '@/i18n/en-US'
import { zhCN as zh } from '@/i18n/zh-CN'

const KEYS_TO_CHECK: ReadonlyArray<[string, (r: unknown) => string | undefined]> = [
  ['launch.fieldTaskName', (r) => deep(r, 'launch.fieldTaskName')],
  ['launch.fieldTaskNameHint', (r) => deep(r, 'launch.fieldTaskNameHint')],
  ['launch.errorTaskNameRequired', (r) => deep(r, 'launch.errorTaskNameRequired')],
  ['tasks.colName', (r) => deep(r, 'tasks.colName')],
  ['tasks.detailTitleIdLabel', (r) => deep(r, 'tasks.detailTitleIdLabel')],
  ['reviews.taskNameLabel', (r) => deep(r, 'reviews.taskNameLabel')],
  ['clarify.taskNameLabel', (r) => deep(r, 'clarify.taskNameLabel')],
]

function deep(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : undefined
}

describe('RFC-037 — i18n keys are present and non-empty in both locales', () => {
  for (const [key, get] of KEYS_TO_CHECK) {
    test(`en-US: ${key} is non-empty`, () => {
      const v = get(en)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
    test(`zh-CN: ${key} is non-empty`, () => {
      const v = get(zh)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
  }
})
