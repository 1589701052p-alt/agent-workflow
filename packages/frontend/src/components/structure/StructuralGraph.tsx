// RFC-083 PR-F — read-only blast-radius graph (xyflow). Renders the banded model
// from buildStructureGraph: one band per changed method that has callers, the
// method on the right with its callers stacked to its left, arrows pointing
// caller → method (call direction). A legend explains the two node colors. Fully
// non-interactive — it's a visualization, not an editor. Graph logic lives in
// lib/structureGraph (unit-tested); this is a thin adapter.

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MarkerType,
  Position,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff } from '@agent-workflow/shared'
import { buildStructureGraph } from '@/lib/structureGraph'
import { badgeSymbol } from '@/lib/structureView'

export function StructuralGraph({ data }: { data: StructuralDiff }) {
  const { t } = useTranslation()
  const graph = buildStructureGraph(data)
  if (graph.nodes.length === 0) {
    // The graph only shows changes that something else calls; none here.
    return <div className="muted structure-graph__empty">{t('tasks.structGraphEmpty')}</div>
  }
  const nodes: Node[] = graph.nodes.map((n) => {
    // Changed nodes carry a +/~/−/→ glyph + a change-type color class so add /
    // modify / delete / rename read at a glance (like the tree badges).
    const ctClass = n.changeType !== undefined ? ` structure-graph__node--ct-${n.changeType}` : ''
    const label = n.changeType !== undefined ? `${badgeSymbol(n.changeType)} ${n.label}` : n.label
    return {
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label },
      className: `structure-graph__node structure-graph__node--${n.kind}${ctClass}`,
      draggable: false,
      connectable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }
  })
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }))
  return (
    <div className="structure-graph-wrap">
      <div className="structure-graph__legend">
        <span className="structure-graph__legend-item">
          <span className="structure-graph__swatch structure-graph__swatch--ct-added" />
          {t('tasks.structGraphLegendAdded')}
        </span>
        <span className="structure-graph__legend-item">
          <span className="structure-graph__swatch structure-graph__swatch--ct-modified" />
          {t('tasks.structGraphLegendModified')}
        </span>
        <span className="structure-graph__legend-item">
          <span className="structure-graph__swatch structure-graph__swatch--ct-removed" />
          {t('tasks.structGraphLegendRemoved')}
        </span>
        <span className="structure-graph__legend-item">
          <span className="structure-graph__swatch structure-graph__swatch--caller" />
          {t('tasks.structGraphLegendCaller')}
        </span>
        <span className="structure-graph__legend-hint">{t('tasks.structGraphLegendHint')}</span>
      </div>
      <div className="structure-graph" data-testid="structure-graph">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            fitView
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}
