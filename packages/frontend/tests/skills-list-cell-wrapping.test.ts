// Regression: on /skills, long skill names used to wrap mid-name and made
// the table hard to scan (worse than on /agents because the name cell also
// hosts a source-pill, so a wrapped name pushed the pill to a third line).
// Lock the nowrap modifier on the name <td> textually.
//
// Sibling test: agents-list-cell-wrapping.test.ts (same .data-table__nowrap
// class, defined in styles.css).
//
// 2026-05-20 follow-up: even with white-space:nowrap, overlong names still
// bled into the next column because .data-table__nowrap shipped without
// overflow:hidden / text-overflow:ellipsis. In /skills's table-layout:fixed
// + colgroup setup the cell width is locked, so nothing clipped the bleed.
// Fix: (1) add overflow+ellipsis to .data-table__nowrap globally — no-op in
// auto-layout tables, kicks in here. (2) wrap the name cell content in a
// flex inner div so the Link can shrink with ellipsis while the source-pill
// stays visible (flex on the <td> itself would detach it from the table row
// — see the same caveat on .data-table__actions). Both behaviors are locked
// below.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROUTE_SRC = path.join(HERE, '../src/routes/skills.tsx')
const STYLES_SRC = path.join(HERE, '../src/styles.css')

describe('/skills list — name cell does not wrap, description cell truncates to one line', () => {
  test('name <td> carries data-table__nowrap', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Make sure the modifier sits on the <td> (so the cell itself controls
    // wrapping for both the name link AND the source-pill sibling), not on
    // an inner element. The inner <div> below sits between the <td> and the
    // Link so it can host the flex layout that lets the link truncate while
    // the source-pill stays visible.
    expect(src).toMatch(
      /<td className="data-table__nowrap">\s*<div className="skills__name-cell__inner">\s*<Link/,
    )
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
    // content). Fixed layout + a colgroup hint on the path column (20% as
    // of 2026-05-20, widened from 30% after the name column was bumped to
    // 260px to fit longer skill names) keeps both cells readable.
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/style=\{\{\s*tableLayout:\s*['"]fixed['"]\s*\}\}/)
    expect(src).toMatch(/<colgroup>/)
    expect(src).toMatch(/style=\{\{\s*width:\s*['"]20%['"]\s*\}\}/)
  })

  test('name link has title={s.name} so the full name is reachable on hover when ellipsised', async () => {
    // Once the cell clips with ellipsis, the only way to see the full skill
    // name without navigating is via the native browser tooltip. Lock the
    // title attribute so a future refactor that drops it brings back the
    // "what does the rest of the name say?" UX gap.
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/className="data-table__link skills__name-link"\s+title=\{s\.name\}/)
  })

  test('.data-table__nowrap clips overflow with ellipsis (CSS-level regression lock)', async () => {
    // Root cause of the original "skill name bleeds into next column" bug:
    // .data-table__nowrap only set white-space:nowrap, no overflow handling.
    // In a fixed-layout table the cell can't grow and the text escaped the
    // cell box visually. Lock the overflow+ellipsis pair here so the fix
    // can't be silently reverted in a styles.css cleanup.
    const css = await fs.readFile(STYLES_SRC, 'utf8')
    const match = css.match(/\.data-table__nowrap\s*\{([^}]+)\}/)
    expect(match, '.data-table__nowrap rule must exist').not.toBeNull()
    const body = match![1]
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/overflow:\s*hidden/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
  })

  test('flex lives on .skills__name-cell__inner (a <div>), not on the <td> itself', async () => {
    // Locking the table-cell caveat: putting display:flex on a <td> detaches
    // it from the table row, breaking row-height equalization and vertical
    // alignment of sibling cells (same trap called out next to
    // .data-table__actions). The flex container MUST be an inner <div>.
    const css = await fs.readFile(STYLES_SRC, 'utf8')
    const inner = css.match(/\.skills__name-cell__inner\s*\{([^}]+)\}/)
    expect(inner, '.skills__name-cell__inner rule must exist').not.toBeNull()
    expect(inner![1]).toMatch(/display:\s*flex/)
    expect(inner![1]).toMatch(/min-width:\s*0/)

    // And there must be no `.skills__name-cell { display: flex }` rule that
    // would apply flex directly to the <td>. A bare `.skills__name-cell` is
    // OK only if it doesn't set display:flex; the explicit __inner suffix is
    // what tells future readers where flex belongs.
    const cellOnly = css.match(/\.skills__name-cell\s*\{([^}]+)\}/)
    if (cellOnly) {
      expect(cellOnly[1]).not.toMatch(/display:\s*flex/)
    }
  })

  test('.skills__name-link truncates with min-width:0 so flex can shrink it', async () => {
    // Without min-width:0 the flex item refuses to shrink below its
    // intrinsic content width, pushing the source-pill out of the cell.
    // The ellipsis trio (overflow/text-overflow/white-space) on the link
    // itself is what actually clips the visible text.
    const css = await fs.readFile(STYLES_SRC, 'utf8')
    const link = css.match(/\.skills__name-link\s*\{([^}]+)\}/)
    expect(link, '.skills__name-link rule must exist').not.toBeNull()
    expect(link![1]).toMatch(/min-width:\s*0/)
    expect(link![1]).toMatch(/overflow:\s*hidden/)
    expect(link![1]).toMatch(/text-overflow:\s*ellipsis/)
    expect(link![1]).toMatch(/white-space:\s*nowrap/)
  })
})
