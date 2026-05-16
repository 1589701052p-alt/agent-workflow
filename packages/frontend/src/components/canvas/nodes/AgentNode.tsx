// Renderer for agent-single and agent-multi nodes. The multi-process
// glyph + fan-out badge highlights that the runtime shards the
// sourcePort. M3 will turn the glyph live.
//
// RFC-015: agent-multi nodes additionally render a top-side target Handle
// (`__multi_source_port__`) that accepts a drag from any upstream output.
// The drop writes node.sourcePort directly (not edges[]) — see
// `fanoutSourceSync.applySourcePortConnection`.

import { useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'
import { MULTI_SOURCE_PORT_HANDLE_ID } from '../fanoutSourceSync'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function AgentNode({ id, data, selected }: Props) {
  const multi = data.kind === 'agent-multi'
  // xyflow caches handle positions per node id; toggling agent-single ↔
  // agent-multi adds/removes the top handle and must trigger a re-measure.
  // ResizeObserver already handles port-row growth, but handle id list
  // changes need an explicit nudge.
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    if (multi) updateNodeInternals(id)
  }, [multi, id, updateNodeInternals])

  const sourcePortConnected = multi && (data.sourcePort?.nodeId ?? '') !== ''

  return (
    <div
      className={`canvas-node canvas-node--agent ${multi ? 'canvas-node--multi' : ''} ${selected ? 'canvas-node--selected' : ''}`}
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
    >
      {multi && (
        <Handle
          type="target"
          position={Position.Top}
          id={MULTI_SOURCE_PORT_HANDLE_ID}
          className={
            'canvas-node__handle canvas-node__handle--shard-source' +
            (sourcePortConnected ? ' is-connected' : '')
          }
          aria-label="multi-source-port"
        />
      )}
      <div className="canvas-node__header">
        <span className="canvas-node__kind">{multi ? '🔀 agent-multi' : 'agent'}</span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      <PortHandles side="left" ports={data.inputPorts} catchAll={{ id: INBOUND_HANDLE_ID }} />
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
