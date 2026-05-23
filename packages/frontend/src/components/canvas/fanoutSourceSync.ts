// RFC-060 PR-E — agent-multi NodeKind removed; this module is a no-op stub.
//
// Pre-RFC-060 this owned the RFC-015 fanout sourcePort drag-to-set helpers.
// The only NodeKind that had a sourcePort field was `agent-multi`, which
// RFC-060 PR-E deleted in favor of `wrapper-fanout`. wrapper-fanout uses
// real boundary-input edges (no synthetic edge id prefix, no sidecar field)
// so the entire dance below collapses to no-ops.
//
// We keep the API surface so WorkflowCanvas + AgentNode + clarifyDragHelper
// imports continue to resolve without a fan-out of call-site edits. A
// follow-up cleanup PR can inline-delete the call sites.

import type { Connection, Edge } from '@xyflow/react'
import type { WorkflowDefinition } from '@agent-workflow/shared'

/** Legacy handle id — no NodeKind renders this any more. */
export const MULTI_SOURCE_PORT_HANDLE_ID = '__multi_source_port__'

/** Legacy synthetic edge id prefix — never produced any more. */
export const SOURCE_PORT_EDGE_ID_PREFIX = '__sp__:'

/** No-op: agent-multi sourcePort is gone, nothing to apply. */
export function applySourcePortConnection(
  def: WorkflowDefinition,
  _conn: Connection,
): WorkflowDefinition {
  return def
}

/** No-op: no synthetic source-port edges to project. */
export function buildSourcePortDisplayEdges(_def: WorkflowDefinition): Edge[] {
  return []
}

/** No-op: agent-multi sourcePort is gone, nothing to clear on node removal. */
export function clearSourcePortOnNodeRemoved(
  def: WorkflowDefinition,
  _removed: ReadonlySet<string> | readonly string[],
): WorkflowDefinition {
  return def
}

/** No-op: no synthetic ids to interpret. */
export function clearSourcePortsForSyntheticIds(
  def: WorkflowDefinition,
  _edgeIds: ReadonlySet<string> | readonly string[],
): WorkflowDefinition {
  return def
}

/**
 * No-op pass-guard. Pre-RFC-060 PR-E this gated the agent-multi sourcePort
 * top-handle drop; with agent-multi removed there is no such handle, so the
 * guard must let every connection through.
 *
 * The caller in WorkflowCanvas.isValidConnection is written as
 *   `if (!isValidSourcePortConnection(...)) return false`
 * — i.e. **false from this function rejects the connection entirely**.
 * The previous stub returned `false`, which silently broke every single
 * drag-to-connect on the canvas (wrapper outputs, agent-to-agent, etc.).
 * Returning `true` here is the correct no-op semantics.
 */
export function isValidSourcePortConnection(_def: WorkflowDefinition, _conn: Connection): boolean {
  return true
}

/** No-op: returns null since no edge id can carry the legacy prefix. */
export function parseSyntheticSourcePortEdgeId(_edgeId: string): null {
  return null
}
