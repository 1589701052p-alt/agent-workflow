// RFC-080 PR-B — OUTPUT_KIND_UI catalog + drift guard (layer 2 + the
// dataBearing↔carriesData agreement). The frontend derives the KindSelect base
// dropdown, i18n labels, download affordance, and canvas signal styling from
// this single table; these tests lock that it stays in sync with the registry.

import { describe, expect, test } from 'bun:test'
import {
  OUTPUT_KIND_UI,
  listSelectableKinds,
  outputKindUiById,
  getHandlerForParsedKind,
  parseKind,
  REGISTERED_BASE_KINDS,
  type OutputKindUiDescriptor,
} from '@agent-workflow/shared'

describe('RFC-080 OUTPUT_KIND_UI catalog', () => {
  test('listSelectableKinds covers string/markdown/signal + the path shape', () => {
    expect(
      listSelectableKinds()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['markdown', 'path', 'signal', 'string'])
  })

  test('every base descriptor id is a registered base kind; path is the only param shape', () => {
    for (const d of OUTPUT_KIND_UI) {
      if (d.editorShape === 'base') {
        expect(REGISTERED_BASE_KINDS.has(d.id)).toBe(true)
      } else {
        expect(d.editorShape).toBe('param-path')
        expect(d.id).toBe('path')
      }
    }
  })

  test('outputKindUiById round-trips', () => {
    expect(outputKindUiById('signal')?.dataBearing).toBe(false)
    expect(outputKindUiById('nope')).toBeUndefined()
  })

  test('dataBearing agrees with handler.carriesData (drift guard)', () => {
    for (const d of OUTPUT_KIND_UI) {
      const kindStr = d.id === 'path' ? 'path<*>' : d.id
      const parsed = parseKind(kindStr)
      expect(d.dataBearing).toBe(getHandlerForParsedKind(parsed).carriesData(parsed))
    }
  })

  test('only the path entry is downloadable', () => {
    expect(OUTPUT_KIND_UI.filter((d) => d.downloadable).map((d) => d.id)).toEqual(['path'])
  })

  test('drift guard layer 2: a descriptor missing a dimension fails to typecheck', () => {
    // If any OutputKindUiDescriptor field is made optional (regressing the
    // satisfies-table drift guard), this becomes valid → @ts-expect-error unused
    // → `bun run typecheck` errors.
    // @ts-expect-error — omitting downloadable + dataBearing must be a type error.
    const bad: OutputKindUiDescriptor = { id: 'x', editorShape: 'base', labelKey: 'k' }
    expect(bad.id).toBe('x')
  })
})
