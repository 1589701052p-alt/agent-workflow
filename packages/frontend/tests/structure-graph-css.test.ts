// RFC-083 PR-F regression: the blast-radius graph nodes had unreadable colors
// (referenced non-existent --diff-* vars → fell back to dark greens unreadable
// on the light theme) and no width/overflow handling (long qualifiedNames
// spilled outside the node box). Lock the fix at the source: the graph node CSS
// must (a) constrain width + wrap text, and (b) use real theme vars only.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

// the `.structure-graph .react-flow__node` rule block
const nodeRule = css.slice(
  css.indexOf('.structure-graph .react-flow__node {'),
  css.indexOf('.structure__tree {'),
)

describe('structure-graph node styling', () => {
  test('constrains width + wraps text so labels stay inside the box', () => {
    expect(nodeRule).toMatch(/max-width:/)
    expect(nodeRule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(nodeRule).toMatch(/white-space:\s*normal/)
  })

  test('uses real theme vars, not the non-existent --diff-* fallbacks', () => {
    expect(nodeRule).not.toMatch(/--diff-add-bg|--diff-add-fg|--surface-2|--text-muted/)
    expect(nodeRule).toMatch(/var\(--accent\)/)
    expect(nodeRule).toMatch(/var\(--panel\)/)
  })
})
