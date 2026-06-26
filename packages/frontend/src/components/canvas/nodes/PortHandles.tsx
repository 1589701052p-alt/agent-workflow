// Port-handle renderer for canvas nodes. RFC-006 reshapes the layout:
// the old version absolutely positioned each port as a chip on a strip
// that hung off the node's outer edge (left: -6px / right: -6px), and
// the chip text extended back into the node body — covering the title
// and node-id. We now render ports as inline rows INSIDE the node body
// (handle dot pinned to the row edge via CSS, label inside the row),
// so labels never overlap header text and node height grows naturally
// with port count. Long names truncate with ellipsis + native title
// tooltip. The RFC-003 catch-all left strip is preserved as a sibling
// of the rows container so fresh agent / wrapper-loop nodes still
// accept the first inbound edge anywhere along the left edge.
//
// Public API (Props.side / ports / catchAll) is unchanged so the four
// node components calling this stay identical.

import { Handle, Position } from '@xyflow/react'

interface Props {
  /** Side these handles attach to. */
  side: 'left' | 'right'
  ports: string[]
  /**
   * When set, render an extra invisible target Handle covering the full
   * left edge so the first edge into a fresh node has somewhere to
   * land. Only honored when `side === 'left'`. Named handles take hit
   * priority (z-index 1 > 0) so fan-in drops still hit the precise
   * port. See RFC-003.
   */
  catchAll?: { id: string }
  /**
   * RFC-106: name of the live PREVIEW input port to append while a connection
   * is being dragged onto this node. Rendered as a real port row whose handle
   * IS a valid drop target, so the drag line connects to it and the released
   * state is identical. Only honored when `side === 'left'`.
   */
  previewPort?: string
  /**
   * RFC-106: name of an EXISTING input port the hovered precise drop will REUSE.
   * Its row gets a `--reuse-target` highlight so the author sees the drop will
   * reuse it. Only honored when `side === 'left'`.
   */
  reusePort?: string
}

export function PortHandles({ side, ports, catchAll, previewPort, reusePort }: Props) {
  const showCatchAll = side === 'left' && catchAll !== undefined
  const preview =
    side === 'left' && previewPort !== undefined && !ports.includes(previewPort)
      ? previewPort
      : undefined
  const reuse =
    side === 'left' && reusePort !== undefined && ports.includes(reusePort) ? reusePort : undefined
  if (ports.length === 0 && preview === undefined && !showCatchAll) return null
  const position = side === 'left' ? Position.Left : Position.Right
  const type = side === 'left' ? 'target' : 'source'
  const rows = preview === undefined ? ports : [...ports, preview]
  return (
    <>
      {showCatchAll && (
        <div className="canvas-node__inbound-catchall">
          <Handle
            type="target"
            position={Position.Left}
            id={catchAll!.id}
            className="canvas-node__handle canvas-node__handle--catchall"
            aria-hidden="true"
          />
        </div>
      )}
      {rows.length > 0 && (
        <div className={`canvas-node__port-rows canvas-node__port-rows--${side}`}>
          {rows.map((p) => {
            const isPreview = p === preview
            const isReuse = p === reuse
            return (
              <div
                key={p}
                className={`canvas-node__port-row canvas-node__port-row--${side}${
                  isPreview ? ' canvas-node__port-row--preview' : ''
                }${isReuse ? ' canvas-node__port-row--reuse-target' : ''}`}
              >
                {/* RFC-106: every INPUT (left) handle — existing AND the live
                    preview — is purely VISUAL for new connections: not a valid
                    connection END (xyflow would snap a drag to the nearest handle
                    centre and silently reuse it) and not a valid connection START
                    (a reverse drag FROM an input handle to an output would land on
                    that port with the OLD edge still present → two upstreams on one
                    port, the exact mis-wire this RFC kills, Codex P2). With both
                    off, the catch-all is the only xyflow drop target and the single
                    authority for new-vs-reuse is `resolveDropTarget` (pointer
                    geometry in the canvas), driving the preview / custom line /
                    build identically. Rebinding an existing input is done by the
                    FORWARD precise-reuse gesture (drag from an output, drop on the
                    port). Existing edges still ANCHOR on these handles (isConnectable*
                    only governs NEW connections). */}
                <Handle
                  type={type}
                  position={position}
                  id={p}
                  className="canvas-node__handle"
                  {...(type === 'target'
                    ? { isConnectableStart: false, isConnectableEnd: false }
                    : {})}
                />
                <span className="canvas-node__port-label" title={p}>
                  {p}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
