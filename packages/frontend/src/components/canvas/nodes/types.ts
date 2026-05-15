// Shared data shape for custom xyflow node components. The canvas
// pre-computes ports from the workflow definition + agents lookup so node
// components stay dumb.

import type { NodeKind } from '@agent-workflow/shared'

/** Catch-all left-side handle id. WorkflowCanvas.handleConnect translates
 * a connection landing here into target.portName = source.portName, which
 * is the design default (proposal §3.5). Named handles still take hit
 * priority for fan-in drops; the catch-all just lets the first edge into
 * a fresh node land somewhere. */
export const INBOUND_HANDLE_ID = '__inbound__'

/** Discriminated selection emitted by WorkflowCanvas.onSelect. RFC-003. */
export type CanvasSelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string }

export interface CanvasNodeData extends Record<string, unknown> {
  /** Workflow node id (mirrors xyflow node.id). */
  nodeId: string
  /** Original workflow node kind. */
  kind: NodeKind
  /** Human-readable label (agent name / input key / etc.). */
  title: string
  /** Optional second line (defaults to the node id). */
  subtitle?: string
  /** Output ports declared by this node (rendered on the right). */
  outputPorts: string[]
  /** Input ports declared by this node (rendered on the left). */
  inputPorts: string[]
  /**
   * Status color hint — populated by the task-detail canvas later. v1
   * editor leaves this `undefined` for the neutral default.
   */
  status?:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'skipped'
    | 'interrupted'
    | 'exhausted'
  /** True when this node sits inside a wrapper-loop body (blue accent). */
  loopBody?: boolean
}
