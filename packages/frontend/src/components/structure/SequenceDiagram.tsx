// RFC-085 T7 — custom-SVG UML sequence diagram for a method's forward call chain.
// No new dependency (consistent with the rest of the structure views, which are
// hand-rolled SVG/xyflow). Renderer is fed the PURE SequenceModel (lib/sequence),
// so it can be swapped without touching the data. Participants are columns
// (lifelines); messages are ordered top-to-bottom arrows; unresolved/external are
// dashed/dotted + muted.

import { useTranslation } from 'react-i18next'
import { classDisplay, UNRESOLVED_LIFELINE, type SequenceModel } from '@/lib/sequence'

const COL_W = 150
const ROW_H = 34
const HEAD_H = 40
const PAD = 24

export function SequenceDiagram({ model }: { model: SequenceModel }) {
  const { t } = useTranslation()
  if (model.messages.length === 0) {
    return <div className="callchain__empty muted">{t('tasks.structCallNoCalls')}</div>
  }
  const cx = (p: string): number => {
    const i = Math.max(0, model.participants.indexOf(p))
    return PAD + i * COL_W + COL_W / 2
  }
  const width = PAD * 2 + model.participants.length * COL_W
  const chartTop = HEAD_H + PAD
  const height = chartTop + model.messages.length * ROW_H + PAD

  return (
    <div className="seqdiag" data-testid="sequence-diagram">
      <svg width={width} height={height} role="img" aria-label={t('tasks.structSeqTitle')}>
        {/* lifelines */}
        {model.participants.map((p, i) => {
          const x = PAD + i * COL_W + COL_W / 2
          const unresolved = p === UNRESOLVED_LIFELINE
          return (
            <g key={p} className={`seqdiag__life${unresolved ? ' seqdiag__life--unresolved' : ''}`}>
              <rect
                x={PAD + i * COL_W + 8}
                y={PAD - 4}
                width={COL_W - 16}
                height={HEAD_H - 8}
                rx={5}
                className="seqdiag__head"
              />
              <text
                x={x}
                y={PAD + HEAD_H / 2 - 2}
                textAnchor="middle"
                className="seqdiag__head-label"
              >
                {classDisplay(p)}
              </text>
              <line x1={x} y1={chartTop} x2={x} y2={height - PAD} className="seqdiag__lifeline" />
            </g>
          )
        })}
        {/* messages */}
        {model.messages.map((m, idx) => {
          const y = chartTop + (idx + 0.5) * ROW_H
          const x1 = cx(m.from)
          const x2 = cx(m.to)
          const self = x1 === x2
          const cls = `seqdiag__msg seqdiag__msg--${m.resolution}`
          const label = `${' '.repeat(m.depth * 2)}${m.label}`
          if (self) {
            // self-call: a small loop to the right of the lifeline
            return (
              <g key={idx} className={cls}>
                <path
                  d={`M ${x1} ${y - 6} h 22 v 12 h -22`}
                  className="seqdiag__line"
                  fill="none"
                  markerEnd="url(#seq-arrow)"
                />
                <text x={x1 + 26} y={y - 8} className="seqdiag__msg-label">
                  {label}
                </text>
              </g>
            )
          }
          const dir = x2 > x1 ? 1 : -1
          return (
            <g key={idx} className={cls}>
              <text x={(x1 + x2) / 2} y={y - 6} textAnchor="middle" className="seqdiag__msg-label">
                {label}
              </text>
              <line
                x1={x1}
                y1={y}
                x2={x2 - dir * 6}
                y2={y}
                className="seqdiag__line"
                markerEnd="url(#seq-arrow)"
              />
            </g>
          )
        })}
        <defs>
          <marker
            id="seq-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L6,3 L0,6 Z" className="seqdiag__arrowhead" />
          </marker>
        </defs>
      </svg>
    </div>
  )
}
