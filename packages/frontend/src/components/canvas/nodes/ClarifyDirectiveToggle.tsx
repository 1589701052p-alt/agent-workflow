// RFC-122 — on-canvas per-(task, asking-node) clarify directive toggle
// ("继续反问 / 停止反问"). Rendered by AgentNode for asking-agent nodes on the
// task-detail canvas only (data.clarifyDirective !== undefined). Reuses the
// shared `.segmented` primitive (CLAUDE.md UI consistency — no hand-rolled
// chrome) so it matches the LanguageSwitch / NodeInspector segmented controls.
//
// Clicking the inactive half fires data.onClarifyDirectiveToggle(nodeId, next);
// the parent POSTs + invalidates and the new directive flows back through
// data.clarifyDirective. stopPropagation keeps a click off the node-select / no
// node drag (the task canvas is readOnly anyway). Renders nothing when the
// directive is undefined, so a canvas with no directives is byte-for-byte
// unchanged (golden-lock).

import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClarifyDirective } from '@agent-workflow/shared'
import type { CanvasNodeData } from './types'

const OPTIONS: ClarifyDirective[] = ['continue', 'stop']

export function ClarifyDirectiveToggle({ data }: { data: CanvasNodeData }) {
  const { t } = useTranslation()
  const current = data.clarifyDirective
  if (current === undefined) return null
  const onToggle = data.onClarifyDirectiveToggle
  const stop = (e: MouseEvent) => e.stopPropagation()
  return (
    <div
      className="canvas-node__clarify-directive segmented"
      role="radiogroup"
      aria-label={t('clarifyDirective.groupLabel')}
      data-testid={`canvas-clarify-directive-${data.nodeId}`}
      onMouseDown={stop}
      onClick={stop}
    >
      {OPTIONS.map((opt) => {
        const active = opt === current
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            data-directive={opt}
            className={`segmented__option ${active ? 'segmented__option--active' : ''}`.trim()}
            onClick={(e) => {
              stop(e)
              if (!active) onToggle?.(data.nodeId, opt)
            }}
          >
            {t(`clarifyDirective.${opt}`)}
          </button>
        )
      })}
    </div>
  )
}
