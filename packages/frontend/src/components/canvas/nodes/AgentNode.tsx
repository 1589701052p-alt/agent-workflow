// Renderer for agent-single nodes. (RFC-060 PR-E removed agent-multi.)

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { PortHandles } from './PortHandles'
import { INBOUND_HANDLE_ID, type CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function AgentNode({ data, selected }: Props) {
  const { t } = useTranslation()
  return (
    <div
      className={`canvas-node canvas-node--agent ${selected ? 'canvas-node--selected' : ''}`}
      data-status={data.status ?? 'default'}
      data-loop-body={data.loopBody ? 'true' : undefined}
    >
      <div className="canvas-node__header">
        <span className="canvas-node__kind">⚙ {t('agentNode.label')}</span>
        <span className="canvas-node__title">{data.title}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      <PortHandles side="left" ports={data.inputPorts} catchAll={{ id: INBOUND_HANDLE_ID }} />
      <PortHandles side="right" ports={data.outputPorts} />
      {/* xyflow needs at least one Handle of each type for valid drag flows;
          the right-side PortHandles cover outputs but agent-single also needs
          a no-op top handle so future re-additions don't fight xyflow's
          handle caching. */}
      <Handle type="target" position={Position.Top} id="__noop_top__" style={{ opacity: 0 }} />
    </div>
  )
}
