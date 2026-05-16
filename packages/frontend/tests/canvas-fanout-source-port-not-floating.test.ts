// RFC-015 source-level regression guard. The runtime / JSDOM tests
// (fanout-source-sync.test.ts + canvas-fanout-source-port-drag.test.tsx)
// exercise behavior; this file additionally pins the structural contracts
// that a future refactor could erode silently — imports, exported symbols,
// hand-coded sentinel ids, CSS class names, i18n key copy.
//
// Pattern follows the [feedback_post_commit_ci_check] "source-code-level
// fallback": JSDOM does not run xyflow's drag-and-drop, and the sourcePort
// fast-path depends on WorkflowCanvas hooking the same helpers AgentNode
// renders against. If a refactor removes the import or accidentally
// reverts the top handle wiring, the runtime test alone might still pass
// (xyflow silently falls back to RFC-007's edge-creation path, no field
// gets written) but this file flags it.
//
// Link: design/RFC-015-fanout-source-port-drag/design.md §8.4
// commit: <TBD-commit-hash>

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')

const AGENT_NODE_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'nodes', 'AgentNode.tsx')
const FANOUT_SYNC_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'fanoutSourceSync.ts')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const NODE_INSPECTOR_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'NodeInspector.tsx')
const STYLES_CSS = resolve(FRONTEND_SRC, 'styles.css')
const ZH_I18N = resolve(FRONTEND_SRC, 'i18n', 'zh-CN.ts')
const EN_I18N = resolve(FRONTEND_SRC, 'i18n', 'en-US.ts')

describe('RFC-015 source-level guard', () => {
  test('fanoutSourceSync.ts exists and exports the 3 helpers + sentinel id', () => {
    expect(existsSync(FANOUT_SYNC_TS)).toBe(true)
    const src = readFileSync(FANOUT_SYNC_TS, 'utf8')
    expect(src).toMatch(
      /export const MULTI_SOURCE_PORT_HANDLE_ID\s*=\s*['"]__multi_source_port__['"]/,
    )
    expect(src).toMatch(/export function applySourcePortConnection\b/)
    expect(src).toMatch(/export function clearSourcePortOnNodeRemoved\b/)
    expect(src).toMatch(/export function isValidSourcePortConnection\b/)
  })

  test('AgentNode.tsx renders the top sourcePort Handle only in the fanout branch', () => {
    const tsx = readFileSync(AGENT_NODE_TSX, 'utf8')
    expect(tsx).toContain('MULTI_SOURCE_PORT_HANDLE_ID')
    expect(tsx).toContain('Position.Top')
    expect(tsx).toContain('type="target"')
    // The is-connected visual flip must depend on data.sourcePort (the
    // mirror field surfaced by toFlowNodes).
    expect(tsx).toContain('canvas-node__handle--shard-source')
    expect(tsx).toContain('is-connected')
    expect(tsx).toContain('useUpdateNodeInternals')
  })

  test('WorkflowCanvas.tsx imports and wires the three fanout helpers', () => {
    const tsx = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]\.\/fanoutSourceSync['"]/)
    expect(tsx).toContain('MULTI_SOURCE_PORT_HANDLE_ID')
    expect(tsx).toContain('applySourcePortConnection')
    expect(tsx).toContain('clearSourcePortOnNodeRemoved')
    expect(tsx).toContain('isValidSourcePortConnection')
    // The fast-path inside handleConnect must check the sentinel BEFORE the
    // catch-all branch — otherwise translateInboundConnection would rewrite
    // targetHandle and the field-write path never fires.
    const handleConnectIdx = tsx.indexOf('handleConnect')
    const fastPathIdx = tsx.indexOf('MULTI_SOURCE_PORT_HANDLE_ID', handleConnectIdx)
    const inboundIdx = tsx.indexOf('INBOUND_HANDLE_ID', handleConnectIdx)
    expect(fastPathIdx).toBeGreaterThan(-1)
    expect(inboundIdx).toBeGreaterThan(-1)
    expect(fastPathIdx).toBeLessThan(inboundIdx)
  })

  test('WorkflowCanvas.tsx mirrors node.sourcePort onto data.sourcePort for agent-multi', () => {
    const tsx = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    // The is-connected handle class flip in AgentNode reads data.sourcePort;
    // toFlowNodes MUST populate it on the agent-multi branch.
    expect(tsx).toMatch(/n\.kind === ['"]agent-multi['"]/)
    expect(tsx).toContain('data.sourcePort')
  })

  test('NodeInspector.tsx renders the drag-hint i18n key for agent-multi', () => {
    const tsx = readFileSync(NODE_INSPECTOR_TSX, 'utf8')
    expect(tsx).toContain('inspector.sourcePortDragHint')
  })

  test('styles.css carries the shard-source two-state visual rules', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toContain('.canvas-node__handle--shard-source')
    expect(css).toContain('.canvas-node__handle--shard-source.is-connected')
  })

  test('zh-CN.ts and en-US.ts both declare sourcePortDragHint', () => {
    const zh = readFileSync(ZH_I18N, 'utf8')
    const en = readFileSync(EN_I18N, 'utf8')
    expect(zh).toContain('sourcePortDragHint')
    expect(en).toContain('sourcePortDragHint')
    // Type contract: the Resources interface in zh-CN.ts declares the key
    // (en-US.ts implements `Resources` and would fail typecheck if missing
    // anyway, but this keeps a textual breadcrumb).
    expect(zh).toMatch(/sourcePortDragHint\s*:\s*string/)
  })
})
