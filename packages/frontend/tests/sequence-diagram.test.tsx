// RFC-085 T7 — SequenceDiagram renders the (pure) model: a lifeline per
// participant + an ordered message per call. Asserts on class/method text + the
// testid, not SVG geometry, so layout tweaks don't flake it.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import '../src/i18n'
import { SequenceDiagram } from '../src/components/structure/SequenceDiagram'
import { buildSequence } from '../src/lib/sequence'

afterEach(cleanup)

describe('SequenceDiagram', () => {
  test('renders a lifeline per class + a message per call', () => {
    const model = buildSequence('f.java::A', [
      {
        ownerClass: 'f.java::B',
        method: 'charge()',
        resolution: 'resolved',
        children: [
          { ownerClass: 'f.java::C', method: 'save()', resolution: 'resolved', children: [] },
        ],
      },
    ])
    render(<SequenceDiagram model={model} />)
    expect(screen.getByTestId('sequence-diagram')).toBeTruthy()
    // lifelines
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('C')).toBeTruthy()
    // messages (depth indent is leading spaces; match on the method text)
    expect(screen.getByText(/charge\(\)/)).toBeTruthy()
    expect(screen.getByText(/save\(\)/)).toBeTruthy()
  })

  test('empty model → no-calls message, not an empty SVG', () => {
    render(<SequenceDiagram model={{ participants: [], messages: [] }} />)
    expect(screen.queryByTestId('sequence-diagram')).toBeNull()
  })

  // Regression: message labels used to be centered between caller/callee lifelines
  // (textAnchor="middle" at (x1+x2)/2), so on long arrows the method name floated
  // far from either lifeline. They must now be left-aligned at the arrow's left end.
  test('message labels are left-aligned at the arrow start, not centered', () => {
    // A → B (lifeline centers PAD+COL_W/2=99 and PAD+COL_W+COL_W/2=249).
    const model = buildSequence('f::A', [
      { ownerClass: 'f::B', method: 'charge()', resolution: 'resolved', children: [] },
    ])
    render(<SequenceDiagram model={model} />)
    const label = screen.getByText(/charge\(\)/)
    expect(label.getAttribute('text-anchor')).toBe('start')
    // x sits just right of the LEFT lifeline (99 + SEQ_LABEL_GAP), not the midpoint 174
    expect(Number(label.getAttribute('x'))).toBe(99 + 8)
  })
})
