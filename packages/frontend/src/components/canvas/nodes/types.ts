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
   * RFC-106: while a connection is being dragged over this node, the name of
   * the NEW input port the drop will create. Rendered as a live preview port
   * row (identical to a real one) so the author sees exactly what will be wired
   * before releasing. Injected during the drag and cleared on drag end. Absent
   * when nothing is being dragged onto this node.
   */
  previewInputPort?: string
  /**
   * RFC-106: while a precise drop onto an EXISTING input port is hovered, the
   * name of that port — PortHandles highlights its row so the author sees the
   * drop will REUSE it (rather than add a new input). Mutually exclusive with
   * `previewInputPort`.
   */
  reuseInputPort?: string
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
  /**
   * Mirrored from `WorkflowNode.sourcePort` for agent-multi nodes only.
   * AgentNode reads it to toggle the top-handle's `is-connected` class
   * (RFC-015 §5.3). Other node kinds leave this `undefined`.
   */
  sourcePort?: { nodeId: string; portName: string }
  /**
   * RFC-060 wrapper-fanout only: name of the single input port marked
   * `isShardSource: true` in the WorkflowNode's `inputs[]`. WrapperNodes
   * uses this to render that port row with shard-source chrome (accent
   * stripe + "shard" badge) so authors see at a glance which port drives
   * the fan-out. Undefined on every other node kind.
   */
  shardSourcePort?: string
}
