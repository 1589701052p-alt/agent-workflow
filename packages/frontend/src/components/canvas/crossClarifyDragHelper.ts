// RFC-056 — cross-clarify-agent node drag helpers (parallel to clarifyDragHelper).
//
// Two drag interactions:
//
//   A. Reverse drag (questioner channel)
//      User drags from the cross-clarify node's left-side `questions`
//      input handle onto a downstream agent-single questioner node. One
//      gesture builds TWO edges:
//        1. questioner.__clarify__   → cross-clarify.questions      (ask)
//        2. cross-clarify.to_questioner → questioner.__clarify_response__
//                                       (visual, runtime wires answers
//                                        through cross_clarify_sessions)
//      Same pattern as RFC-023 reverse drag.
//
//   B. Forward drag (designer manual edge)
//      User drags from the cross-clarify node's `to_designer` output
//      handle onto an upstream agent-single designer node. One gesture
//      builds ONE edge:
//        cross-clarify.to_designer → designer.__external_feedback__
//      The `__external_feedback__` system port is synthetic — visible
//      on the canvas only while ≥ 1 cross-clarify points at the agent.
//
// All exports are pure functions, mirroring clarifyDragHelper.ts.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

export {
  CROSS_CLARIFY_INPUT_PORT_NAME,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
}

// ---------------------------------------------------------------------------
// pre-flight checks
// ---------------------------------------------------------------------------

/**
 * True when the given workflow node can host a cross-clarify channel.
 * v1 accepts agent-single only (validator emits
 * `cross-clarify-target-not-agent-single` for any other kind, including
 * agent-multi).
 */
export function isValidCrossClarifyQuestioner(node: WorkflowNode | undefined): boolean {
  if (node === undefined) return false
  return node.kind === 'agent-single'
}

/**
 * True when the agent already has an outbound `__clarify__` edge that
 * specifically targets ANOTHER cross-clarify node — i.e. a duplicate
 * cross-clarify on the same questioner agent. Per RFC-056 design.md
 * §4.2, an agent CAN have both an RFC-023 `clarify` target AND an
 * RFC-056 `clarify-cross-agent` target on the same `__clarify__`
 * source port ("罕见但合法"); the runtime picks cross-clarify when both
 * are present. So this pre-flight intentionally does NOT block when
 * the existing edge points at a plain `clarify` node — only when it
 * points at another cross-clarify node, which would be a real
 * duplicate the validator rejects.
 */
export function questionerHasExistingClarifyChannel(
  def: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  return def.edges.some((e) => {
    if (e.source.nodeId !== agentNodeId) return false
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) return false
    const tgt = def.nodes.find((n) => n.id === e.target.nodeId)
    return tgt?.kind === 'clarify-cross-agent'
  })
}

/**
 * True when the cross-clarify node already has its `to_designer` manual
 * edge wired. v1 v1 permits exactly one designer per cross-clarify node;
 * additional drops collapse to no-op.
 */
export function crossClarifyHasDesignerEdge(
  def: WorkflowDefinition,
  crossClarifyNodeId: string,
): boolean {
  return def.edges.some(
    (e) =>
      e.source.nodeId === crossClarifyNodeId &&
      e.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  )
}

/**
 * RFC-063 — true when the cross-clarify node already has a questioner
 * attached via the reverse-drag pattern (inbound edge on `questions`
 * from a `__clarify__` source port). Used to short-circuit a second-agent
 * reverse-drag before the schema-level `cross-clarify-multiple-questioners`
 * validator rule catches it on save. Mirrors RFC-023's
 * `clarifyHasAttachedAgent` — canvas-level inverse of
 * `questionerHasExistingClarifyChannel`: that one blocks "one questioner →
 * many cross-clarify"; this blocks "one cross-clarify → many questioners".
 */
export function crossClarifyHasAttachedQuestioner(
  def: WorkflowDefinition,
  crossClarifyNodeId: string,
): boolean {
  return def.edges.some(
    (e) =>
      e.target.nodeId === crossClarifyNodeId &&
      e.target.portName === CROSS_CLARIFY_INPUT_PORT_NAME &&
      e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

// ---------------------------------------------------------------------------
// builders — reverse-drag & manual-drag
// ---------------------------------------------------------------------------

/**
 * Build the two edges that materialise a cross-clarify QUESTIONER channel.
 * Caller is expected to splice both into `definition.edges[]` atomically.
 */
export function buildCrossClarifyQuestionerEdges(
  questionerNodeId: string,
  crossClarifyNodeId: string,
): [WorkflowEdge, WorkflowEdge] {
  const tail = ulid().slice(-6).toLowerCase()
  return [
    {
      id: `cross_clarify_${tail}_ask`,
      source: { nodeId: questionerNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `cross_clarify_${tail}_ans`,
      source: {
        nodeId: crossClarifyNodeId,
        portName: CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
      },
      target: { nodeId: questionerNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}

/** Build the single `to_designer → designer.__external_feedback__` edge. */
export function buildCrossClarifyDesignerEdge(
  crossClarifyNodeId: string,
  designerNodeId: string,
): WorkflowEdge {
  const tail = ulid().slice(-6).toLowerCase()
  return {
    id: `cross_clarify_${tail}_designer`,
    source: { nodeId: crossClarifyNodeId, portName: CROSS_CLARIFY_OUT_TO_DESIGNER_PORT },
    target: { nodeId: designerNodeId, portName: CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT },
  }
}

// ---------------------------------------------------------------------------
// drag-end application
// ---------------------------------------------------------------------------

/**
 * Apply the questioner reverse-drag. Same shape as RFC-023's
 * `applyClarifyReverseDrag`: returns `def` by reference on any pre-flight
 * failure, otherwise appends the two edges.
 *
 * Rejection cases:
 *   - cross-clarify nodeId missing / kind mismatch         → reject
 *   - questioner missing or not agent-single               → reject
 *   - questioner already has another clarify wired         → reject
 */
export function applyCrossClarifyQuestionerReverseDrag(
  def: WorkflowDefinition,
  args: { questionerNodeId: string; crossClarifyNodeId: string },
): WorkflowDefinition {
  const { questionerNodeId, crossClarifyNodeId } = args
  const crossNode = def.nodes.find((n) => n.id === crossClarifyNodeId)
  const agentNode = def.nodes.find((n) => n.id === questionerNodeId)
  if (crossNode === undefined || crossNode.kind !== 'clarify-cross-agent') return def
  if (!isValidCrossClarifyQuestioner(agentNode)) return def
  if (questionerHasExistingClarifyChannel(def, questionerNodeId)) return def
  // RFC-063: a single cross-clarify node may only attach to one questioner.
  // Block a second-agent reverse-drag before the validator catches it on save.
  if (crossClarifyHasAttachedQuestioner(def, crossClarifyNodeId)) return def
  const [ask, ans] = buildCrossClarifyQuestionerEdges(questionerNodeId, crossClarifyNodeId)
  return { ...def, edges: [...def.edges, ask, ans] }
}

/**
 * Apply the forward designer drag. Single edge.
 *
 * Rejection cases:
 *   - cross-clarify nodeId missing / kind mismatch         → reject
 *   - designer missing or not agent-single                 → reject
 *   - cross-clarify already has another to_designer edge   → reject
 */
export function applyCrossClarifyDesignerDrag(
  def: WorkflowDefinition,
  args: { crossClarifyNodeId: string; designerNodeId: string },
): WorkflowDefinition {
  const { crossClarifyNodeId, designerNodeId } = args
  const crossNode = def.nodes.find((n) => n.id === crossClarifyNodeId)
  const agentNode = def.nodes.find((n) => n.id === designerNodeId)
  if (crossNode === undefined || crossNode.kind !== 'clarify-cross-agent') return def
  if (agentNode === undefined || agentNode.kind !== 'agent-single') return def
  if (crossClarifyHasDesignerEdge(def, crossClarifyNodeId)) return def
  const edge = buildCrossClarifyDesignerEdge(crossClarifyNodeId, designerNodeId)
  return { ...def, edges: [...def.edges, edge] }
}

// ---------------------------------------------------------------------------
// connection classifier — for handleConnect / isValidConnection
// ---------------------------------------------------------------------------

/**
 * Pure classifier for "is this xyflow Connection a cross-clarify drop?".
 * Returns the resolved nodeIds + direction:
 *
 *   - 'questioner-reverse': source.handle='__clarify__' / target.handle='questions'
 *     OR source.handle='to_questioner' / target.handle='__clarify_response__'
 *     (forward drag dropping the answers edge onto questioner)
 *   - 'designer-forward': source.handle='to_designer' /
 *     target.handle='__external_feedback__'
 *
 * Returns null for any other shape (caller falls through to the normal
 * edge-creation path).
 */
export function classifyCrossClarifyConnection(
  def: WorkflowDefinition,
  conn: {
    source: string | null
    target: string | null
    sourceHandle: string | null
    targetHandle: string | null
  },
):
  | {
      kind: 'questioner-reverse'
      questionerNodeId: string
      crossClarifyNodeId: string
    }
  | {
      kind: 'designer-forward'
      crossClarifyNodeId: string
      designerNodeId: string
    }
  | null {
  if (conn.source === null || conn.target === null) return null

  // questioner-reverse: drop on cross-clarify.questions handle.
  if (conn.targetHandle === CROSS_CLARIFY_INPUT_PORT_NAME) {
    const tgt = def.nodes.find((n) => n.id === conn.target)
    if (tgt !== undefined && tgt.kind === 'clarify-cross-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.source,
        crossClarifyNodeId: conn.target,
      }
    }
  }
  // questioner-reverse via forward direction: drop cross.to_questioner onto
  // an agent. The classifier intentionally does NOT require the drop to land
  // on the `__clarify_response__` system target handle: that handle is only
  // rendered AFTER the channel exists (see WorkflowCanvas.computePorts
  // fallback), so a fresh agent has nowhere to land the drop except its
  // catch-all input strip. Without this loosened match, the drop falls
  // through to the defensive guard which rejects any `to_questioner` source
  // — and the user sees the connection silently fail (2026-05-22 bug
  // report: "从 cross-clarify 右侧 output 拖到 agent 左侧拖不上"). Validity
  // (agent-single kind, no duplicate channel) is enforced in
  // applyCrossClarifyQuestionerReverseDrag + isValidConnection downstream.
  if (conn.sourceHandle === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-cross-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.target,
        crossClarifyNodeId: conn.source,
      }
    }
  }
  // designer-forward: drop cross.to_designer onto an agent. Same shape as
  // `to_questioner` above — we accept the drop regardless of which target
  // handle xyflow picked, because `__external_feedback__` is also a
  // synthetic-on-edge port and isn't visible on a fresh agent.
  if (conn.sourceHandle === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-cross-agent') {
      return {
        kind: 'designer-forward',
        crossClarifyNodeId: conn.source,
        designerNodeId: conn.target,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// stray-drop guard — used by WorkflowCanvas.isValidConnection
// ---------------------------------------------------------------------------

/**
 * RFC-023/056 — the complete set of clarify / cross-clarify channel system
 * handles a GENERIC data edge must never land on. These ports are wired
 * EXCLUSIVELY by the reverse/forward drag helpers as fixed channel pairs, and
 * the scheduler's `buildScopeUpstreams` (scheduler.ts) strips every edge
 * touching them. A stray drop here therefore creates an edge that is silently
 * removed from the dispatch graph — erasing the target node's real upstream
 * dependency and turning it into a FALSE dispatch root (premature execution).
 *
 * `isValidConnection` calls this AFTER both channel classifiers
 * (`classifyClarifyConnection` / `classifyCrossClarifyConnection`) have
 * declined the drop, so a legitimate ask / answer / designer-feedback drag
 * never reaches here — only stray drops do, and they get the red-dashed
 * rejection.
 *
 * The historical inline guard listed `__external_feedback__` (designer side)
 * but OMITTED `__clarify_response__` (questioner side) and `__clarify__` (ask
 * source) — that asymmetry let an upstream output be dropped onto an agent's
 * `__clarify_response__`, the false-root incident this list closes. Keep it
 * symmetric: every clarify-channel handle name belongs here. Note
 * `CLARIFY_INPUT_PORT_NAME` and `CROSS_CLARIFY_INPUT_PORT_NAME` share the
 * literal value `'questions'`; both are listed for explicitness.
 */
export function isStrayClarifyChannelDrop(conn: {
  sourceHandle: string | null
  targetHandle: string | null
}): boolean {
  return (
    conn.targetHandle === CLARIFY_INPUT_PORT_NAME ||
    conn.sourceHandle === CLARIFY_OUTPUT_PORT_NAME ||
    conn.sourceHandle === CLARIFY_SOURCE_PORT_NAME ||
    conn.targetHandle === CLARIFY_RESPONSE_TARGET_PORT_NAME ||
    conn.targetHandle === CROSS_CLARIFY_INPUT_PORT_NAME ||
    conn.sourceHandle === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT ||
    conn.sourceHandle === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT ||
    conn.targetHandle === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT
  )
}

// ---------------------------------------------------------------------------
// cleanup — node + edge removal cascade
// ---------------------------------------------------------------------------

/** Identify whether an edge is part of a cross-clarify channel + which half. */
export function describeCrossClarifyChannelEdge(edge: WorkflowEdge):
  | {
      crossClarifyNodeId: string
      questionerNodeId: string
      half: 'ask' | 'ans'
    }
  | { crossClarifyNodeId: string; designerNodeId: string; half: 'designer' }
  | null {
  if (
    edge.source.portName === CLARIFY_SOURCE_PORT_NAME &&
    edge.target.portName === CROSS_CLARIFY_INPUT_PORT_NAME
  ) {
    return {
      questionerNodeId: edge.source.nodeId,
      crossClarifyNodeId: edge.target.nodeId,
      half: 'ask',
    }
  }
  if (
    edge.source.portName === CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT &&
    edge.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME
  ) {
    return {
      crossClarifyNodeId: edge.source.nodeId,
      questionerNodeId: edge.target.nodeId,
      half: 'ans',
    }
  }
  if (
    edge.source.portName === CROSS_CLARIFY_OUT_TO_DESIGNER_PORT &&
    edge.target.portName === CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT
  ) {
    return {
      crossClarifyNodeId: edge.source.nodeId,
      designerNodeId: edge.target.nodeId,
      half: 'designer',
    }
  }
  return null
}

/**
 * Bug-fix cascade (2026-05-22): the cross-clarify questioner channel is a
 * (ask, ans) pair persisted as two edges. Deleting either half on its own
 * would leave a half-wired channel — the scheduler keys off the ask edge
 * and would still try to cycle, but the canvas no longer shows the answer
 * arrow back (or vice-versa). Whenever `removedEdges` contains a
 * cross-clarify ask/ans edge, look up its sibling in `def.edges` and drop
 * it too. The `designer` half is a single edge with no sibling, so it is
 * NOT cascaded (deleting it just severs the designer feedback link).
 *
 * Returns `def` by reference when no cross-clarify channel edges were
 * removed (React effects short-circuit on `===`).
 */
export function cascadeRemoveCrossClarifyChannel(
  def: WorkflowDefinition,
  removedEdges: ReadonlyArray<WorkflowEdge>,
): WorkflowDefinition {
  if (removedEdges.length === 0) return def
  const brokenPairs = new Set<string>()
  for (const e of removedEdges) {
    const desc = describeCrossClarifyChannelEdge(e)
    if (desc !== null && (desc.half === 'ask' || desc.half === 'ans')) {
      brokenPairs.add(`${desc.questionerNodeId}|${desc.crossClarifyNodeId}`)
    }
  }
  if (brokenPairs.size === 0) return def
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const desc = describeCrossClarifyChannelEdge(e)
    if (desc === null || desc.half === 'designer') return true
    const key = `${desc.questionerNodeId}|${desc.crossClarifyNodeId}`
    if (brokenPairs.has(key)) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}

/** Cascade-remove cross-clarify edges when the user deletes a node. */
export function clearCrossClarifyEdgesForRemovedNodes(
  def: WorkflowDefinition,
  removedIds: ReadonlyArray<string>,
): WorkflowDefinition {
  if (removedIds.length === 0) return def
  const removed = new Set(removedIds)
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const refsRemoved = removed.has(e.source.nodeId) || removed.has(e.target.nodeId)
    if (!refsRemoved) return true
    if (describeCrossClarifyChannelEdge(e) !== null) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}
