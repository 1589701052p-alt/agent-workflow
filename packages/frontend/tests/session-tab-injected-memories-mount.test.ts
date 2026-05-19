// RFC-046 — source-level guard that SessionTab actually mounts the
// <InjectedMemoriesCard>. A future refactor that removes the import (or
// renames the component) trips this red so the card never silently
// disappears from the Session tab.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const SESSION_TAB = readFileSync(
  join(REPO_ROOT, 'packages/frontend/src/components/node-session/SessionTab.tsx'),
  'utf8',
)

describe('RFC-046 SessionTab source-wiring', () => {
  test('mounts <InjectedMemoriesCard>', () => {
    expect(SESSION_TAB).toContain('<InjectedMemoriesCard')
    expect(SESSION_TAB).toContain('./InjectedMemoriesCard')
  })

  test('card sits before <RuntimeInventorySection> (DOM order: card → inventory → conversation)', () => {
    const cardIdx = SESSION_TAB.indexOf('<InjectedMemoriesCard')
    const inventoryIdx = SESSION_TAB.indexOf('<RuntimeInventorySection')
    expect(cardIdx).toBeGreaterThan(-1)
    expect(inventoryIdx).toBeGreaterThan(-1)
    expect(cardIdx).toBeLessThan(inventoryIdx)
  })
})
