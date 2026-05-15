// RFC-007 source-level regression guard. The runtime / JSDOM tests
// (connection-sync.test.ts + canvas-review-output-drag.test.tsx) exercise
// behavior; this file additionally pins the structural contracts that a
// future refactor could erode silently — imports, exported symbols,
// hand-coded sentinel ids.
//
// Pattern follows the [feedback_post_commit_ci_check] "source-code-level
// fallback": JSDOM does not run xyflow's drag-and-drop, and the connect
// path's behavior depends on the WorkflowCanvas hooking the same
// connection-sync entry points the form does. If a refactor removes the
// import, the runtime test would still pass (the old behavior re-emerges
// as a regression) but this file would flag it.
//
// Link: design/RFC-007-canvas-review-output-drag/design.md §8.4

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')

const REVIEW_NODE_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'nodes', 'ReviewNode.tsx')
const CONNECTION_SYNC_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'connectionSync.ts')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const NODE_INSPECTOR_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'NodeInspector.tsx')
const WORKFLOWS_EDIT_TSX = resolve(FRONTEND_SRC, 'routes', 'workflows.edit.tsx')

describe('RFC-007 source-level guard', () => {
  test('connectionSync.ts exists and exports the four sync helpers + sentinel', () => {
    expect(existsSync(CONNECTION_SYNC_TS)).toBe(true)
    const src = readFileSync(CONNECTION_SYNC_TS, 'utf8')
    expect(src).toMatch(/export const REVIEW_INPUT_HANDLE_ID\s*=\s*['"]__review_input__['"]/)
    expect(src).toMatch(/export function applyConnectionForReviewOutput\b/)
    expect(src).toMatch(/export function applyDisconnectForReviewOutput\b/)
    expect(src).toMatch(/export function syncEdgeFromFormField\b/)
    expect(src).toMatch(/export function healFieldEdgeConsistency\b/)
  })

  test('ReviewNode.tsx renders the named target Handle + drops the old "intentionally off" note', () => {
    const tsx = readFileSync(REVIEW_NODE_TSX, 'utf8')
    expect(tsx).toContain('REVIEW_INPUT_HANDLE_ID')
    expect(tsx).toContain('type="target"')
    // The pre-RFC-007 reasoning must be gone — it claimed the catch-all
    // strip was off, which is no longer the design.
    expect(tsx).not.toContain('Catch-all inbound strip is intentionally off')
  })

  test('WorkflowCanvas.tsx imports and wires the sync helpers', () => {
    const tsx = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]\.\/connectionSync['"]/)
    expect(tsx).toContain('applyConnectionForReviewOutput')
    expect(tsx).toContain('applyDisconnectForReviewOutput')
    // isValidConnection must be reachable so the iterate-lock surface
    // remains wired even if the prop is removed by accident.
    expect(tsx).toContain('isValidConnection')
  })

  test('NodeInspector.tsx imports REVIEW_INPUT_HANDLE_ID + uses syncEdgeFromFormField', () => {
    const tsx = readFileSync(NODE_INSPECTOR_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]\.\/connectionSync['"]/)
    expect(tsx).toContain('REVIEW_INPUT_HANDLE_ID')
    expect(tsx).toContain('syncEdgeFromFormField')
  })

  test('workflows.edit.tsx threads healFieldEdgeConsistency into healLoadedDefinition', () => {
    const tsx = readFileSync(WORKFLOWS_EDIT_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]@\/components\/canvas\/connectionSync['"]/)
    expect(tsx).toContain('healFieldEdgeConsistency')
  })
})
