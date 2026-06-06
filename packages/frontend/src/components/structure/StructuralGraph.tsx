// RFC-083 PR-F/PR-G — read-only class-collaboration diagram (xyflow), laid out
// top→down by dagre. Cards have variable size (member rows), so we use the
// controlled-node pattern: render → let xyflow MEASURE each card → re-run dagre
// with the real sizes → fitView. Without this, edges connect to estimated node
// boxes and visibly float off the cards.

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff } from '@agent-workflow/shared'
import {
  buildStructureGraph,
  layoutGraph,
  type GraphCard,
  type StructureGraph,
} from '@/lib/structureGraph'
import { badgeSymbol } from '@/lib/structureView'

function CardNode({ data }: NodeProps) {
  const card = data.card as GraphCard
  const ctClass = card.changeType !== undefined ? ` sg-card--ct-${card.changeType}` : ''
  const changedClass = card.isChanged ? ' sg-card--changed' : ' sg-card--caller'
  return (
    <div className={`sg-card${changedClass}${ctClass}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="sg-card__header">
        <span className="sg-card__kind">{card.kind}</span>
        <span className="sg-card__title" title={`${card.title} · ${card.file}`}>
          {card.title}
        </span>
        {card.changeType !== undefined && (
          <span className="sg-card__badge">{badgeSymbol(card.changeType)}</span>
        )}
      </div>
      {card.members.length > 0 && (
        <ul className="sg-card__members">
          {card.members.map((m) => (
            <li
              key={m.id}
              className={
                m.role === 'changed'
                  ? `sg-card__member sg-card__member--ct-${m.changeType}`
                  : 'sg-card__member sg-card__member--caller'
              }
            >
              <span className="sg-card__member-badge">
                {m.role === 'changed' && m.changeType !== undefined
                  ? badgeSymbol(m.changeType)
                  : '·'}
              </span>
              <span className="sg-card__member-name">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

function PkgNode({ data }: NodeProps) {
  return (
    <div className="sg-pkg">
      <span className="sg-pkg__label">{String(data.label)}</span>
    </div>
  )
}

const NODE_TYPES = { card: CardNode, pkg: PkgNode }

function GraphFlow({ graph }: { graph: StructureGraph }) {
  const initialNodes = useMemo<Node[]>(
    () => [
      // package containers first / lowest z so the cards sit on top of them
      ...graph.packages.map((p) => ({
        id: p.id,
        type: 'pkg',
        position: { x: p.x, y: p.y },
        data: { label: p.label },
        draggable: false,
        selectable: false,
        connectable: false,
        zIndex: 0,
        style: { width: p.w, height: p.h },
      })),
      ...graph.cards.map((c) => ({
        id: c.id,
        type: 'card',
        position: { x: c.x, y: c.y },
        data: { card: c },
        draggable: false,
        connectable: false,
        zIndex: 1,
      })),
    ],
    [graph],
  )
  const initialEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        className: `sg-edge--${e.kind}`,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [graph],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState(initialEdges)
  const initialized = useNodesInitialized()
  const { fitView } = useReactFlow()
  const laidOut = useRef(false)

  // new data → reset to estimated layout and re-measure
  useEffect(() => {
    laidOut.current = false
    setNodes(initialNodes)
  }, [initialNodes, setNodes])

  // once xyflow has measured every card, re-run dagre with the REAL sizes so the
  // hierarchy spacing is correct and edges land on the actual card edges.
  useEffect(() => {
    if (!initialized || laidOut.current) return
    laidOut.current = true
    setNodes((nds) => {
      for (const c of graph.cards) {
        const measured = nds.find((n) => n.id === c.id)?.measured
        if (measured?.width) c.w = measured.width
        if (measured?.height) c.h = measured.height
      }
      layoutGraph(graph.cards, graph.edges, graph.packages)
      const cardPos = new Map(graph.cards.map((c) => [c.id, { x: c.x, y: c.y }]))
      const pkg = new Map(graph.packages.map((p) => [p.id, p]))
      return nds.map((n) => {
        if (n.type === 'pkg') {
          const p = pkg.get(n.id)
          return p === undefined
            ? n
            : { ...n, position: { x: p.x, y: p.y }, style: { ...n.style, width: p.w, height: p.h } }
        }
        return { ...n, position: cardPos.get(n.id) ?? n.position }
      })
    })
    requestAnimationFrame(() => fitView({ minZoom: 0.4, maxZoom: 1, padding: 0.12 }))
  }, [initialized, graph, setNodes, fitView])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      fitView
      fitViewOptions={{ maxZoom: 1, minZoom: 0.4 }}
      minZoom={0.15}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export function StructuralGraph({ data }: { data: StructuralDiff }) {
  const { t } = useTranslation()
  const graph = useMemo(() => buildStructureGraph(data), [data])
  if (graph.cards.length === 0) {
    return <div className="muted structure-graph__empty">{t('tasks.structGraphEmpty')}</div>
  }
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
        <span className="structure-graph__legend-sep" aria-hidden="true" />
        <span className="structure-graph__legend-item">
          <span className="structure-graph__edge-key structure-graph__edge-key--inherits" />
          {t('tasks.structGraphEdgeInherits')}
        </span>
        <span className="structure-graph__legend-item">
          <span className="structure-graph__edge-key structure-graph__edge-key--references" />
          {t('tasks.structGraphEdgeReferences')}
        </span>
        <span className="structure-graph__legend-item">
          <span className="structure-graph__edge-key structure-graph__edge-key--calls" />
          {t('tasks.structGraphEdgeCalls')}
        </span>
        <span className="structure-graph__legend-hint">{t('tasks.structGraphLegendHint')}</span>
      </div>
      <div className="structure-graph" data-testid="structure-graph">
        <ReactFlowProvider>
          <GraphFlow graph={graph} />
        </ReactFlowProvider>
      </div>
    </div>
  )
}
