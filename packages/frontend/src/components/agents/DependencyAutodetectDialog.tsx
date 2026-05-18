// RFC-038 — Dialog that displays detected dependency candidates grouped by
// kind (agents / skills / mcps / plugins). User toggles checkboxes; on
// "Import selected" the parent receives a DepSelection and merges it.
//
// Sections with zero candidates are hidden. If every group is empty, an
// EmptyState replaces the body and the footer collapses to a single Close
// button. Inventory groups that failed to load come in via `loadFailures`
// and surface as a muted footer note (per RFC-038 §5 AC-8).

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import type {
  DepSelection,
  DetectionGroup,
  DetectionGroupKey,
  DetectionResult,
} from '@/lib/agent-dep-detect'
import { totalCandidates } from '@/lib/agent-dep-detect'

export interface DependencyAutodetectDialogProps {
  open: boolean
  result: DetectionResult
  loadFailures: readonly DetectionGroupKey[]
  onApply: (selection: DepSelection) => void
  onClose: () => void
}

const GROUP_KEYS: readonly DetectionGroupKey[] = ['agents', 'skills', 'mcps', 'plugins']

function buildInitialSelected(result: DetectionResult): Record<DetectionGroupKey, Set<string>> {
  return {
    agents: new Set(result.agents.candidates.map((c) => c.name)),
    skills: new Set(result.skills.candidates.map((c) => c.name)),
    mcps: new Set(result.mcps.candidates.map((c) => c.name)),
    plugins: new Set(result.plugins.candidates.map((c) => c.name)),
  }
}

function countSelected(selected: Record<DetectionGroupKey, Set<string>>): number {
  return selected.agents.size + selected.skills.size + selected.mcps.size + selected.plugins.size
}

interface SectionProps {
  group: DetectionGroupKey
  data: DetectionGroup
  selected: Set<string>
  onToggle: (name: string) => void
}

function Section({ group, data, selected, onToggle }: SectionProps): ReactElement | null {
  const { t } = useTranslation()
  if (data.candidates.length === 0) return null
  return (
    <section className="agent-dep-autodetect__section" data-testid={`autodetect-section-${group}`}>
      <h3 className="agent-dep-autodetect__section-title">
        {t(`agentForm.autodetect.section.${group}`, { count: data.candidates.length })}
      </h3>
      <ul className="agent-dep-autodetect__list">
        {data.candidates.map((row) => {
          const checked = selected.has(row.name)
          return (
            <li key={row.name}>
              <label className="agent-dep-autodetect__row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(row.name)}
                  data-testid={`autodetect-checkbox-${group}-${row.name}`}
                />
                <span className="agent-dep-autodetect__name">{row.name}</span>
                {row.description !== undefined &&
                  row.description !== null &&
                  row.description !== '' && (
                    <span className="agent-dep-autodetect__desc"> — {row.description}</span>
                  )}
              </label>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function DependencyAutodetectDialog(
  props: DependencyAutodetectDialogProps,
): ReactElement | null {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<DetectionGroupKey, Set<string>>>(() =>
    buildInitialSelected(props.result),
  )

  // Re-seed selection whenever the dialog opens with a fresh detection result.
  useEffect(() => {
    if (props.open) {
      setSelected(buildInitialSelected(props.result))
    }
  }, [props.open, props.result])

  const total = totalCandidates(props.result)
  const hasAnyCandidate = total > 0
  const selectedCount = useMemo(() => countSelected(selected), [selected])

  const toggle = (group: DetectionGroupKey, name: string) => {
    setSelected((prev) => {
      const next = { ...prev, [group]: new Set(prev[group]) }
      if (next[group].has(name)) {
        next[group].delete(name)
      } else {
        next[group].add(name)
      }
      return next
    })
  }

  const apply = () => {
    props.onApply({
      agents: Array.from(selected.agents),
      skills: Array.from(selected.skills),
      mcps: Array.from(selected.mcps),
      plugins: Array.from(selected.plugins),
    })
  }

  const footer = hasAnyCandidate ? (
    <>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={props.onClose}
        data-testid="autodetect-cancel"
      >
        {t('agentForm.autodetect.cancelButton')}
      </button>
      <button
        type="button"
        className="btn btn--primary"
        onClick={apply}
        disabled={selectedCount === 0}
        data-testid="autodetect-apply"
      >
        {t('agentForm.autodetect.applyButton', { count: selectedCount })}
      </button>
    </>
  ) : (
    <button
      type="button"
      className="btn btn--primary"
      onClick={props.onClose}
      data-testid="autodetect-close"
    >
      {t('agentForm.autodetect.closeButton')}
    </button>
  )

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('agentForm.autodetect.dialogTitle')}
      size="md"
      data-testid="agent-dep-autodetect-dialog"
      footer={footer}
    >
      {hasAnyCandidate ? (
        <>
          <p className="muted agent-dep-autodetect__hint">{t('agentForm.autodetect.dialogHint')}</p>
          {GROUP_KEYS.map((g) => (
            <Section
              key={g}
              group={g}
              data={props.result[g]}
              selected={selected[g]}
              onToggle={(name) => toggle(g, name)}
            />
          ))}
        </>
      ) : (
        <EmptyState title={t('agentForm.autodetect.emptyText')} size="compact" />
      )}
      {props.loadFailures.length > 0 && (
        <ul className="agent-dep-autodetect__failures">
          {props.loadFailures.map((g) => (
            <li key={g} className="muted">
              {t('agentForm.autodetect.groupLoadFailed', {
                group: t(`agentForm.autodetect.groupName.${g}`),
              })}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
