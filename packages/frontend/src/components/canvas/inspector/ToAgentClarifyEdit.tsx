// RFC-W004 to-agent clarify node inspector - title + description (same as
// RFC-023/056) plus a segmented `sessionModeForAnswerer` selector. Mirrors the
// cross-clarify inspector's read-only status fields so the two panels stay
// visually aligned: linked questioner (B) / linked answerer (A) /
// wrapper-loop containment. Extracted from the NodeInspector EditForm switch
// (which previously fell back to CrossClarifyEdit as a T1 placeholder).

import type { WorkflowNode } from '@agent-workflow/shared'
import { findAnswererNodeForToAgent, findQuestionerNodeForToAgent } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, TextArea } from '@/components/Form'
import { Segmented } from '@/components/Segmented'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function ToAgentClarifyEdit({ node, definition, onPatch }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const description = typeof rec.description === 'string' ? rec.description : ''
  const sessionModeForAnswerer =
    typeof rec.sessionModeForAnswerer === 'string' &&
    (rec.sessionModeForAnswerer === 'inline' || rec.sessionModeForAnswerer === 'isolated')
      ? (rec.sessionModeForAnswerer as 'inline' | 'isolated')
      : 'isolated'

  // Linked questioner (B) via B.__clarify__ -> to-agent.questions (auto-edge),
  // and linked answerer (A) via to-agent.to_answerer -> A.__clarify_request__
  // (manual edge) - same data source the validator and runtime use.
  const linkedQuestionerId = findQuestionerNodeForToAgent(definition, node.id) ?? null
  const linkedAnswererId = findAnswererNodeForToAgent(definition, node.id) ?? null

  // wrapper-loop containment, identical to the cross-clarify branch.
  const enclosingLoop = definition.nodes.find((n) => {
    if (n.kind !== 'wrapper-loop') return false
    const ids = (n as Record<string, unknown>).nodeIds
    return Array.isArray(ids) && ids.includes(node.id)
  })
  const inLoop = enclosingLoop !== undefined

  function patchToAgentClarify(delta: Record<string, unknown>): void {
    onPatch({ ...(node as Record<string, unknown>), ...delta } as unknown as WorkflowNode)
  }

  return (
    <div className="form-grid" data-testid="to-agent-clarify-inspector">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field
        label={t('inspector.fieldClarifyDescription')}
        hint={t('inspector.fieldClarifyDescriptionHint')}
      >
        <TextArea
          value={description}
          rows={2}
          onChange={(v) => patchToAgentClarify({ description: v })}
        />
      </Field>
      <Field label={t('clarifyToAgent.inspector.fieldLinkedQuestioner')}>
        {linkedQuestionerId !== null ? (
          <div className="inspector__readonly">
            <code data-testid="to-agent-linked-questioner">{linkedQuestionerId}</code>
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--error"
            data-testid="to-agent-linked-questioner-missing"
          >
            {t('clarifyToAgent.inspector.linkedQuestionerMissing')}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('clarifyToAgent.inspector.linkedQuestionerHint')}
        </p>
      </Field>
      <Field label={t('clarifyToAgent.inspector.fieldLinkedAnswerer')}>
        {linkedAnswererId !== null ? (
          <div className="inspector__readonly">
            <code data-testid="to-agent-linked-answerer">{linkedAnswererId}</code>
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--error"
            data-testid="to-agent-linked-answerer-missing"
          >
            {t('clarifyToAgent.inspector.linkedAnswererMissing')}
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('clarifyToAgent.inspector.linkedAnswererHint')}
        </p>
      </Field>
      <Field label={t('clarifyToAgent.inspector.fieldInLoop')}>
        {inLoop ? (
          <div className="inspector__readonly" data-testid="to-agent-in-loop">
            {t('clarifyToAgent.inspector.inLoopYes')}
          </div>
        ) : (
          <div
            className="inspector__readonly inspector__readonly--warning"
            data-testid="to-agent-in-loop-warning"
          >
            {t('clarifyToAgent.inspector.inLoopNo')}
          </div>
        )}
      </Field>
      <Field
        label={t('clarifyToAgent.inspector.sessionModeForAnswerer')}
        hint={t('clarifyToAgent.inspector.sessionModeHint')}
        group
      >
        <Segmented<'isolated' | 'inline'>
          value={sessionModeForAnswerer}
          onChange={(mode) => patchToAgentClarify({ sessionModeForAnswerer: mode })}
          allowActiveReselect
          options={(['isolated', 'inline'] as const).map((mode) => ({
            value: mode,
            label:
              mode === 'isolated'
                ? t('clarifyToAgent.inspector.sessionModeIsolated')
                : t('clarifyToAgent.inspector.sessionModeInline'),
          }))}
          ariaLabel={t('clarifyToAgent.inspector.sessionModeForAnswerer')}
          testidPrefix="to-agent-session-mode-answerer"
        />
      </Field>
    </div>
  )
}
