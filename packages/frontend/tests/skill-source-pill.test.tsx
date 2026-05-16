// RFC-017 — source pill on /skills list rows. Source-layer assertions because
// the actual `/skills` route depends on TanStack Router context and is hard
// to host in JSDOM standalone. The pill behaviour we want to lock:
//   - emitted only when `s.sourceId !== undefined`
//   - links to `#source-<id>` anchor on the same page
//   - i18n key `skills.sourceFromPill` carries the label / id token
// Red here = pill rendering or anchoring was removed.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE_PATH = resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.tsx')

describe('SourcePill (source-layer)', () => {
  test('skills.tsx renders pill only when sourceId is set', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toMatch(/s\.sourceId\s*!==\s*undefined/)
  })

  test('skills.tsx anchors the pill to #source-<id>', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain('`#source-${s.sourceId}`')
  })

  test('skills.tsx uses the sourceFromPill i18n key with the resolved label', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain('sourceFromPill')
    expect(src).toContain('labelById.get(s.sourceId)')
  })
})
