// RFC-155 — FormSection: the shared form-section primitive.
//
// Locks the contract AgentForm's section layout depends on:
//   1. static shape renders <section> + <h2> title + children;
//   2. collapsible defaults to closed, defaultOpen opens initially;
//   3. uncontrolled summary click toggles open/closed;
//   4. controlled mode: `open` prop drives the DOM and a summary click does
//      NOT flip it by itself — it only reports through onToggle (the React
//      `<details open>` desync pitfall this component exists to absorb).

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { FormSection } from '../src/components/FormSection'

function details(testid: string): HTMLDetailsElement {
  return screen.getByTestId(testid) as HTMLDetailsElement
}

describe('FormSection — static shape', () => {
  test('renders section with h2 title and children', () => {
    render(
      <FormSection title="Basics" data-testid="sec">
        <span>child-content</span>
      </FormSection>,
    )
    const sec = screen.getByTestId('sec')
    expect(sec.tagName).toBe('SECTION')
    expect(screen.getByRole('heading', { level: 2, name: 'Basics' })).toBeTruthy()
    expect(screen.getByText('child-content')).toBeTruthy()
  })
})

describe('FormSection — collapsible, uncontrolled', () => {
  test('defaults to closed; defaultOpen=true starts open', () => {
    render(
      <>
        <FormSection title="A" collapsible data-testid="closed-sec">
          <span>a</span>
        </FormSection>
        <FormSection title="B" collapsible defaultOpen data-testid="open-sec">
          <span>b</span>
        </FormSection>
      </>,
    )
    expect(details('closed-sec').open).toBe(false)
    expect(details('open-sec').open).toBe(true)
  })

  test('summary click toggles and reports via onToggle', () => {
    const onToggle = vi.fn()
    render(
      <FormSection title="A" collapsible onToggle={onToggle} data-testid="sec">
        <span>a</span>
      </FormSection>,
    )
    fireEvent.click(screen.getByRole('heading', { level: 2, name: 'A' }))
    expect(details('sec').open).toBe(true)
    expect(onToggle).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('heading', { level: 2, name: 'A' }))
    expect(details('sec').open).toBe(false)
    expect(onToggle).toHaveBeenLastCalledWith(false)
  })
})

describe('FormSection — collapsible, controlled', () => {
  test('open prop drives the DOM; a rejected toggle is written back on re-render', () => {
    const onToggle = vi.fn()
    // Factory, NOT a shared element: React bails out of re-rendering when the
    // element reference is identical, which would skip the commit effect this
    // test exists to exercise.
    const controlled = () => (
      <FormSection title="A" collapsible open={false} onToggle={onToggle} data-testid="sec">
        <span>a</span>
      </FormSection>
    )
    const { rerender } = render(controlled())
    fireEvent.click(screen.getByRole('heading', { level: 2, name: 'A' }))
    // The user's intent is reported…
    expect(onToggle).toHaveBeenLastCalledWith(true)
    // …and a SAME-VALUE re-render (parent rejected the toggle) must re-assert
    // the controlled prop onto the DOM. Plain React <details open> fails this
    // (no diff → no DOM write); FormSection's commit effect is the fix.
    rerender(controlled())
    expect(details('sec').open).toBe(false)
    rerender(
      <FormSection title="A" collapsible open={true} onToggle={onToggle} data-testid="sec">
        <span>a</span>
      </FormSection>,
    )
    expect(details('sec').open).toBe(true)
  })

  test('parent-wired controlled section survives repeated toggling without desync', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <FormSection title="A" collapsible open={open} onToggle={setOpen} data-testid="sec">
          <span>a</span>
        </FormSection>
      )
    }
    render(<Host />)
    const summaryTitle = screen.getByRole('heading', { level: 2, name: 'A' })
    fireEvent.click(summaryTitle)
    expect(details('sec').open).toBe(true)
    fireEvent.click(summaryTitle)
    expect(details('sec').open).toBe(false)
    fireEvent.click(summaryTitle)
    expect(details('sec').open).toBe(true)
  })
})
