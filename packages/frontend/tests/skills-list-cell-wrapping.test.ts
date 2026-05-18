// Regression: on /skills, long skill names used to wrap mid-name and made
// the table hard to scan (worse than on /agents because the name cell also
// hosts a source-pill, so a wrapped name pushed the pill to a third line).
// Lock the nowrap modifier on the name <td> textually.
//
// Sibling test: agents-list-cell-wrapping.test.ts (same .data-table__nowrap
// class, defined in styles.css).

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROUTE_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/routes/skills.tsx',
)

describe('/skills list — name cell does not wrap, description cell truncates to one line', () => {
  test('name <td> carries data-table__nowrap', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Make sure the modifier sits on the <td> (so the cell itself controls
    // wrapping for both the name link AND the source-pill sibling), not on
    // an inner element.
    expect(src).toMatch(/<td className="data-table__nowrap">\s*<Link to="\/skills\/\$name"/)
  })

  test('description <td> carries data-table__truncate (matches /agents and /mcps)', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Without truncate, multi-line skill descriptions ballooned row heights
    // and broke alignment with the sibling /agents and /mcps tables.
    expect(src).toMatch(/className="data-table__muted data-table__truncate"/)
  })

  test('description <td> has a title attribute so the full text is reachable on hover', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/title=\{s\.description \|\| undefined\}/)
  })

  test('path <td> also truncates so long file paths do not blow up row height', async () => {
    // Before this lock, the path column used <code> with overflow-wrap:
    // anywhere — long /Users/... paths wrapped char-by-char inside a 53px
    // column and pushed rows to 170-434px. Both description AND path must
    // truncate to keep row heights at ~47px (matches /agents and /mcps).
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/title=\{s\.managedPath \?\? s\.externalPath \?\? undefined\}/)
  })

  test('table uses fixed layout + colgroup so the two truncate columns split width predictably', async () => {
    // table-layout: auto gives the description column ~1015px and squeezes
    // the path column to ~53px (because content-based sizing favors longer
    // content). Fixed layout + a 30% colgroup hint on the path column keeps
    // both cells readable (~580px / ~430px on a 1440px viewport).
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/style=\{\{\s*tableLayout:\s*['"]fixed['"]\s*\}\}/)
    expect(src).toMatch(/<colgroup>/)
    expect(src).toMatch(/style=\{\{\s*width:\s*['"]30%['"]\s*\}\}/)
  })
})
