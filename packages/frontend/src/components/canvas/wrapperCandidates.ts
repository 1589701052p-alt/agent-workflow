// RFC-016: derive the select-options list used by the loop wrapper Inspector
// for `exitCondition.nodeId / portName` and `outputBindings`. Replaces the
// previous TextInput-based contract where users hand-typed inner node ids
// and port names from memory.
//
// Only direct, non-wrapper members are returned — loop exit conditions and
// output bindings should reference concrete agent / review nodes, not nested
// wrappers (their outputs flow through their own outputBindings rather than
// surfacing a port directly).

import { isWrapperKind, reviewApprovedPortName } from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

export interface LoopMemberCandidate {
  nodeId: string
  /** Display label = node.title || agentName || nodeId — UI shows "title (id)". */
  title: string
  /** Output ports the candidate node can be referenced on. */
  outputPorts: string[]
}

interface AgentSummary {
  name: string
  /** Declared agent outputs. When missing or empty, treat as ['out']. */
  outputs?: string[]
  /** Per-port declared kinds — used to resolve a review node's input kind
   *  (multi-doc vs single-doc) exactly like WorkflowCanvas.computePorts.
   *  Callers pass full Agent objects, which carry this field. */
  outputKinds?: Record<string, string>
}

/** Look up an inner node's display title using whatever fields the node kind
 * carries. Returns '' so the UI falls back to nodeId rendering when needed. */
function deriveTitle(node: WorkflowNode, agents: AgentSummary[]): string {
  const rec = node as Record<string, unknown>
  if (typeof rec.title === 'string' && rec.title.length > 0) return rec.title
  if (node.kind === 'agent-single') {
    const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
    if (agentName.length > 0) return agentName
  }
  if (node.kind === 'review') {
    // flag-audit W0（§3-4）：schema 字段是 inputSource（shared/schemas/review.ts），
    // 旧代码读不存在的 rec.source，此分支曾永不可达。
    const src = (rec.inputSource as { portName?: unknown } | undefined)?.portName
    if (typeof src === 'string' && src.length > 0) return `review:${src}`
  }
  // unused but kept for future kinds — agents lookup may inform fallback titles.
  void agents
  return ''
}

/** Resolve a review node's input KIND the same way the authoritative
 *  WorkflowCanvas.computePorts does: inputSource → source agent node →
 *  agent.outputKinds[portName]. Undefined when any link is missing —
 *  reviewApprovedPortName treats that as single-document. */
function resolveReviewInputKind(
  node: WorkflowNode,
  allNodes: WorkflowNode[],
  agents: AgentSummary[],
): string | undefined {
  const src = (node as Record<string, unknown>).inputSource as
    | { nodeId?: unknown; portName?: unknown }
    | undefined
  if (typeof src?.nodeId !== 'string' || typeof src.portName !== 'string') return undefined
  const sourceNode = allNodes.find((n) => n.id === src.nodeId)
  if (sourceNode === undefined || sourceNode.kind !== 'agent-single') return undefined
  const agentName = (sourceNode as Record<string, unknown>).agentName
  if (typeof agentName !== 'string') return undefined
  return agents.find((a) => a.name === agentName)?.outputKinds?.[src.portName]
}

function deriveOutputPorts(
  node: WorkflowNode,
  agents: AgentSummary[],
  allNodes: WorkflowNode[],
): string[] {
  if (node.kind === 'agent-single') {
    const rec = node as Record<string, unknown>
    const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
    const agent = agents.find((a) => a.name === agentName)
    const outputs = agent?.outputs ?? []
    if (outputs.length === 0) return ['out']
    return outputs.filter((n) => typeof n === 'string' && n.length > 0)
  }
  if (node.kind === 'review') {
    // flag-audit W0（§3-3）：旧代码返回不存在的 ['output']（loop Inspector 的
    // exitCondition / outputBindings 下拉出现假端口）。与 computePorts 同源：
    // shared 的 reviewApprovedPortName oracle + 恒定的 approval_meta。
    return [reviewApprovedPortName(resolveReviewInputKind(node, allNodes, agents)), 'approval_meta']
  }
  return []
}

export function loopMemberCandidates(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  agents: AgentSummary[],
): LoopMemberCandidate[] {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const result: LoopMemberCandidate[] = []
  for (const n of allNodes) {
    if (!idSet.has(n.id)) continue
    if (isWrapperKind(n.kind)) continue
    const outputPorts = deriveOutputPorts(n, agents, allNodes)
    result.push({
      nodeId: n.id,
      title: deriveTitle(n, agents),
      outputPorts,
    })
  }
  return result
}
