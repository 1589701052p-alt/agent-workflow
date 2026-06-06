// RFC-083 PR-F — read-only blast-radius graph (xyflow). Renders the pure model
// from buildStructureGraph: changed symbols + their callers, edges caller →
// changed. Fully non-interactive (no drag/connect/select) — it's a visualization,
// not an editor. All graph logic lives in lib/structureGraph (unit-tested); this
// is a thin xyflow adapter.

import { ReactFlow, ReactFlowProvider, Background, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff } from '@agent-workflow/shared'
import { buildStructureGraph } from '@/lib/structureGraph'

export function StructuralGraph({ data }: { data: StructuralDiff }) {
  const { t } = useTranslation()
  const graph = buildStructureGraph(data)
  if (graph.nodes.length === 0) {
    return <div className="muted">{t('tasks.structEmpty')}</div>
  }
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: n.label },
    className: `structure-graph__node structure-graph__node--${n.kind}`,
    draggable: false,
    connectable: false,
  }))
  const edges: Edge[] = graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target }))
  return (
    <div className="structure-graph" data-testid="structure-graph">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
