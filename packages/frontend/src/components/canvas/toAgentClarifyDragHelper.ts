// RFC-W004 - to-agent clarify node drag helpers (parallel to
// crossClarifyDragHelper). The to-agent family shares the literal port names
// `questions` (input) + `to_questioner` (output) with RFC-056 cross-clarify,
// so every classifier / pre-flight here keys off the SOURCE/TARGET node's
// `kind === 'clarify-to-agent'` to stay disjoint from cross-clarify's
// kind === 'clarify-cross-agent' matches.
//
// Two drag interactions:
//
//   A. Reverse drag (questioner channel)
//      User drags from the to-agent node's left-side `questions` input handle
//      onto the questioner agent-single node B (OR drags the to-agent
//      `to_questioner` output handle onto B). One gesture builds TWO edges:
//        1. B.__clarify__         -> to-agent.questions            (ask)
//        2. to-agent.to_questioner -> B.__clarify_response__      (answer)
//      Same shape as RFC-023 / RFC-056 reverse drag - the answer flows back
//      to B at runtime via the to-agent channel (not the human board).
//
//   B. Forward drag (answerer manual edge)
//      User drags from the to-agent node's `to_answerer` output handle onto
//      the upstream answerer agent-single node A. One gesture builds ONE edge:
//        to-agent.to_answerer -> A.__clarify_request__
//      `__clarify_request__` is a synthetic-on-edge system input port on A
//      (nodePorts.ts); it is rendered on the canvas only while ≥1 such edge
//      exists (mirrors cross-clarify's __external_feedback__).
//
// All exports are pure functions, mirroring crossClarifyDragHelper.ts.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  buildToAgentAnswererEdge,
  buildToAgentAutoEdges,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  TO_AGENT_CLARIFY_INPUT_PORT_NAME,
  TO_AGENT_CLARIFY_REQUEST_PORT,
  TO_AGENT_OUT_TO_ANSWERER_PORT,
  TO_AGENT_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'

export {
  TO_AGENT_CLARIFY_INPUT_PORT_NAME,
  TO_AGENT_OUT_TO_ANSWERER_PORT,
  TO_AGENT_OUT_TO_QUESTIONER_PORT,
  TO_AGENT_CLARIFY_REQUEST_PORT,
}

// ---------------------------------------------------------------------------
// pre-flight checks
// ---------------------------------------------------------------------------

/**
 * True when the given workflow node can host a to-agent QUESTIONER (B) or
 * ANSWERER (A) endpoint. v1 accepts agent-single only (validator emits
 * `clarify-to-agent-target-not-agent-single` / `-answerer-not-agent-single`
 * for any other kind, including agent-multi).
 */
export function isValidToAgentEndpoint(node: WorkflowNode | undefined): boolean {
  if (node === undefined) return false
  return node.kind === 'agent-single'
}

/**
 * True when the questioner agent B already has an outbound `__clarify__` edge
 * targeting ANOTHER to-agent node - i.e. a duplicate to-agent channel on the
 * same questioner. Mirrors cross-clarify's `questionerHasExistingClarifyChannel`:
 * an agent CAN have an RFC-023 `clarify` AND an RFC-056 `clarify-cross-agent`
 * AND an RFC-W004 `clarify-to-agent` on the same `__clarify__` source (rare
 * but legal); this pre-flight only blocks a SECOND to-agent on the same B.
 */
export function questionerHasExistingToAgentChannel(
  def: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  return def.edges.some((e) => {
    if (e.source.nodeId !== agentNodeId) return false
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) return false
    const tgt = def.nodes.find((n) => n.id === e.target.nodeId)
    return tgt?.kind === 'clarify-to-agent'
  })
}

/**
 * RFC-W004 - true when the to-agent node already has a questioner attached via
 * the reverse-drag pattern (inbound edge on `questions` from a `__clarify__`
 * source port). v1 permits exactly one questioner per to-agent node; the
 * validator's `clarify-to-agent-multiple-questioners` rule catches a second
 * on save, this pre-flight blocks it at drag time with red-dashed UX.
 */
export function toAgentHasAttachedQuestioner(
  def: WorkflowDefinition,
  toAgentNodeId: string,
): boolean {
  return def.edges.some(
    (e) =>
      e.target.nodeId === toAgentNodeId &&
      e.target.portName === TO_AGENT_CLARIFY_INPUT_PORT_NAME &&
      e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

/**
 * True when the to-agent node already has its `to_answerer` manual edge wired.
 * v1 permits exactly one answerer per to-agent node (validator rule
 * `clarify-to-agent-multiple-answerers`); additional drops collapse to no-op.
 * NOTE: multiple to-agent nodes MAY point at the same answerer A (design §3.4
 * multi-source aggregation) - that is NOT blocked here, only the inverse
 * (one to-agent -> many answerers) is.
 */
export function toAgentHasAnswererEdge(def: WorkflowDefinition, toAgentNodeId: string): boolean {
  return def.edges.some(
    (e) => e.source.nodeId === toAgentNodeId && e.source.portName === TO_AGENT_OUT_TO_ANSWERER_PORT,
  )
}

// ---------------------------------------------------------------------------
// drag-end application
// ---------------------------------------------------------------------------

/**
 * Apply the questioner reverse-drag. Returns `def` by reference on any
 * pre-flight failure, otherwise appends the two auto-edges from
 * `buildToAgentAutoEdges` (shared).
 *
 * Rejection cases:
 *   - to-agent nodeId missing / kind mismatch         -> reject
 *   - questioner missing or not agent-single          -> reject
 *   - questioner already has another to-agent wired    -> reject
 *   - to-agent already has a questioner attached       -> reject
 */
export function applyToAgentQuestionerReverseDrag(
  def: WorkflowDefinition,
  args: { questionerNodeId: string; toAgentNodeId: string },
): WorkflowDefinition {
  const { questionerNodeId, toAgentNodeId } = args
  const toAgentNode = def.nodes.find((n) => n.id === toAgentNodeId)
  const agentNode = def.nodes.find((n) => n.id === questionerNodeId)
  if (toAgentNode === undefined || toAgentNode.kind !== 'clarify-to-agent') return def
  if (!isValidToAgentEndpoint(agentNode)) return def
  if (questionerHasExistingToAgentChannel(def, questionerNodeId)) return def
  if (toAgentHasAttachedQuestioner(def, toAgentNodeId)) return def
  const edges = buildToAgentAutoEdges(questionerNodeId, toAgentNodeId)
  return { ...def, edges: [...def.edges, ...edges] }
}

/**
 * Apply the forward answerer drag. Single edge from `buildToAgentAnswererEdge`
 * (shared).
 *
 * Rejection cases:
 *   - to-agent nodeId missing / kind mismatch         -> reject
 *   - answerer missing or not agent-single            -> reject
 *   - to-agent already has a to_answerer edge          -> reject
 */
export function applyToAgentAnswererDrag(
  def: WorkflowDefinition,
  args: { toAgentNodeId: string; answererNodeId: string },
): WorkflowDefinition {
  const { toAgentNodeId, answererNodeId } = args
  const toAgentNode = def.nodes.find((n) => n.id === toAgentNodeId)
  const agentNode = def.nodes.find((n) => n.id === answererNodeId)
  if (toAgentNode === undefined || toAgentNode.kind !== 'clarify-to-agent') return def
  if (agentNode === undefined || agentNode.kind !== 'agent-single') return def
  if (toAgentHasAnswererEdge(def, toAgentNodeId)) return def
  const edge = buildToAgentAnswererEdge(toAgentNodeId, answererNodeId)
  return { ...def, edges: [...def.edges, edge] }
}

// ---------------------------------------------------------------------------
// connection classifier - for handleConnect / isValidConnection
// ---------------------------------------------------------------------------

/**
 * Pure classifier for "is this xyflow Connection a to-agent drop?". Returns
 * the resolved nodeIds + direction, or null (caller falls through to the
 * normal edge-creation path). Disjoint from `classifyCrossClarifyConnection`
 * because every match requires a `clarify-to-agent` kind endpoint.
 *
 *   - 'questioner-reverse': drop on to-agent.questions handle, OR forward drop
 *     of to-agent.to_questioner onto an agent (the answer-return half).
 *   - 'answerer-forward': drop of to-agent.to_answerer onto an agent.
 */
export function classifyToAgentConnection(
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
      toAgentNodeId: string
    }
  | {
      kind: 'answerer-forward'
      toAgentNodeId: string
      answererNodeId: string
    }
  | null {
  if (conn.source === null || conn.target === null) return null

  // questioner-reverse: drop on to-agent.questions handle (reverse drag).
  // `questions` is the shared literal with cross-clarify; the kind check
  // disambiguates.
  if (conn.targetHandle === TO_AGENT_CLARIFY_INPUT_PORT_NAME) {
    const tgt = def.nodes.find((n) => n.id === conn.target)
    if (tgt !== undefined && tgt.kind === 'clarify-to-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.source,
        toAgentNodeId: conn.target,
      }
    }
  }
  // questioner-reverse via forward direction: drop to-agent.to_questioner onto
  // an agent. `to_questioner` is the shared literal with cross-clarify; the
  // kind check disambiguates. Same loosened-target rationale as cross-clarify:
  // `__clarify_response__` is synthetic-on-edge and not visible on a fresh
  // agent, so accept the drop regardless of which target handle xyflow picked.
  if (conn.sourceHandle === TO_AGENT_OUT_TO_QUESTIONER_PORT) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-to-agent') {
      return {
        kind: 'questioner-reverse',
        questionerNodeId: conn.target,
        toAgentNodeId: conn.source,
      }
    }
  }
  // answerer-forward: drop to-agent.to_answerer onto an agent. Same
  // loosened-target rationale - `__clarify_request__` is synthetic-on-edge.
  if (conn.sourceHandle === TO_AGENT_OUT_TO_ANSWERER_PORT) {
    const src = def.nodes.find((n) => n.id === conn.source)
    if (src !== undefined && src.kind === 'clarify-to-agent') {
      return {
        kind: 'answerer-forward',
        toAgentNodeId: conn.source,
        answererNodeId: conn.target,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// stray-drop guard - extends the merged isStrayClarifyChannelDrop list
// ---------------------------------------------------------------------------

/**
 * RFC-W004 - the to-agent channel system handles a GENERIC data edge must
 * never land on, parallel to cross-clarify's `isStrayClarifyChannelDrop`.
 * `to_questioner` + `questions` are shared literals already covered by the
 * cross-clarify list; only `to_answerer` (source) + `__clarify_request__`
 * (target) are to-agent-specific.
 */
export function isStrayToAgentChannelDrop(conn: {
  sourceHandle: string | null
  targetHandle: string | null
}): boolean {
  return (
    conn.sourceHandle === TO_AGENT_OUT_TO_ANSWERER_PORT ||
    conn.targetHandle === TO_AGENT_CLARIFY_REQUEST_PORT
  )
}

// ---------------------------------------------------------------------------
// cleanup - node + edge removal cascade
// ---------------------------------------------------------------------------

/** Identify whether an edge is part of a to-agent channel + which half. */
export function describeToAgentChannelEdge(edge: WorkflowEdge):
  | {
      toAgentNodeId: string
      questionerNodeId: string
      half: 'ask' | 'ans'
    }
  | { toAgentNodeId: string; answererNodeId: string; half: 'answerer' }
  | null {
  if (
    edge.source.portName === CLARIFY_SOURCE_PORT_NAME &&
    edge.target.portName === TO_AGENT_CLARIFY_INPUT_PORT_NAME
  ) {
    return {
      questionerNodeId: edge.source.nodeId,
      toAgentNodeId: edge.target.nodeId,
      half: 'ask',
    }
  }
  if (
    edge.source.portName === TO_AGENT_OUT_TO_QUESTIONER_PORT &&
    edge.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME
  ) {
    return {
      toAgentNodeId: edge.source.nodeId,
      questionerNodeId: edge.target.nodeId,
      half: 'ans',
    }
  }
  if (
    edge.source.portName === TO_AGENT_OUT_TO_ANSWERER_PORT &&
    edge.target.portName === TO_AGENT_CLARIFY_REQUEST_PORT
  ) {
    return {
      toAgentNodeId: edge.source.nodeId,
      answererNodeId: edge.target.nodeId,
      half: 'answerer',
    }
  }
  return null
}

/**
 * Bug-fix cascade (mirrors cross-clarify): the to-agent questioner channel is
 * a (ask, ans) pair persisted as two edges. Deleting either half on its own
 * would leave a half-wired channel; whenever `removedEdges` contains a
 * to-agent ask/ans edge, look up its sibling in `def.edges` and drop it too.
 * The `answerer` half is a single edge with no sibling and is NOT cascaded.
 * Returns `def` by reference when no to-agent channel edges were removed.
 */
export function cascadeRemoveToAgentChannel(
  def: WorkflowDefinition,
  removedEdges: ReadonlyArray<WorkflowEdge>,
): WorkflowDefinition {
  if (removedEdges.length === 0) return def
  const brokenPairs = new Set<string>()
  for (const e of removedEdges) {
    const desc = describeToAgentChannelEdge(e)
    if (desc !== null && (desc.half === 'ask' || desc.half === 'ans')) {
      brokenPairs.add(`${desc.questionerNodeId}|${desc.toAgentNodeId}`)
    }
  }
  if (brokenPairs.size === 0) return def
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const desc = describeToAgentChannelEdge(e)
    if (desc === null || desc.half === 'answerer') return true
    const key = `${desc.questionerNodeId}|${desc.toAgentNodeId}`
    if (brokenPairs.has(key)) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}

/**
 * Cascade-remove to-agent channel edges when the user deletes a node.
 * Mirrors `clearCrossClarifyEdgesForRemovedNodes`: the generic edge filter
 * upstream already drops edges referencing removed nodes; this pass documents
 * the to-agent dependency and is defensive against future filter changes.
 */
export function clearToAgentEdgesForRemovedNodes(
  def: WorkflowDefinition,
  removedIds: ReadonlyArray<string>,
): WorkflowDefinition {
  if (removedIds.length === 0) return def
  const removed = new Set(removedIds)
  let changed = false
  const nextEdges = def.edges.filter((e) => {
    const refsRemoved = removed.has(e.source.nodeId) || removed.has(e.target.nodeId)
    if (!refsRemoved) return true
    if (describeToAgentChannelEdge(e) !== null) {
      changed = true
      return false
    }
    return true
  })
  return changed ? { ...def, edges: nextEdges } : def
}
