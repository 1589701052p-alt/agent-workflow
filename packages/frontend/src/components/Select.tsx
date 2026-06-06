// RFC-036 — minimal styled select. The native <select> element shows a
// browser-chrome popup that no amount of CSS on the <option> elements can
// restyle, which clashes with the rest of the dialog. This component
// renders a custom trigger + popover panel so the dropdown matches the
// surrounding inputs.
//
// API: drop-in replacement for the common (value, onChange, options) shape.
// Accessibility: role=combobox + aria-controls/expanded + role=listbox /
// option + arrow-key + Home/End + Enter/Space + Esc.

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption<V extends string> {
  value: V
  label: string
  description?: string
  disabled?: boolean
  /**
   * Optional group label. Consecutive options sharing the same non-empty
   * `group` render under a single non-interactive header — the unified
   * replacement for the native `<optgroup>` (used by ModelSelect's
   * provider grouping). Options must already be ordered so same-group
   * entries are adjacent; the header shows whenever `group` changes.
   */
  group?: string
}

interface Props<V extends string> {
  value: V
  options: ReadonlyArray<SelectOption<V>>
  onChange: (v: V) => void
  disabled?: boolean
  placeholder?: string
  ariaLabel?: string
  /** Extra class names appended to the trigger button. */
  className?: string
  /** name attribute on the hidden input so the value lands in `form` submits. */
  name?: string
  /** Forwarded to the trigger button so callers migrated from a native
   *  `<select data-testid>` keep the same test anchor. */
  'data-testid'?: string
  /** Render a custom row body. Default = `option.label`. */
  renderOption?: (opt: SelectOption<V>) => React.ReactNode
  /**
   * Render the trigger's selected-value display. Default = `option.label`.
   * Useful when the option rows are rich (icons, badges, mono-font sub-text)
   * and the same layout should appear on the closed trigger button.
   */
  renderValue?: (opt: SelectOption<V>) => React.ReactNode
}

export function Select<V extends string>(props: Props<V>) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      props.options.findIndex((o) => o.value === props.value),
    ),
  )
  // Listbox is portaled out of the trigger's parent so containers with
  // overflow:hidden (e.g. .data-table — used for border-radius rounding)
  // don't clip it. We position it manually with the trigger's
  // bounding rect each time it opens / on scroll / on resize.
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const popoverId = useId()
  const labelId = useId()
  const [popPos, setPopPos] = useState<{ left: number; top: number; width: number } | null>(null)

  // Recompute popover position relative to the viewport each time the
  // dropdown opens, and on every scroll/resize while open. Uses
  // window-scroll coords so we don't have to chase ancestor offsets.
  useLayoutEffect(() => {
    if (!open) return
    function recompute() {
      const t = triggerRef.current
      if (!t) return
      const r = t.getBoundingClientRect()
      setPopPos({
        left: r.left + window.scrollX,
        top: r.bottom + window.scrollY + 4,
        width: r.width,
      })
    }
    recompute()
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [open])

  const current = useMemo(
    () => props.options.find((o) => o.value === props.value),
    [props.options, props.value],
  )

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (triggerRef.current?.contains(t) === false && listRef.current?.contains(t) === false) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the listbox when opening so arrow keys work immediately.
  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => listRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [open])

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function onListKey(e: React.KeyboardEvent<HTMLUListElement>) {
    const last = props.options.length - 1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(last, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(last)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = props.options[activeIndex]
      if (opt && !opt.disabled) {
        props.onChange(opt.value)
        setOpen(false)
        triggerRef.current?.focus()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="select" data-open={open}>
      {props.name && <input type="hidden" name={props.name} value={props.value} />}
      <button
        type="button"
        role="combobox"
        ref={triggerRef}
        className={`select__trigger ${props.className ?? ''}`.trim()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-labelledby={props.ariaLabel ? undefined : labelId}
        aria-label={props.ariaLabel}
        data-testid={props['data-testid']}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span id={labelId} className="select__value">
          {current
            ? props.renderValue
              ? props.renderValue(current)
              : current.label
            : (props.placeholder ?? '')}
        </span>
        <span className="select__chevron" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        popPos &&
        createPortal(
          <ul
            id={popoverId}
            ref={listRef}
            tabIndex={-1}
            role="listbox"
            aria-label={props.ariaLabel ?? 'Select an option'}
            aria-activedescendant={`${popoverId}-opt-${activeIndex}`}
            className="select__listbox select__listbox--portal"
            onKeyDown={onListKey}
            style={{
              position: 'absolute',
              left: popPos.left,
              top: popPos.top,
              minWidth: popPos.width,
            }}
          >
            {props.options.map((opt, i) => {
              const active = i === activeIndex
              const selected = opt.value === props.value
              // Render a group header whenever the (non-empty) group changes
              // from the previous option. Index `i` stays the props.options
              // index so keyboard nav / aria-activedescendant remain aligned.
              const prevGroup = i > 0 ? props.options[i - 1]?.group : undefined
              const showHeader =
                opt.group !== undefined && opt.group !== '' && opt.group !== prevGroup
              return (
                <Fragment key={opt.value}>
                  {showHeader && (
                    <li className="select__group" role="presentation" aria-hidden>
                      {opt.group}
                    </li>
                  )}
                  <li
                    id={`${popoverId}-opt-${i}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={opt.disabled || undefined}
                    className={`select__option ${active ? 'select__option--active' : ''} ${
                      selected ? 'select__option--selected' : ''
                    }`.trim()}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => {
                      // mousedown not click — keeps focus from leaving before we close
                      e.preventDefault()
                      if (opt.disabled) return
                      props.onChange(opt.value)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                  >
                    <span className="select__option-label">
                      {props.renderOption ? props.renderOption(opt) : opt.label}
                    </span>
                    {selected && (
                      <span className="select__option-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </li>
                </Fragment>
              )
            })}
          </ul>,
          document.body,
        )}
    </div>
  )
}
