// Locks in the /tasks name-cell row-alignment fix: the Name <td> must stay a
// real table-cell, with the flex column on an inner wrapper.
//
// Regression history: commit 962e7c7 (RFC-037) put `display: flex` directly on
// `<td class="task-name-cell">`. A flex <td> stops being `display: table-cell`,
// so it drops out of row-height equalization — measured 58px tall inside a
// 61px row — and its bottom border painted ~3px above the neighbors',
// breaking every row separator into a stepped line at the Name/Workflow
// boundary ("表格错位"). `vertical-align: middle` also stopped applying.
//
// styles.css already warns about this twice (.skills__name-cell__inner,
// .data-table__actions): flex belongs on an inner wrapper, never the <td>.
//
// Source-text assertions per CLAUDE.md's test-with-every-change rule.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')
const CSS = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')

describe('routes/tasks.tsx — name cell stays a real table-cell', () => {
  test('the name <td> wraps its content in .task-name-cell__inner', () => {
    expect(SRC).toMatch(
      /<td className="task-name-cell">[\s\S]*?<div className="task-name-cell__inner">[\s\S]*?task-name-cell__name[\s\S]*?task-name-cell__id[\s\S]*?<\/div>\s*<\/td>/,
    )
  })

  test('no CSS rule turns the .task-name-cell <td> itself into a flex container', () => {
    // `.task-name-cell {` (the bare td selector, not __inner/__name/__id) must
    // not declare display:flex — that is the exact regression this file locks.
    expect(CSS).not.toMatch(/\.task-name-cell\s*\{[^}]*display:\s*flex/)
  })

  test('.task-name-cell__inner carries the flex column layout instead', () => {
    expect(CSS).toMatch(
      /\.task-name-cell__inner\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
    )
  })
})
