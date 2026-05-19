// Locks in the single-line truncation for the Error column on /tasks.
// Long `errorSummary` strings (multi-line stack traces, JSON blobs) used to
// blow up the row height. The cell now wraps its text in `.data-table__clip`
// (capped inner inline-block) so the <td> still sizes naturally and other
// columns keep their widths — unlike `.data-table__truncate`, which absorbs
// all leftover space and squeezed the Repo column down to ~50px, causing
// long repo paths to wrap and rows to balloon to 252px tall.
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — Error column single-line truncation', () => {
  test('error cell wraps text in a `.data-table__clip` span with hover title', () => {
    // The clip span (not the <td>) must carry both the class and the title so
    // the column width stays bounded by the inner element, not by `width:100%`.
    expect(SRC).toMatch(/className="data-table__clip"\s+title=\{row\.errorSummary \?\? undefined\}/)
    expect(SRC).toMatch(/data-table__clip[\s\S]*?\{row\.errorSummary \?\? t\('common\.emDash'\)\}/)
  })

  test('error <td> no longer uses `.data-table__truncate` (which hijacked row width)', () => {
    // The Error column previously regressed to 252px tall rows because
    // `.data-table__truncate` set `width:100%` and squeezed the Repo column
    // to ~50px, forcing long repo paths to wrap. Keep this regression locked.
    expect(SRC).not.toMatch(
      /data-table__muted data-table__truncate"\s*\n?\s*title=\{row\.errorSummary/,
    )
  })

  test('.data-table__clip is defined as a bounded inline-block ellipsis rule', () => {
    expect(CSS).toMatch(
      /\.data-table__clip\s*\{[^}]*display:\s*inline-block[^}]*max-width:\s*\d+px[^}]*text-overflow:\s*ellipsis/,
    )
  })
})
