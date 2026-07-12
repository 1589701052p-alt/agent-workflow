// Regression: on /agents, long descriptions used to wrap and balloon the
// row height, and long names could break across lines too — both made it
// hard to scan the table. Lock the cell classes textually so any future
// refactor that drops them turns red.
//
// The CSS that backs these classes lives in styles.css:
//   .data-table__nowrap   → name column, no line break on the link
//   .data-table__truncate → description column, single-line + ellipsis
// We pin the source rather than render the table because the route depends
// on a query client + router context that's not worth standing up just to
// read className strings.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROUTE_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/routes/agents.tsx',
)
const CELL_SRC = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../src/components/ResourceNameCell.tsx',
)
const STYLES_SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/styles.css')

describe('/agents list — name cell does not wrap, description cell truncates to one line', () => {
  test('name <td> carries data-table__nowrap (via shared ResourceNameCell)', async () => {
    // RFC-151 PR-3 moved the name cell into <ResourceNameCell>. Same intent:
    // the cell itself (not just the link) must get the nowrap modifier, and
    // /agents must actually route its name column through the shared cell.
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/<ResourceNameCell\s+to="\/agents\/\$name"/)
    const cell = await fs.readFile(CELL_SRC, 'utf8')
    expect(cell).toMatch(/<td className="data-table__nowrap">\s*<Link/)
    expect(cell).toContain('className="data-table__link"')
  })

  test('description <td> carries data-table__truncate (and keeps the muted color)', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    expect(src).toMatch(/className="data-table__muted data-table__truncate"/)
  })

  test('description <td> has a title attribute so the full text is reachable on hover', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Without this, truncation would silently hide content.
    expect(src).toMatch(/title=\{a\.description \|\| undefined\}/)
  })

  test('styles.css defines the two helper classes with the right properties', async () => {
    const css = await fs.readFile(STYLES_SRC, 'utf8')

    const nowrap = css.match(/\.data-table__nowrap\s*\{([^}]*)\}/)
    expect(nowrap).not.toBeNull()
    expect(nowrap![1]).toMatch(/white-space:\s*nowrap/)

    const truncate = css.match(/\.data-table__truncate\s*\{([^}]*)\}/)
    expect(truncate).not.toBeNull()
    const body = truncate![1]
    // All four properties are load-bearing for "single line + ellipsis" inside
    // an auto-layout table cell — dropping any of them breaks the effect.
    expect(body).toMatch(/max-width:\s*0/)
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })
})
