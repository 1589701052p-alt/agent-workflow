// RFC-083 PR-D — structural (semantic) diff view. The textual diff's overlay:
// summary cards + dependency changes + a per-file collapsible structural tree
// with +/~/− badges. Pure aggregation/grouping lives in lib/structureView.ts;
// this file is JSX wiring reusing existing public primitives + diff CSS colors.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  StructuralDiff,
  FileStructuralDiff,
  DependencyChange,
  StructuralDiffSummary,
  SymbolChange,
  HunkAnchor,
  ImpactItem,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import {
  summaryRows,
  groupFileChanges,
  displayableFiles,
  badgeClass,
  badgeSymbol,
  type SummaryRow,
} from '@/lib/structureView'
import { StructuralGraph } from './StructuralGraph'

// degradedReasons that mean "deep was requested but fell back to baseline".
const DEEP_FALLBACK_REASONS = new Set<string>([
  'indexer-missing',
  'build-failed',
  'timeout',
  'scip-parse-error',
])

const CARD_LABEL_KEY: Record<SummaryRow['key'], string> = {
  classes: 'tasks.structCardClasses',
  methods: 'tasks.structCardMethods',
  fields: 'tasks.structCardFields',
  imports: 'tasks.structCardImports',
  dependencies: 'tasks.structCardDependencies',
}

export function StructuralDiffView({
  data,
  onJumpToHunk,
}: {
  data: StructuralDiff
  /** Jump to the textual diff for a symbol (text↔structure cross-nav). */
  onJumpToHunk?: (anchor: HunkAnchor) => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'tree' | 'graph'>('tree')
  const files = displayableFiles(data.files)
  const hasContent = files.length > 0 || data.dependencyChanges.length > 0
  if (!hasContent) {
    if (data.degradedReason === 'snapshot-pruned') {
      return <EmptyState title={t('tasks.structPruned')} />
    }
    if (data.degradedReason === 'readonly-node-no-snapshot') {
      return <EmptyState title={t('tasks.structReadonlyNode')} />
    }
    return <EmptyState title={t('tasks.structEmpty')} />
  }
  const degraded = data.files.some((f) => f.status === 'degraded')
  const deepFellBack =
    data.engine === 'baseline' && DEEP_FALLBACK_REASONS.has(data.degradedReason ?? '')
  return (
    <div className="structure">
      {deepFellBack && (
        <div className="structure__banner" role="status">
          {t('tasks.structDegradedDeepFallback')}
        </div>
      )}
      {degraded && (
        <div className="structure__banner" role="status">
          {t('tasks.structDegradedBanner')}
        </div>
      )}
      <StructuralSummaryCards summary={data.summary} />
      {data.dependencyChanges.length > 0 && (
        <DependencyChangesPanel changes={data.dependencyChanges} />
      )}
      {data.impact.length > 0 && <ImpactPanel impact={data.impact} />}
      {files.length > 0 && (
        <div className="structure__detail">
          <div
            className="segmented structure__view-toggle"
            role="radiogroup"
            aria-label={t('tasks.structViewLabel')}
          >
            {(['tree', 'graph'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                className={`segmented__option ${view === v ? 'segmented__option--active' : ''}`}
                onClick={() => setView(v)}
              >
                {v === 'tree' ? t('tasks.structViewTree') : t('tasks.structViewGraph')}
              </button>
            ))}
          </div>
          {view === 'tree' ? (
            <StructuralTree files={files} onJumpToHunk={onJumpToHunk} />
          ) : (
            <StructuralGraph data={data} />
          )}
        </div>
      )}
    </div>
  )
}

/** Parse the readable symbol name out of a SymbolNode id
 *  (`filePath#qualifiedName:kind:line`). */
function symbolName(id: string | undefined): string {
  if (id === undefined) return '?'
  const afterHash = id.includes('#') ? (id.split('#')[1] ?? id) : id
  return afterHash.split(':')[0] ?? afterHash
}

function ImpactPanel({ impact }: { impact: ImpactItem[] }) {
  const { t } = useTranslation()
  // Precise (deep/SCIP) when any item is 'extracted'; else heuristic (baseline).
  const precise = impact.some((i) => i.confidence === 'extracted')
  return (
    <div className="structure__impact">
      <div className="structure__impact-header">
        {t('tasks.structImpactHeader')}
        <span className="structure__tag">
          {precise ? t('tasks.structImpactExtracted') : t('tasks.structImpactInferred')}
        </span>
      </div>
      <ul className="structure__impact-list">
        {impact.map((it, i) => (
          <li key={`${it.changedSymbolId}-${i}`} className="structure__impact-item">
            <span className="structure__impact-target">{symbolName(it.changedSymbolId)}</span>
            <span className="structure__impact-arrow">←</span>
            <span className="structure__impact-callers">
              {it.callers.map((c) => symbolName(c.symbolId) || c.filePath).join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StructuralSummaryCards({ summary }: { summary: StructuralDiffSummary }) {
  const { t } = useTranslation()
  const rows = summaryRows(summary)
  return (
    <div className="structure__cards">
      <div className="structure__card">
        <span className="structure__card-count">{summary.files}</span>
        <span className="structure__card-label">{t('tasks.structCardFiles')}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="structure__card">
          <span className="structure__card-label">{t(CARD_LABEL_KEY[r.key])}</span>
          <span className="structure__card-counts">
            {r.count.added > 0 && (
              <span className="structure__delta structure__delta--added">+{r.count.added}</span>
            )}
            {r.count.modified > 0 && (
              <span className="structure__delta structure__delta--modified">
                ~{r.count.modified}
              </span>
            )}
            {r.count.removed > 0 && (
              <span className="structure__delta structure__delta--removed">−{r.count.removed}</span>
            )}
            {r.count.renamed > 0 && (
              <span className="structure__delta structure__delta--renamed">→{r.count.renamed}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function DependencyChangesPanel({ changes }: { changes: DependencyChange[] }) {
  const { t } = useTranslation()
  return (
    <div className="structure__deps">
      <div className="structure__deps-header">{t('tasks.structDepsHeader')}</div>
      <ul className="structure__deps-list">
        {changes.map((d, i) => {
          const ct: SymbolChange['changeType'] =
            d.changeType === 'updated' ? 'modified' : d.changeType
          return (
            <li key={`${d.ecosystem}:${d.packageName}:${i}`} className="structure__dep">
              <span className={badgeClass(ct)} aria-label={d.changeType}>
                {badgeSymbol(ct)}
              </span>
              <span className="structure__dep-eco">{d.ecosystem}</span>
              <span className="structure__dep-name">{d.packageName}</span>
              {d.versionBefore !== undefined && d.versionAfter !== undefined ? (
                <span className="structure__dep-ver">
                  {d.versionBefore} → {d.versionAfter}
                </span>
              ) : d.versionAfter !== undefined ? (
                <span className="structure__dep-ver">{d.versionAfter}</span>
              ) : null}
              {d.viaManifest && d.viaImport && (
                <span className="structure__tag">{t('tasks.structViaImportManifest')}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StructuralTree({
  files,
  onJumpToHunk,
}: {
  files: FileStructuralDiff[]
  onJumpToHunk?: (anchor: HunkAnchor) => void
}) {
  const { t } = useTranslation()
  const [sel, setSel] = useState(0)
  const idx = Math.min(sel, files.length - 1)
  const selected = files[idx]
  return (
    <div className="structure__tree">
      <aside className="structure__files">
        <nav role="tablist" aria-orientation="vertical" className="structure__tablist">
          {files.map((f, i) => (
            <button
              type="button"
              key={f.filePath}
              role="tab"
              aria-selected={i === idx}
              title={f.filePath}
              className={`structure__file-tab ${i === idx ? 'structure__file-tab--active' : ''}`}
              onClick={() => setSel(i)}
            >
              <span className="structure__file-name">{f.filePath}</span>
              {f.status === 'degraded' && (
                <span className="structure__chip" title={t('tasks.structDegradedBanner')}>
                  {t('tasks.structDegradedChip')}
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <section className="structure__body">
        {selected !== undefined && <FileChanges file={selected} onJumpToHunk={onJumpToHunk} />}
      </section>
    </div>
  )
}

function FileChanges({
  file,
  onJumpToHunk,
}: {
  file: FileStructuralDiff
  onJumpToHunk?: (anchor: HunkAnchor) => void
}) {
  const { t } = useTranslation()
  if (file.status === 'parse-error') {
    return <div className="structure__muted muted">{t('tasks.structParseError')}</div>
  }
  const groups = groupFileChanges(file)
  if (groups.length === 0) {
    return <div className="structure__muted muted">{t('tasks.structFileNoSymbolChanges')}</div>
  }
  return (
    <div className="structure__changes">
      {groups.map((g) => (
        <div key={g.container || '__top__'} className="structure__group">
          {g.container !== '' && <div className="structure__group-header">{g.container}</div>}
          <ul className="structure__symbols">
            {g.changes.map((ch, i) => {
              const node = ch.after ?? ch.before
              const jumpable = onJumpToHunk !== undefined && ch.hunkAnchor !== undefined
              const body = (
                <>
                  <span className={badgeClass(ch.changeType)} aria-label={ch.changeType}>
                    {badgeSymbol(ch.changeType)}
                  </span>
                  <span className="structure__symbol-kind">{node?.kind}</span>
                  <span className="structure__symbol-name">
                    {node?.name ?? node?.qualifiedName}
                  </span>
                  {(ch.changeType === 'renamed' || ch.changeType === 'moved') &&
                    ch.renamedFrom !== undefined && (
                      <span className="structure__symbol-from">
                        {t('tasks.structRenamedFrom', { from: ch.renamedFrom })}
                      </span>
                    )}
                  {ch.signatureChanged === true && (
                    <span className="structure__tag">{t('tasks.structSigChanged')}</span>
                  )}
                  {ch.bodyDelta !== undefined && (
                    <span className="structure__body-delta" title={t('tasks.structBodyDeltaTitle')}>
                      {ch.bodyDelta.added > 0 && (
                        <span className="structure__body-delta-add">+{ch.bodyDelta.added}</span>
                      )}
                      {ch.bodyDelta.removed > 0 && (
                        <span className="structure__body-delta-del">−{ch.bodyDelta.removed}</span>
                      )}
                    </span>
                  )}
                </>
              )
              return (
                <li key={`${node?.qualifiedName ?? '?'}-${i}`} className="structure__symbol">
                  {jumpable ? (
                    <button
                      type="button"
                      className="structure__symbol-jump"
                      title={t('tasks.structJumpToDiff')}
                      onClick={() => onJumpToHunk(ch.hunkAnchor as HunkAnchor)}
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
