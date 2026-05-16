// RFC-016: compute the rendered group rectangle for a wrapper node from the
// absolute positions of its inner nodes (workflow.nodeIds projected against
// definition.nodes). Returns width/height (with header + padding) and the
// offset by which the wrapper's render anchor needs to shift so inner nodes
// land inside `padding` of the visible rect.
//
// Pure: no mutation, no DOM access. The editor calls this on first render of
// a wrapper that has no persisted `size`, on inner-node add/remove, and on
// "Fit to children" right-click.

import type { NodeKind, WorkflowNode } from '@agent-workflow/shared'

/** Default fallback dimensions per node kind. Used when the inner node has no
 * recorded `size` (every non-wrapper today) and we need to estimate how much
 * room it visually occupies on the canvas. Values match the realised CSS
 * widths of the existing custom node components. */
export const DEFAULT_NODE_SIZE_BY_KIND: Record<NodeKind, { width: number; height: number }> = {
  'agent-single': { width: 240, height: 120 },
  'agent-multi': { width: 240, height: 140 },
  input: { width: 200, height: 100 },
  output: { width: 200, height: 100 },
  review: { width: 240, height: 120 },
  'wrapper-git': { width: 200, height: 120 },
  'wrapper-loop': { width: 200, height: 120 },
}

/** Header strip height (matches `.canvas-node__header`). */
export const WRAPPER_HEADER_HEIGHT = 22
/** Default padding around inner content within the wrapper rect. */
export const WRAPPER_DEFAULT_PADDING = 24
/** Minimum rendered size when a wrapper holds zero inner nodes. */
export const WRAPPER_EMPTY_MIN_WIDTH = 200
export const WRAPPER_EMPTY_MIN_HEIGHT = 120

interface XY {
  x: number
  y: number
}

interface FitBounds {
  width: number
  height: number
  /** Suggested wrapper top-left so inner-nodes land at padding/padding+header. */
  offset: XY
}

function nodeSize(node: WorkflowNode): { width: number; height: number } {
  const rec = node as Record<string, unknown>
  const size = rec.size as { width?: unknown; height?: unknown } | undefined
  if (
    size !== undefined &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    size.width > 0 &&
    size.height > 0
  ) {
    return { width: size.width, height: size.height }
  }
  return DEFAULT_NODE_SIZE_BY_KIND[node.kind] ?? { width: 200, height: 100 }
}

export function computeFitBounds(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number = WRAPPER_DEFAULT_PADDING,
): FitBounds {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const inner = allNodes.filter((n) => idSet.has(n.id))

  if (inner.length === 0) {
    const pos = wrapper.position ?? { x: 0, y: 0 }
    return {
      width: WRAPPER_EMPTY_MIN_WIDTH,
      height: WRAPPER_EMPTY_MIN_HEIGHT,
      offset: { x: pos.x, y: pos.y },
    }
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of inner) {
    const p = n.position ?? { x: 0, y: 0 }
    const size = nodeSize(n)
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x + size.width > maxX) maxX = p.x + size.width
    if (p.y + size.height > maxY) maxY = p.y + size.height
  }

  const width = Math.max(WRAPPER_EMPTY_MIN_WIDTH, Math.round(maxX - minX + padding * 2))
  const height = Math.max(
    WRAPPER_EMPTY_MIN_HEIGHT,
    Math.round(maxY - minY + padding * 2 + WRAPPER_HEADER_HEIGHT),
  )
  const offset: XY = {
    x: Math.round(minX - padding),
    y: Math.round(minY - padding - WRAPPER_HEADER_HEIGHT),
  }
  return { width, height, offset }
}
