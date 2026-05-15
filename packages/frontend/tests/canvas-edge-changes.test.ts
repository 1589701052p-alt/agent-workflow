// Regression tests for the three EdgeInspector reachability bugs fixed
// in commit 9b7ba31. Each one independently blocked clicking an edge
// from opening the EdgeInspector; we lock the fixes in here so future
// refactors can't silently re-break them.

import { describe, expect, test } from 'vitest'
import { applyEdgeChanges, type Edge, type EdgeChange } from '@xyflow/react'
import { affectsEdgeDefinition } from '../src/components/canvas/WorkflowCanvas'

// --- Bug 1: handleEdgesChange used to filter ONLY for `remove`. xyflow
// reports edge selection via a `select` change; if we drop that the edge
// never gets `selected: true`, no `.selected` class, no
// onSelectionChange (`{nodes:[], edges:['x']}`), no EdgeInspector. The
// `affectsEdgeDefinition` predicate must say YES for structural changes
// and NO for purely UI ones, so selection-only ticks stay local but
// removals / adds / replacements still round-trip into the persisted
// WorkflowDefinition. ---

describe('affectsEdgeDefinition (handleEdgesChange propagation gate)', () => {
  test('select-only change is local UI state — does NOT affect definition', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'select', selected: true }]
    expect(affectsEdgeDefinition(changes)).toBe(false)
  })

  test('select=false (deselect) is also local-only', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'select', selected: false }]
    expect(affectsEdgeDefinition(changes)).toBe(false)
  })

  test('a remove change DOES affect the definition', () => {
    const changes: EdgeChange[] = [{ id: 'e1', type: 'remove' }]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('an add change DOES affect the definition', () => {
    const changes: EdgeChange[] = [
      {
        type: 'add',
        item: {
          id: 'e_new',
          source: 'a',
          target: 'b',
        } as Edge,
      },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('a replace change DOES affect the definition', () => {
    const changes: EdgeChange[] = [
      {
        id: 'e1',
        type: 'replace',
        item: { id: 'e1', source: 'a', target: 'c' } as Edge,
      },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('mixed select + remove still propagates (remove dominates)', () => {
    const changes: EdgeChange[] = [
      { id: 'e1', type: 'select', selected: true },
      { id: 'e2', type: 'remove' },
    ]
    expect(affectsEdgeDefinition(changes)).toBe(true)
  })

  test('empty change list is a no-op', () => {
    expect(affectsEdgeDefinition([])).toBe(false)
  })
})

// --- Bug 1 (continued): the previous `handleEdgesChange` used a custom
// filter that dropped every change type except `remove`. We now use
// xyflow's `applyEdgeChanges` so `select` flows through and edges get
// `selected: true`. This smoke-test pins us to xyflow's helper rather
// than re-rolling our own (which is exactly what introduced the bug). ---

describe('applyEdgeChanges propagates select (regression smoke)', () => {
  const baseEdges: Edge[] = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
  ]

  test('a `select` change with selected:true sets edge.selected', () => {
    const next = applyEdgeChanges([{ id: 'e1', type: 'select', selected: true }], baseEdges)
    expect(next.find((e) => e.id === 'e1')?.selected).toBe(true)
    // The other edge stays untouched.
    expect(next.find((e) => e.id === 'e2')?.selected).toBeUndefined()
  })

  test('a `select` change with selected:false unsets edge.selected', () => {
    const selected = baseEdges.map((e) => ({ ...e, selected: true }))
    const next = applyEdgeChanges([{ id: 'e1', type: 'select', selected: false }], selected)
    expect(next.find((e) => e.id === 'e1')?.selected).toBe(false)
  })

  test('a `remove` change drops the edge', () => {
    const next = applyEdgeChanges([{ id: 'e1', type: 'remove' }], baseEdges)
    expect(next.map((e) => e.id)).toEqual(['e2'])
  })
})

// --- Bug 2: `selectionOnDrag={true}` + `panOnDrag={[1,2]}` reserved
// every left-button click for a zero-distance lasso, silently swallowing
// edge clicks. We assert here that the WorkflowCanvas source does NOT
// reintroduce `selectionOnDrag`. The check is textual rather than
// behavioral because xyflow's drag/click interpretation is hard to
// simulate in JSDOM, but the bug is a one-line config regression so a
// source assertion catches it cheaply. ---

describe('WorkflowCanvas does not enable selectionOnDrag', () => {
  test('`selectionOnDrag` prop is absent from WorkflowCanvas source', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const here = path.dirname(new URL(import.meta.url).pathname)
    const src = await fs.readFile(
      path.join(here, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    // Strip line comments so an explanatory mention in a `//` comment
    // doesn't trip the regex; we only care about an actual prop usage.
    const code = src.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/selectionOnDrag\s*=/)
  })
})
