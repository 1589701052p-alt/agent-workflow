// Review node — RFC-005 PR-D T29.
//
// Visually similar to InputNode + OutputNode (the "IO" family) but in the
// "Human" category: shows the title, the id, the configured input source
// `nodeId.portName`, and the two output ports (`approved_doc`,
// `approval_meta`) on the right. Catch-all inbound strip is intentionally
// off — the review's input is configured explicitly on the node, not
// routed through edges (RFC-005 design.md §A1).

import type { NodeProps } from '@xyflow/react'
import { PortHandles } from './PortHandles'
import type { CanvasNodeData } from './types'

interface Props extends NodeProps {
  data: CanvasNodeData
}

export function ReviewNode({ data, selected }: Props) {
  const inputSource =
    (data as CanvasNodeData & { inputSource?: { nodeId: string; portName: string } }).inputSource ??
    null
  return (
    <div className={'canvas-node canvas-node--review' + (selected ? ' canvas-node--selected' : '')}>
      <div className="canvas-node__header">
        <span className="canvas-node__kind">⚖ review</span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      {inputSource !== null &&
        (inputSource.nodeId.length > 0 || inputSource.portName.length > 0) && (
          <div className="canvas-node__input-source muted">
            <code>{inputSource.nodeId || '?'}</code>
            <span>.</span>
            <code>{inputSource.portName || '?'}</code>
          </div>
        )}
      <PortHandles side="right" ports={data.outputPorts} />
    </div>
  )
}
