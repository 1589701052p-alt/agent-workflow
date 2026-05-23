// RFC-059 C5 — i18n cn/en alignment guard for per-question scope copy.
//
// Why this test exists:
//   The footer hint depends on i18next placeholders ({{n}} / {{d}} / {{q}} /
//   {{total}}) interpolating into the correct strings; a Chinese-only or
//   placeholder-mismatched key would render as the literal i18n path in
//   the user's UI without crashing — silent regression. This file greps
//   both `zh-CN.ts` and `en-US.ts` to confirm:
//     (a) every RFC-059 key is non-empty in both locales;
//     (b) the same placeholders appear in both translations.
//   If the question-scope feature ever expands its key set, raise the
//   `EXPECTED_KEYS` array; this test serves as the floor.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ZH_PATH = resolve(__dirname, '..', 'src', 'i18n', 'zh-CN.ts')
const EN_PATH = resolve(__dirname, '..', 'src', 'i18n', 'en-US.ts')

// RFC-059 key set — 5 questionScope + 3 submitHint = 8 keys total.
const EXPECTED_KEYS: ReadonlyArray<{
  path: string
  /** Placeholders that must appear in BOTH translations. */
  placeholders: ReadonlyArray<string>
}> = [
  { path: 'crossClarify.questionScope.label', placeholders: [] },
  { path: 'crossClarify.questionScope.designer', placeholders: [] },
  { path: 'crossClarify.questionScope.questioner', placeholders: [] },
  { path: 'crossClarify.questionScope.designerTooltip', placeholders: [] },
  { path: 'crossClarify.questionScope.questionerTooltip', placeholders: [] },
  { path: 'crossClarify.submitHint.allDesigner', placeholders: ['{{n}}'] },
  { path: 'crossClarify.submitHint.allQuestioner', placeholders: ['{{n}}'] },
  { path: 'crossClarify.submitHint.mixed', placeholders: ['{{d}}', '{{total}}'] },
]

function extractKey(src: string, leafName: string): string | undefined {
  // Match `  leafName: '...',` or `  leafName: "...",` allowing escapes.
  // The leaf names we care about don't appear elsewhere (questionScope /
  // submitHint sub-records are RFC-059's contribution), so a loose match
  // is safe enough.
  const re = new RegExp(
    `${leafName}\\s*:\\s*(?:'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)")`,
  )
  const m = re.exec(src)
  if (m === null) return undefined
  return m[1] ?? m[2]
}

describe('RFC-059 C5 — i18n cn/en alignment', () => {
  const zh = readFileSync(ZH_PATH, 'utf8')
  const en = readFileSync(EN_PATH, 'utf8')

  for (const { path, placeholders } of EXPECTED_KEYS) {
    test(`${path} — present in both locales + placeholder parity`, () => {
      const leaf = path.split('.').pop() ?? path
      const zhValue = extractKey(zh, leaf)
      const enValue = extractKey(en, leaf)
      expect(zhValue, `${path} missing in zh-CN.ts`).toBeDefined()
      expect(enValue, `${path} missing in en-US.ts`).toBeDefined()
      expect(zhValue!.length, `${path} empty in zh-CN.ts`).toBeGreaterThan(0)
      expect(enValue!.length, `${path} empty in en-US.ts`).toBeGreaterThan(0)
      for (const ph of placeholders) {
        expect(zhValue, `${path} missing ${ph} in zh-CN.ts`).toContain(ph)
        expect(enValue, `${path} missing ${ph} in en-US.ts`).toContain(ph)
      }
    })
  }
})
