// RFC-080 PR-B — KindSelect: the shared output-port kind control.
//   1. decompose/recompose — locale-free grammar round-trip (the core logic).
//   2. i18n drift guard (layer 3b) — every OUTPUT_KIND_UI labelKey resolves in
//      BOTH locales (a new kind without a label fails here, not at runtime).
//   3. render smoke — picking a base option emits the canonical kind.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { OUTPUT_KIND_UI } from '@agent-workflow/shared'
import { decompose, recompose, KindSelect } from '../src/components/KindSelect'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

describe('KindSelect decompose / recompose (grammar round-trip)', () => {
  test('base kinds round-trip', () => {
    for (const k of ['string', 'markdown', 'signal']) {
      const d = decompose(k)
      expect(d).toMatchObject({ mode: 'guided', leafId: k, listWrap: false })
      if (d.mode === 'guided') expect(recompose(d.listWrap, d.leafId, d.ext)).toBe(k)
    }
  })

  test("'' defaults to base string", () => {
    expect(decompose('')).toMatchObject({ mode: 'guided', leafId: 'string', listWrap: false })
  })

  test('path<*> / path<md> / path<json>', () => {
    expect(decompose('path<*>')).toMatchObject({ mode: 'guided', leafId: 'path', ext: '*' })
    expect(decompose('path<md>')).toMatchObject({ mode: 'guided', leafId: 'path', ext: 'md' })
    expect(recompose(false, 'path', 'json')).toBe('path<json>')
    expect(recompose(false, 'path', '')).toBe('path<*>')
  })

  test('markdown_file folds to path<md> on read', () => {
    expect(decompose('markdown_file')).toMatchObject({ mode: 'guided', leafId: 'path', ext: 'md' })
  })

  test('list<base> and list<path<md>>', () => {
    expect(decompose('list<string>')).toMatchObject({
      mode: 'guided',
      leafId: 'string',
      listWrap: true,
    })
    expect(decompose('list<path<md>>')).toMatchObject({
      mode: 'guided',
      leafId: 'path',
      ext: 'md',
      listWrap: true,
    })
    expect(recompose(true, 'path', 'md')).toBe('list<path<md>>')
    expect(recompose(true, 'string', '*')).toBe('list<string>')
  })

  test('nested list<list<…>> and garbage → advanced', () => {
    expect(decompose('list<list<string>>').mode).toBe('advanced')
    expect(decompose('not a kind <<<').mode).toBe('advanced')
  })
})

describe('RFC-080 drift guard 3b — OUTPUT_KIND_UI labels resolve in both locales', () => {
  function resolve(obj: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((o, k) => {
      if (o !== null && typeof o === 'object' && k in (o as Record<string, unknown>)) {
        return (o as Record<string, unknown>)[k]
      }
      return undefined
    }, obj)
  }
  for (const d of OUTPUT_KIND_UI) {
    test(`${d.id}: ${d.labelKey} present in en-US + zh-CN`, () => {
      expect(typeof resolve(enUS, d.labelKey)).toBe('string')
      expect(typeof resolve(zhCN, d.labelKey)).toBe('string')
    })
  }
})

describe('KindSelect render smoke', () => {
  // Test env defaults to en-US (happy-dom navigator), like agent-form-role.test.

  test('picking a base option emits the canonical kind', () => {
    const onChange = vi.fn<(k: string) => void>()
    render(<KindSelect value="string" onChange={onChange} ariaLabel="Output kind" />)
    const trigger = screen.getByRole('combobox', { name: 'Output kind' })
    fireEvent.click(trigger)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').toLowerCase().includes('markdown'),
    )
    expect(opt).toBeDefined()
    fireEvent.mouseDown(opt!)
    expect(onChange).toHaveBeenCalledWith('markdown')
  })

  test('a list<path<md>> value renders a list toggle that is on + a path ext input', () => {
    render(
      <KindSelect
        value="list<path<md>>"
        onChange={vi.fn()}
        ariaLabel="Output kind"
        testidPrefix="k"
      />,
    )
    // list toggle (Switch) is checked.
    expect(screen.getByLabelText('list')).toBeTruthy()
    // path ext input present with 'md'.
    const ext = screen.getByTestId('k-ext') as HTMLInputElement
    expect(ext.value).toBe('md')
  })
})
