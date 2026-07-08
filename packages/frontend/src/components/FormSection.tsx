// RFC-155 — shared form-section primitive.
//
// Two shapes behind one API:
//   - static (default): <section class="form-section"> with an <h2> title —
//     the same visual grammar as `.page__section`, scoped for forms.
//   - collapsible: <details class="form-section--collapsible"> with the title
//     inside <summary><h2> so it stays in the heading outline.
//
// Collapsible supports BOTH controlled (open + onToggle) and uncontrolled
// (defaultOpen) modes. A native summary click mutates DOM `open` outside
// React's knowledge, and a same-value re-render never writes it back — the
// classic controlled-<details> desync. This component absorbs it by
// following the native `toggle` event into state and re-asserting the
// rendered value after every commit.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

export interface FormSectionProps {
  title: string
  /** Collapsible (details/summary) shape. Default false = static section. */
  collapsible?: boolean
  /** Controlled open state (collapsible only; pair with onToggle). */
  open?: boolean
  onToggle?: (open: boolean) => void
  /** Uncontrolled initial open state (collapsible only). Default false. */
  defaultOpen?: boolean
  children: ReactNode
  'data-testid'?: string
}

export function FormSection(props: FormSectionProps): ReactElement {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen === true)
  const ref = useRef<HTMLDetailsElement>(null)
  const controlled = props.open !== undefined
  const open = controlled ? props.open === true : uncontrolledOpen
  useEffect(() => {
    if (ref.current !== null && ref.current.open !== open) ref.current.open = open
  })
  if (props.collapsible !== true) {
    return (
      <section className="form-section" data-testid={props['data-testid']}>
        <h2 className="form-section__title">{props.title}</h2>
        <div className="form-section__body">{props.children}</div>
      </section>
    )
  }
  return (
    <details
      ref={ref}
      className="form-section form-section--collapsible"
      open={open}
      data-testid={props['data-testid']}
      onToggle={(e) => {
        const domOpen = (e.currentTarget as HTMLDetailsElement).open
        if (domOpen === open) return // our own effect/render echo — not a user action
        if (!controlled) setUncontrolledOpen(domOpen)
        props.onToggle?.(domOpen)
      }}
    >
      <summary className="form-section__summary">
        <h2 className="form-section__title">{props.title}</h2>
      </summary>
      <div className="form-section__body">{props.children}</div>
    </details>
  )
}
