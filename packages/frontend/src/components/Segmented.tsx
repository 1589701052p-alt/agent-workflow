// RFC-150 — shared segmented control primitive (`.segmented` CSS namespace).
//
// One component for every 2-N mutually-exclusive short-option picker
// (LanguageSwitch-style controls, NodeInspector clarify sessionMode, memory
// scope picker, clarify.detail scope Q/W, ClarifyDirectiveToggle, …).
// DOM shape is byte-for-byte the pre-existing hand-rolled form so the
// `.segmented` CSS and the role/aria behavior locks keep working unchanged:
//   <div class="segmented[ className]" role="radiogroup" aria-label=…>
//     <button type="button" role="radio" aria-checked=…
//             class="segmented__option[ segmented__option--active]">…
//
// Radio semantics: clicking the already-active option is a no-op (onChange
// does NOT re-fire) — ClarifyDirectiveToggle relies on this to avoid
// re-POSTing the current directive.

import type { MouseEvent, ReactNode } from 'react'

export interface SegmentedOption<V extends string> {
  value: V
  label: ReactNode
  disabled?: boolean
  title?: string
  /**
   * kbd shortcut hint (clarify.detail Q/W scope picker). Rendered as
   * `<kbd class="kbd-shortcut segmented__shortcut" aria-hidden>`.
   */
  shortcut?: string
  /**
   * Extra data-* attributes on the option button, keyed WITHOUT the `data-`
   * prefix (e.g. `{ directive: 'stop' }` → `data-directive="stop"`).
   */
  data?: Record<string, string>
  /**
   * Explicit data-testid for this option button. Wins over the
   * `${testidPrefix}-${value}` derivation.
   */
  testid?: string
  /**
   * Explicit data-testid for the shortcut <kbd> element (clarify.detail's
   * per-question `…-kbd` ids don't fit the prefix derivation).
   */
  shortcutTestid?: string
}

interface SegmentedProps<V extends string> {
  value: V
  onChange: (v: V) => void
  /**
   * RFC-150 impl-gate: opt-in escape from the radio active-click no-op.
   * Session-mode controls (ClarifyEdit / CrossClarifyEdit) must persist an
   * EXPLICIT choice even when the clicked value equals the resolved default
   * — the workflow JSON materializes the field only on patch. Default false
   * keeps radio semantics (ClarifyDirectiveToggle's behavior lock).
   */
  allowActiveReselect?: boolean
  options: ReadonlyArray<SegmentedOption<V>>
  ariaLabel: string
  /** Extra class names appended after the standard `segmented` class. */
  className?: string
  /**
   * Optional namespace for test-only data-testid attributes. When set the
   * container gets `${prefix}` and each option button `${prefix}-${value}`.
   * No effect on production behavior. (Same contract as ChipsInput.)
   */
  testidPrefix?: string
  /** Explicit container data-testid. Wins over the testidPrefix derivation. */
  rootTestid?: string
  /** Disable every option (per-option `disabled` also supported). */
  disabled?: boolean
  /**
   * Stop mouseDown AND click bubbling past the control (canvas scenario:
   * ClarifyDirectiveToggle must not select/drag the node). onChange still
   * fires for clicks on a non-active option.
   */
  stopPointerPropagation?: boolean
}

export function Segmented<V extends string>({
  value,
  onChange,
  allowActiveReselect,
  options,
  ariaLabel,
  className,
  testidPrefix,
  rootTestid,
  disabled,
  stopPointerPropagation,
}: SegmentedProps<V>) {
  const stop = stopPointerPropagation === true ? (e: MouseEvent) => e.stopPropagation() : undefined
  return (
    <div
      className={'segmented' + (className !== undefined && className !== '' ? ' ' + className : '')}
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={rootTestid ?? testidPrefix}
      onMouseDown={stop}
      onClick={stop}
    >
      {options.map((opt) => {
        const active = opt.value === value
        const dataAttrs =
          opt.data !== undefined
            ? Object.fromEntries(Object.entries(opt.data).map(([k, v]) => [`data-${k}`, v]))
            : undefined
        return (
          <button
            key={opt.value}
            {...dataAttrs}
            type="button"
            role="radio"
            aria-checked={active}
            className={'segmented__option' + (active ? ' segmented__option--active' : '')}
            disabled={disabled === true || opt.disabled === true}
            title={opt.title}
            data-testid={
              opt.testid ??
              (testidPrefix !== undefined ? `${testidPrefix}-${opt.value}` : undefined)
            }
            onClick={(e) => {
              stop?.(e)
              if (!active || allowActiveReselect === true) onChange(opt.value)
            }}
          >
            {opt.label}
            {opt.shortcut !== undefined && (
              <kbd
                className="kbd-shortcut segmented__shortcut"
                aria-hidden="true"
                data-testid={opt.shortcutTestid}
              >
                {opt.shortcut}
              </kbd>
            )}
          </button>
        )
      })}
    </div>
  )
}
