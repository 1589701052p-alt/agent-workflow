// RFC-023 bugfix source-level regression guards. The pure helpers in
// clarifyDragHelper.ts are covered by canvas-clarify-drag.test.ts; this
// file additionally pins the structural wiring inside WorkflowCanvas.tsx
// that JSDOM can't easily exercise (xyflow drag-and-drop isn't simulable
// in JSDOM). If a future refactor strips the wiring, the helper tests
// still pass — but the canvas would silently fall back to the catch-all
// edge-creation path and the user-reported bugs (#1 stray feedback edge
// only / #2 forward-drag creates wrong edge / #3 deleting one half
// leaves orphan) would resurface.
//
// Mirror of canvas-fanout-source-port-not-floating.test.ts (RFC-015).
//
// Locks:
//   1. computePorts adds `__clarify__` to agent outputs when an outbound
//      clarify edge exists (so xyflow renders the ask edge).
//   2. handleConnect routes drops via classifyClarifyConnection to
//      applyClarifyReverseDrag (covers both directions in one branch).
//   3. isValidConnection consults classifyClarifyConnection so red-dashed
//      feedback fires for both drag directions.
//   4. commitChange invokes cascadeRemoveClarifyChannel so deleting one
//      half of a clarify channel drops the sibling too.

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const CLARIFY_HELPER_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'clarifyDragHelper.ts')

describe('RFC-023 bugfix source-level wiring guard', () => {
  test('clarifyDragHelper.ts exports the new classifier + cascade helpers', () => {
    expect(existsSync(CLARIFY_HELPER_TS)).toBe(true)
    const src = readFileSync(CLARIFY_HELPER_TS, 'utf8')
    expect(src).toMatch(/export function classifyClarifyConnection\b/)
    expect(src).toMatch(/export function cascadeRemoveClarifyChannel\b/)
    expect(src).toMatch(/export function describeClarifyChannelEdge\b/)
  })

  test('WorkflowCanvas.tsx wires classifyClarifyConnection in handleConnect AND isValidConnection', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('classifyClarifyConnection')
    // Must appear at least twice — once in the connect path, once in
    // the validity guard. Use a regex count to lock both occurrences.
    const matches = src.match(/classifyClarifyConnection/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3) // import + 2 callers
  })

  test('WorkflowCanvas.tsx invokes cascadeRemoveClarifyChannel from commitChange', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('cascadeRemoveClarifyChannel')
    // The cascade call must live INSIDE commitChange so EVERY edge-delete
    // path (key, right-click menu, EdgeInspector remove, node-removal
    // cascade) funnels through it.
    const commitIdx = src.indexOf('const commitChange = useCallback')
    expect(commitIdx).toBeGreaterThan(-1)
    const commitBlock = src.slice(commitIdx, commitIdx + 1500)
    expect(commitBlock).toContain('cascadeRemoveClarifyChannel')
  })

  test('computePorts adds __clarify__ to agent outputs when an outbound clarify edge exists', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    // Locate computePorts; the agent branch must consult definition.edges
    // for the system port name and push it onto outputs[]. Without this
    // the ask edge has no Handle to anchor and xyflow silently drops it.
    const fnIdx = src.indexOf('export function computePorts')
    expect(fnIdx).toBeGreaterThan(-1)
    const body = src.slice(fnIdx, fnIdx + 3000)
    expect(body).toContain('CLARIFY_SOURCE_PORT_NAME')
    expect(body).toMatch(/outputs\.push\(\s*CLARIFY_SOURCE_PORT_NAME\s*\)/)
  })
})
