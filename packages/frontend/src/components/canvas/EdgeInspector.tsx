// Right-side drawer pane for editing a single canvas edge.
//
// Per design (proposal §3.5 / §4.2 / §4.3 + design.md:510), the edge's
// `target.portName` is what determines the input port a downstream agent
// sees. The default at drop time is `source.portName` (RFC-003); this
// pane lets users rename it later — covering the YAML example
// `in_1.out → worker_1.requirement` without falling back to YAML import.

import type { WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Field } from '@/components/Form'

interface Props {
  edge: WorkflowEdge
  definition: WorkflowDefinition
  onChange: (next: WorkflowDefinition) => void
  onClose: () => void
}

export function EdgeInspector({ edge, definition, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const [draftPort, setDraftPort] = useState(edge.target.portName)
  const [conflict, setConflict] = useState<string | null>(null)

  // Reset draft when xyflow swaps the selection to a different edge.
  useEffect(() => {
    setDraftPort(edge.target.portName)
    setConflict(null)
  }, [edge.id, edge.target.portName])

  function commit() {
    const trimmed = draftPort.trim()
    if (trimmed === '' || trimmed === edge.target.portName) {
      setConflict(null)
      return
    }
    if (hasConflict(definition, edge, trimmed)) {
      setConflict(t('inspector.edgeConflictMsg'))
      return
    }
    setConflict(null)
    onChange({
      ...definition,
      edges: definition.edges.map((e) =>
        e.id === edge.id ? { ...e, target: { ...e.target, portName: trimmed } } : e,
      ),
    })
  }

  function remove() {
    onChange({
      ...definition,
      edges: definition.edges.filter((e) => e.id !== edge.id),
    })
    onClose()
  }

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div className="inspector__kind">{t('inspector.edgeTitle')}</div>
          <div className="inspector__id">
            <code>{edge.id}</code>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inspector__close"
          aria-label={t('inspector.closeAria')}
        >
          ×
        </button>
      </header>
      <div className="inspector__body">
        <div className="form-grid">
          <Field label={t('inspector.edgeSourceLabel')}>
            <code className="form-input form-input--mono">
              {edge.source.nodeId}.{edge.source.portName}
            </code>
          </Field>
          <Field label={t('inspector.edgeTargetLabel')}>
            <code className="form-input form-input--mono">
              {edge.target.nodeId}
            </code>
          </Field>
          <Field label={t('inspector.edgePortNameLabel')}>
            <input
              className="form-input form-input--mono"
              value={draftPort}
              onChange={(e) => setDraftPort(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            {conflict !== null && <div className="error-box">{conflict}</div>}
          </Field>
          <button type="button" className="btn btn--sm btn--danger" onClick={remove}>
            {t('inspector.edgeDeleteBtn')}
          </button>
        </div>
      </div>
    </aside>
  )
}

/**
 * Returns true if renaming `edge.target.portName` to `next` would collide
 * with an existing edge that has the same (source.nodeId, source.portName,
 * target.nodeId, next portName) tuple — `buildEdgeFromConnection` already
 * rejects exact duplicates at create time, and we mirror that here so a
 * rename can't smuggle one in. Same target.nodeId + same name from a
 * different source is the legitimate fan-in case (proposal §4.2) and not
 * a conflict.
 *
 * Exported for unit tests.
 */
export function hasConflict(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
  next: string,
): boolean {
  return def.edges.some(
    (e) =>
      e.id !== edge.id &&
      e.source.nodeId === edge.source.nodeId &&
      e.source.portName === edge.source.portName &&
      e.target.nodeId === edge.target.nodeId &&
      e.target.portName === next,
  )
}
