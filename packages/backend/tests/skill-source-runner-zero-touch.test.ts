// Locks RFC-017 §5.1 — runner / runtime stay agnostic of skill_sources.
// Source-derived rows arrive at runtime as plain external skills (symlink
// staging), so neither runner.ts nor runtime.ts may grow code that pivots on
// `sourceId` / `skill_sources`. Red here = someone leaked the source-folder
// concept into the per-run staging path and broke the "zero-touch" guarantee.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FORBIDDEN = ['sourceId', 'skillSources', 'skill_sources']
const FILES = [
  resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
  resolve(import.meta.dir, '..', 'src', 'services', 'runtime.ts'),
]

describe('skill-source runner zero-touch', () => {
  for (const file of FILES) {
    test(`${file.split('/').slice(-2).join('/')} must not mention skill_sources`, () => {
      if (!existsSync(file)) return // runtime.ts is optional in the current tree
      const src = readFileSync(file, 'utf-8')
      for (const needle of FORBIDDEN) {
        expect(src.includes(needle)).toBe(false)
      }
    })
  }
})
