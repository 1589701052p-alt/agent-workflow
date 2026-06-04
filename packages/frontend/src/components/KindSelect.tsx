// RFC-080 PR-B — KindSelect: the single shared control for editing an
// output-port kind. Reused by the agent form (OutputsEditor) and the canvas
// wrapper-fanout inspector (NodeInspector), replacing the bespoke 3-option
// <select> and the raw <TextInput>.
//
// The base dropdown enumerates OUTPUT_KIND_UI (shared catalog) — adding a new
// base kind there makes it appear here automatically. Guided mode covers the
// common grammar (base / path<ext> / list<base> / list<path<ext>>); nested or
// hand-edited kinds fall to an advanced raw-text field that validates live via
// the shared grammar and never silently rewrites the user's input.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  tryParseKind,
  parseKind,
  stringifyKind,
  isRegisteredKindString,
  listSelectableKinds,
  listSelectablePathExts,
  isSelectablePathExt,
  type ParsedKind,
} from '@agent-workflow/shared'
import { Select } from './Select'
import { Switch, TextInput } from './Form'

interface KindSelectProps {
  /** Canonical kind string; '' / 'string' are treated as base string. */
  value: string
  /** Always called with a canonical `stringifyKind(...)` form. */
  onChange: (kind: string) => void
  ariaLabel?: string
  disabled?: boolean
  testidPrefix?: string
}

type Guided = { mode: 'guided'; listWrap: boolean; leafId: string; ext: string }
type Decomposed = Guided | { mode: 'advanced' }

const SELECTABLE = listSelectableKinds()
const SELECTABLE_IDS = new Set(SELECTABLE.map((d) => d.id))
const PATH_EXTS = listSelectablePathExts()

/** Break a canonical kind string into the guided controls, or 'advanced'. */
export function decompose(value: string): Decomposed {
  const parsed = tryParseKind(value === '' ? 'string' : value)
  if (parsed === null) return { mode: 'advanced' }
  let listWrap = false
  let leaf: ParsedKind = parsed
  if (parsed.kind === 'list') {
    listWrap = true
    leaf = parsed.item
  }
  if (leaf.kind === 'base') {
    // Only the selectable base kinds (string/markdown/signal) are guided.
    if (!SELECTABLE_IDS.has(leaf.name)) return { mode: 'advanced' }
    return { mode: 'guided', listWrap, leafId: leaf.name, ext: '*' }
  }
  if (leaf.kind === 'path') {
    // Only the built-in PATH_EXT_UI extensions are guided; an ad-hoc ext
    // (e.g. path<xml>) round-trips through the advanced raw-text field until
    // it's promoted into the catalog. Mirrors the unknown-base-kind fallback.
    if (!isSelectablePathExt(leaf.ext)) return { mode: 'advanced' }
    return { mode: 'guided', listWrap, leafId: 'path', ext: leaf.ext }
  }
  // Nested list<list<…>> or any other shape → advanced.
  return { mode: 'advanced' }
}

export function recompose(listWrap: boolean, leafId: string, ext: string): string {
  const leaf: ParsedKind =
    leafId === 'path'
      ? { kind: 'path', ext: ext === '' ? '*' : ext }
      : { kind: 'base', name: leafId }
  const full: ParsedKind = listWrap ? { kind: 'list', item: leaf } : leaf
  return stringifyKind(full)
}

export function KindSelect({
  value,
  onChange,
  ariaLabel,
  disabled,
  testidPrefix,
}: KindSelectProps) {
  const { t } = useTranslation()
  const decomposed = decompose(value)
  const [forceAdvanced, setForceAdvanced] = useState(false)
  const [advRaw, setAdvRaw] = useState(value)

  // Keep the advanced buffer in sync when the value changes from outside.
  useEffect(() => {
    setAdvRaw(value)
  }, [value])

  const isAdvanced = forceAdvanced || decomposed.mode === 'advanced'
  const tid = (s: string) => (testidPrefix !== undefined ? `${testidPrefix}-${s}` : undefined)

  if (isAdvanced) {
    const advValid = isRegisteredKindString(advRaw)
    return (
      <div className="kind-select kind-select--advanced">
        <TextInput
          value={advRaw}
          onChange={(v) => {
            setAdvRaw(v)
            if (isRegisteredKindString(v)) onChange(stringifyKind(parseKind(v)))
          }}
          placeholder="list<path<md>>"
          disabled={disabled}
          data-testid={tid('advanced-input')}
        />
        {!advValid && <div className="kind-select__error">{t('kindSelect.parseError')}</div>}
        {decompose(advRaw).mode === 'guided' && (
          <button
            type="button"
            className="btn btn--xs"
            onClick={() => setForceAdvanced(false)}
            disabled={disabled}
          >
            {t('kindSelect.guidedToggle')}
          </button>
        )}
      </div>
    )
  }

  const g = decomposed as Guided
  const isPath = g.leafId === 'path'

  return (
    <div className="kind-select" aria-label={ariaLabel}>
      <div className="kind-select__row">
        <Select<string>
          value={g.leafId}
          onChange={(leafId) => onChange(recompose(g.listWrap, leafId, g.ext))}
          options={SELECTABLE.map((d) => ({ value: d.id, label: t(d.labelKey) }))}
          ariaLabel={ariaLabel ?? t('kindSelect.baseLabel')}
          disabled={disabled}
        />
        {isPath && (
          <span className="kind-select__ext">
            <Select<string>
              value={g.ext}
              onChange={(ext) => onChange(recompose(g.listWrap, g.leafId, ext))}
              options={PATH_EXTS.map((e) => ({ value: e.ext, label: t(e.labelKey) }))}
              ariaLabel={t('kindSelect.extLabel')}
              disabled={disabled}
            />
          </span>
        )}
        <Switch
          checked={g.listWrap}
          onChange={(listWrap) => onChange(recompose(listWrap, g.leafId, g.ext))}
          label={t('kindSelect.listToggle')}
        />
        <button
          type="button"
          className="btn btn--xs kind-select__advanced-toggle"
          onClick={() => {
            setAdvRaw(value)
            setForceAdvanced(true)
          }}
          disabled={disabled}
        >
          {t('kindSelect.advancedToggle')}
        </button>
      </div>
      {g.leafId === 'signal' && (
        <div className="kind-select__hint">{t('kindSelect.signalHint')}</div>
      )}
    </div>
  )
}
