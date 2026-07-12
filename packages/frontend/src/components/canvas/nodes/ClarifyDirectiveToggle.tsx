// RFC-122 — on-canvas per-(task, asking-node) clarify directive toggle
// ("继续反问 / 停止反问"). Rendered by AgentNode for asking-agent nodes on the
// task-detail canvas only (data.clarifyDirective !== undefined). Reuses the
// shared <Segmented> primitive (CLAUDE.md UI consistency — no hand-rolled
// chrome) so it matches the LanguageSwitch / NodeInspector segmented controls.
//
// Clicking the inactive half fires data.onClarifyDirectiveToggle(nodeId, next);
// the parent POSTs + invalidates and the new directive flows back through
// data.clarifyDirective. stopPointerPropagation keeps a click off the
// node-select / no node drag (the task canvas is readOnly anyway) — Segmented
// stops BOTH mouseDown and click, and clicking the active half is a no-op
// (radio semantics), so the current directive is never re-POSTed. Renders
// nothing when the directive is undefined, so a canvas with no directives is
// byte-for-byte unchanged (golden-lock).

import { useTranslation } from 'react-i18next'
import type { ClarifyDirective } from '@agent-workflow/shared'
import { Segmented } from '@/components/Segmented'
import type { CanvasNodeData } from './types'

const OPTIONS: ClarifyDirective[] = ['continue', 'stop']

export function ClarifyDirectiveToggle({ data }: { data: CanvasNodeData }) {
  const { t } = useTranslation()
  const current = data.clarifyDirective
  if (current === undefined) return null
  const onToggle = data.onClarifyDirectiveToggle
  return (
    <Segmented<ClarifyDirective>
      value={current}
      onChange={(next) => onToggle?.(data.nodeId, next)}
      options={OPTIONS.map((opt) => ({
        value: opt,
        label: t(`clarifyDirective.${opt}`),
        data: { directive: opt },
      }))}
      ariaLabel={t('clarifyDirective.groupLabel')}
      className="canvas-node__clarify-directive"
      rootTestid={`canvas-clarify-directive-${data.nodeId}`}
      stopPointerPropagation
    />
  )
}
