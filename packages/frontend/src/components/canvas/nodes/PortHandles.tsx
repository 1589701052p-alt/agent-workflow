// Shared port-handle stack rendered on either side of a node body.
// xyflow's <Handle> position requires absolute % coords; we space ports
// vertically and label them inline so the canvas is self-explanatory
// without a separate inspector.

import { Handle, Position } from '@xyflow/react'

interface Props {
  /** Side these handles attach to. */
  side: 'left' | 'right'
  ports: string[]
  /**
   * When set, render an extra invisible target Handle covering the full
   * left edge so the first edge into a fresh node has somewhere to land.
   * Only honored when `side === 'left'`. The named handles render on top
   * (z-index) so fan-in drops still hit the precise port. See RFC-003.
   */
  catchAll?: { id: string }
}

export function PortHandles({ side, ports, catchAll }: Props) {
  const showCatchAll = side === 'left' && catchAll !== undefined
  if (ports.length === 0 && !showCatchAll) return null
  const position = side === 'left' ? Position.Left : Position.Right
  const type = side === 'left' ? 'target' : 'source'
  // Distribute handles evenly across the node's vertical extent (5%..95%).
  const span = 90
  const step = ports.length === 1 ? 0 : span / (ports.length - 1)
  return (
    <div className={`canvas-node__ports canvas-node__ports--${side}`}>
      {showCatchAll && (
        <Handle
          type="target"
          position={Position.Left}
          id={catchAll!.id}
          className="canvas-node__handle canvas-node__handle--catchall"
          aria-hidden="true"
        />
      )}
      {ports.map((p, i) => {
        const top = ports.length === 1 ? 50 : 5 + step * i
        return (
          <div
            key={p}
            className={`canvas-node__port canvas-node__port--${side}`}
            style={{ top: `${top}%` }}
          >
            <Handle type={type} position={position} id={p} className="canvas-node__handle" />
            <span className="canvas-node__port-label">{p}</span>
          </div>
        )
      })}
    </div>
  )
}
