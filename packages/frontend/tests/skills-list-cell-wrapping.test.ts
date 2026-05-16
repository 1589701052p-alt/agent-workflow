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

describe('/skills list — name cell does not wrap', () => {
  test('name <td> carries data-table__nowrap', async () => {
    const src = await fs.readFile(ROUTE_SRC, 'utf8')
    // Make sure the modifier sits on the <td> (so the cell itself controls
    // wrapping for both the name link AND the source-pill sibling), not on
    // an inner element.
    expect(src).toMatch(/<td className="data-table__nowrap">\s*<Link to="\/skills\/\$name"/)
  })
})
