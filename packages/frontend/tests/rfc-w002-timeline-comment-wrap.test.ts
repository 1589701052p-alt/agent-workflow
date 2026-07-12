// RFC-W002 regression - the task「评论区」interaction-timeline review comment
// body must preserve the reviewer's original line breaks. Before this lock
// `.task-timeline__review-comment-text` had no `white-space` rule, so a
// multi-line comment collapsed onto a single line ("全都一行输出了") - unlike
// the live review bubble `.comment-bubble__body` (white-space: pre-wrap). The
// vitest config runs with `css: false`, so jsdom cannot compute this rule at
// render time; lock it textually in styles.css instead (same fallback pattern
// as tasks-list-id-status-nowrap.test.ts). Any future cleanup that drops the
// rule turns this red.

import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const STYLES_CSS = path.resolve(here, '../src/styles.css')

describe('RFC-W002 task timeline review comment preserves line breaks', () => {
  test('.task-timeline__review-comment-text declares white-space: pre-wrap', async () => {
    const css = await fs.readFile(STYLES_CSS, 'utf8')
    const block = css.match(/\.task-timeline__review-comment-text\s*\{[^}]*\}/)
    expect(block, '.task-timeline__review-comment-text rule must exist').not.toBeNull()
    expect(block![0]).toMatch(/white-space:\s*pre-wrap/)
    expect(block![0]).toMatch(/word-break:\s*break-word/)
  })
})
