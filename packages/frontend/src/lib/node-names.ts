// Shared node display-name resolution from a task's frozen workflow snapshot.
// Moved out of routes/tasks.detail.tsx (2026-07-02, 用户拍板「问题列表用节点名不用节点 ID」)
// so the task-question surfaces (board meta / filter chips / reassign pickers /
// centralized answer pane) resolve names through the SAME oracle as the node-runs
// table — one priority order, no per-surface forks (dedup-audit §5 缝合原则).

/**
 * Resolve a node's user-facing display name from the task's frozen workflow
 * snapshot. Mirrors the canvas `nodeTitle` priority so every task surface
 * shows the same label users see on the canvas:
 *   - explicit `title` (review / clarify / any node that set one)
 *   - `agentName` for agent-single
 *   - `inputKey` for input
 *   - otherwise null — caller falls back to nodeId
 */
/**
 * Agent nodes of a task's frozen snapshot as `{ id, label }` options — reassign /
 * handler candidates for the task question board (only agent nodes are valid
 * handlers). Labels resolve through {@link resolveNodeNameFromSnapshot} with an
 * id fallback, so every consumer (board meta, filter chips, reassign Select,
 * QuestionAuthorForm) shows 节点名 rather than the raw node id (用户 2026-07-02).
 * Defensive: malformed snapshots degrade to [].
 */
export function agentNodeOptionsFromSnapshot(snapshot: unknown): { id: string; label: string }[] {
  if (typeof snapshot !== 'object' || snapshot === null) return []
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []
  const out: { id: string; label: string }[] = []
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const node = n as { id?: unknown; kind?: unknown }
    if (typeof node.id !== 'string' || node.id.length === 0) continue
    if (typeof node.kind !== 'string' || !node.kind.startsWith('agent')) continue
    out.push({ id: node.id, label: resolveNodeNameFromSnapshot(snapshot, node.id) ?? node.id })
  }
  return out
}

export function resolveNodeNameFromSnapshot(
  snapshot: unknown,
  nodeId: string | null,
): string | null {
  if (nodeId === null) return null
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const nodes = (snapshot as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return null
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue
    const node = n as {
      id?: unknown
      kind?: unknown
      title?: unknown
      agentName?: unknown
      inputKey?: unknown
    }
    if (node.id !== nodeId) continue
    if (typeof node.title === 'string' && node.title.length > 0) return node.title
    if (node.kind === 'agent-single') {
      // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
      if (typeof node.agentName === 'string' && node.agentName.length > 0) return node.agentName
    }
    if (node.kind === 'input') {
      if (typeof node.inputKey === 'string' && node.inputKey.length > 0) return node.inputKey
    }
    return null
  }
  return null
}
