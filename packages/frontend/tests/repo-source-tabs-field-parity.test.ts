// Locks in field-order parity between the launcher's "Local path" and
// "Remote URL" tabs. Before this fix the Remote URL tab had a third
// bottom Field labeled "Recently used URLs" with its own select, while
// the Local path tab folded the recents select inline at the top of the
// Repo Field. The asymmetry made the two tabs look like different
// features. Now both tabs follow the same pattern:
//   Field 1 (repo identifier): optional history <select> above the
//     <TextInput> for path / URL — both inside one Field.
//   Field 2 (branch / ref): single input/select.
//
// If anyone reintroduces the standalone "recentUrls" Field, this test
// catches it. Source-level assertion (cheap, no JSX render needed).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// RFC-066 PR-C: the path/url field markup moved into RepoSourceRow.tsx
// when the multi-repo container was carved out of RepoSourceTabs. The
// field-parity assertions follow the markup to the new file.
const file = path.resolve(here, '../src/components/launch/RepoSourceRow.tsx')
const src = readFileSync(file, 'utf8')

describe('RepoSourceTabs — Local path / Remote URL field parity', () => {
  test('Remote URL tab no longer renders a standalone "recentUrls" Field', () => {
    // The old structure used a Field labeled launch.repoSource.recentUrls
    // (with a recentUrlsHint) at the bottom of the URL section. Both keys
    // are now retired; assert no remaining label/hint references in this
    // component. The placeholder key (recentUrlsPlaceholder) is still in
    // use inside the inline select, so we deliberately exclude it.
    expect(/launch\.repoSource\.recentUrls(?!Placeholder)/.test(src)).toBe(false)
    expect(src.includes('recentUrlsHint')).toBe(false)
  })

  test('cached-URLs select is rendered inside the Git URL Field', () => {
    // The cached select and the URL TextInput must live inside the same
    // Field block (label = launch.repoSource.urlField). Confirm the
    // select appears before the URL TextInput, with no intervening
    // </Field> closing tag.
    const urlFieldStart = src.indexOf("label={t('launch.repoSource.urlField')}")
    expect(urlFieldStart, 'Git URL Field must exist').toBeGreaterThan(-1)
    const urlFieldEnd = src.indexOf('</Field>', urlFieldStart)
    expect(urlFieldEnd, 'Git URL Field must close').toBeGreaterThan(urlFieldStart)
    const block = src.slice(urlFieldStart, urlFieldEnd)
    // RFC-066 PR-C: the testid is now templated with an optional per-row
    // index suffix (`repo-source-recent-urls${idxSuffix}`); match both the
    // bare and the templated form.
    expect(/repo-source-recent-urls(?:\$\{idxSuffix\}|")/.test(block)).toBe(true)
    expect(block).toContain("placeholder={t('launch.repoSource.urlPlaceholder')}")
  })

  test('the only remaining recentUrls i18n key is the placeholder', () => {
    // Sanity: ensure we did not leave the now-unused label/hint keys
    // dangling in the component source.
    expect(/recentUrls(?!Placeholder)/.test(src)).toBe(false)
  })
})
