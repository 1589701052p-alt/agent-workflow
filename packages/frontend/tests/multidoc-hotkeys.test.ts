// RFC-090 — multi-document review keyboard navigation.
//
// Pure-function oracles for the ↑/↓ file switch + Q/W accept-or-reject hotkeys,
// plus a source-level lock on how MultiDocReviewView wires them. The "don't fire
// while filling in a comment" contract is a set of guards that a DOM render can
// only partially exercise (the comment popover needs a real text selection on
// the Prose body), so the paneCapturing / decision-dialog guards are anchored in
// source here; the focused-form-control + nav + Q/W paths are exercised live in
// review-multidoc-view.test.tsx.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { multiDocHotkeyAction, nextDocIndex } from '../src/lib/review/multiDocHotkeys'

const NO_MODS = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }

describe('multiDocHotkeyAction', () => {
  test('maps the four shortcut keys', () => {
    expect(multiDocHotkeyAction({ key: 'ArrowUp', ...NO_MODS })).toBe('prev')
    expect(multiDocHotkeyAction({ key: 'ArrowDown', ...NO_MODS })).toBe('next')
    expect(multiDocHotkeyAction({ key: 'q', ...NO_MODS })).toBe('accept')
    expect(multiDocHotkeyAction({ key: 'w', ...NO_MODS })).toBe('not_accept')
  })

  test('accepts upper-case Q/W (caps lock / shifted layouts)', () => {
    expect(multiDocHotkeyAction({ key: 'Q', ...NO_MODS })).toBe('accept')
    expect(multiDocHotkeyAction({ key: 'W', ...NO_MODS })).toBe('not_accept')
  })

  test('ignores non-shortcut keys (incl. the pane J/K + single-doc A/R/I)', () => {
    for (const key of [
      'a',
      'r',
      'i',
      'j',
      'k',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
      ' ',
      'Escape',
    ]) {
      expect(multiDocHotkeyAction({ key, ...NO_MODS })).toBeNull()
    }
  })

  test('bails on any modifier so OS/browser chords + Shift+Arrow selection pass through', () => {
    expect(multiDocHotkeyAction({ key: 'w', ...NO_MODS, metaKey: true })).toBeNull() // Cmd+W close tab
    expect(multiDocHotkeyAction({ key: 'ArrowDown', ...NO_MODS, ctrlKey: true })).toBeNull()
    expect(multiDocHotkeyAction({ key: 'ArrowUp', ...NO_MODS, altKey: true })).toBeNull() // history nav
    expect(multiDocHotkeyAction({ key: 'ArrowDown', ...NO_MODS, shiftKey: true })).toBeNull() // select
    expect(multiDocHotkeyAction({ key: 'q', ...NO_MODS, ctrlKey: true })).toBeNull()
  })
})

describe('nextDocIndex', () => {
  test('clamps at the ends (no wraparound)', () => {
    expect(nextDocIndex(0, 3, 'prev')).toBe(0) // already first
    expect(nextDocIndex(2, 3, 'next')).toBe(2) // already last
  })

  test('steps one in range', () => {
    expect(nextDocIndex(0, 3, 'next')).toBe(1)
    expect(nextDocIndex(1, 3, 'next')).toBe(2)
    expect(nextDocIndex(2, 3, 'prev')).toBe(1)
    expect(nextDocIndex(1, 3, 'prev')).toBe(0)
  })

  test('empty list returns the index unchanged', () => {
    expect(nextDocIndex(0, 0, 'next')).toBe(0)
    expect(nextDocIndex(-1, 0, 'prev')).toBe(-1)
  })

  test('unknown current (-1) resolves to the first item in either direction', () => {
    expect(nextDocIndex(-1, 3, 'next')).toBe(0)
    expect(nextDocIndex(-1, 3, 'prev')).toBe(0)
  })
})

describe('MultiDocReviewView source — RFC-090 wiring', () => {
  const src = readFileSync(
    resolve(__dirname, '..', 'src', 'components', 'review', 'MultiDocReviewView.tsx'),
    'utf8',
  )

  test('imports the pure hotkey oracles', () => {
    expect(src).toMatch(
      /import\s*\{\s*multiDocHotkeyAction,\s*nextDocIndex\s*\}\s*from\s*'@\/lib\/review\/multiDocHotkeys'/,
    )
  })

  test('feeds ReviewDocPane capture state into a paneCapturing guard', () => {
    // The pane reports popover-open / inline-editing as "capturing"; the page
    // must consume it so Q/W/↑/↓ never fire while a comment is being typed.
    expect(src).toMatch(/onShortcutCaptureChange=\{setPaneCapturing\}/)
    expect(src).toMatch(/if\s*\(\s*paneCapturing\s*\)\s*return/)
  })

  test('the keydown handler also bails on an open decision dialog + focused form controls', () => {
    expect(src).toMatch(/if\s*\(\s*dialog\s*!==\s*null\s*\)\s*return/)
    expect(src).toMatch(
      /\['INPUT',\s*'TEXTAREA',\s*'SELECT'\]\.includes\(\s*document\.activeElement\.tagName\s*\)/,
    )
  })

  test('arrow navigation prevents the default page scroll', () => {
    // The prev/next branch calls preventDefault before moving the selection.
    expect(src).toMatch(/action === 'prev' \|\| action === 'next'[\s\S]*?e\.preventDefault\(\)/)
  })
})
