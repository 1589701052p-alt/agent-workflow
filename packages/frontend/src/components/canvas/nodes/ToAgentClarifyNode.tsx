// To-agent clarify node (RFC-W004) - leaf node, 1 input handle + 2 output handles:
//
//   - input    `questions`       (target side, left edge)
//   - output   `to_questioner`   (source side, right edge - auto-wired sibling)
//   - output   `to_answerer`     (source side, right edge - MANUAL edge to A)
//
// Mirrors CrossClarifyNode (RFC-056) shape: B reverse-asks upstream A via the
// reverse-drag auto-edges, and the user manually drags `to_answerer` onto the
// upstream answerer A's `__clarify_request__` port. The two output labels
// disambiguate which handle is which (same UX fix as cross-clarify's
// to_questioner / to_designer labels).
//
// Visual states (statusOverlay) mirror cross-clarify - to-agent reuses
// `awaiting_human` (T4 design simplification) instead of a new status:
//   - pending         -> neutral grey
//   - awaiting_human  -> amber
//   - answered        -> green      (A produced <workflow-clarify-answer>)
//   - abandoned       -> red        (A-fail -> CR-1 invariant upgrade)
//   - failed          -> red        (envelope malformed)
//
// The kind pill defaults to '💬 to-agent clarify'.

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_GLYPHS } from '../nodePalette'
import { useTranslation } from 'react-i18next'
import {
  TO_AGENT_CLARIFY_INPUT_PORT_NAME,
  TO_AGENT_OUT_TO_ANSWERER_PORT,
  TO_AGENT_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'
import { QuestionBadge } from './QuestionBadge'
import type { CanvasNodeData } from './types'

export type ToAgentClarifyStatus =
  | 'pending'
  | 'awaiting_human'
  | 'answered'
  | 'abandoned'
  | 'failed'

export interface ToAgentClarifyNodeData extends CanvasNodeData {
  statusOverlay?: ToAgentClarifyStatus
  kindLabel?: string
  description?: string
}

interface Props extends NodeProps {
  data: ToAgentClarifyNodeData
}

export function ToAgentClarifyNode({ data, selected }: Props) {
  const { t } = useTranslation()
  const status: ToAgentClarifyStatus = data.statusOverlay ?? mapFallbackStatus(data.status)
  const labelText =
    data.kindLabel ?? `${NODE_GLYPHS['clarify-to-agent']} ${t('clarifyToAgentNode.label')}`
  const toQuestionerLabel = t('clarifyToAgent.canvas.handleLabel.toQuestioner')
  const toAnswererLabel = t('clarifyToAgent.canvas.handleLabel.toAnswerer')
  return (
    <div
      className={
        'canvas-node canvas-node--clarify-to-agent' +
        (selected ? ' canvas-node--selected' : '') +
        ` canvas-node--clarify-to-agent-${status}`
      }
      data-status={status}
      data-clarify-nav={data.clarifyNav}
      data-testid={`canvas-node-clarify-to-agent-${data.nodeId}`}
    >
      <QuestionBadge data={data} />
      <Handle
        type="target"
        position={Position.Left}
        id={TO_AGENT_CLARIFY_INPUT_PORT_NAME}
        className="canvas-node__handle canvas-node__handle--to-agent-clarify-input"
        aria-label="to-agent-clarify-input"
      />
      <div className="canvas-node__header">
        <span className="canvas-node__kind">{labelText}</span>
        <span className="canvas-node__title">{data.title || data.nodeId}</span>
      </div>
      <div className="canvas-node__id">{data.nodeId}</div>
      {data.description !== undefined && data.description.length > 0 && (
        <div className="canvas-node__description muted">{data.description}</div>
      )}
      {data.clarifyNav !== undefined && (
        <div className="canvas-node__clarify-nav muted">
          {data.clarifyNav === 'awaiting'
            ? t('clarifyNode.navAwaiting')
            : t('clarifyNode.navAnswered')}
        </div>
      )}
      {/* Two output handles stacked on the right edge. `to_questioner` pairs
          with the reverse-drag auto-edge; `to_answerer` is the user's MANUAL
          wiring to the upstream answerer A. Labels mirror cross-clarify's
          disambiguation (2026-05-22 bug report: 输出的两个节点没有标识). */}
      <div
        className="canvas-node__to-agent-handle-label canvas-node__to-agent-handle-label--to-questioner"
        data-testid="to-agent-handle-label-to-questioner"
      >
        {toQuestionerLabel}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id={TO_AGENT_OUT_TO_QUESTIONER_PORT}
        className="canvas-node__handle canvas-node__handle--to-agent-to-questioner"
        aria-label="to-agent-to-questioner"
        style={{ top: '40%' }}
      />
      <div
        className="canvas-node__to-agent-handle-label canvas-node__to-agent-handle-label--to-answerer"
        data-testid="to-agent-handle-label-to-answerer"
      >
        {toAnswererLabel}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id={TO_AGENT_OUT_TO_ANSWERER_PORT}
        className="canvas-node__handle canvas-node__handle--to-agent-to-answerer"
        aria-label="to-agent-to-answerer"
        style={{ top: '70%' }}
      />
    </div>
  )
}

function mapFallbackStatus(status: CanvasNodeData['status']): ToAgentClarifyStatus {
  if (status === 'failed') return 'failed'
  if (status === 'done') return 'answered'
  // Task-detail canvas collapses node_run `awaiting_human` to the unified
  // 'awaiting' hint; translate it back to this node's amber `awaiting_human`.
  if (status === 'awaiting') return 'awaiting_human'
  if (status === 'running' || status === 'pending') return 'pending'
  return 'pending'
}
