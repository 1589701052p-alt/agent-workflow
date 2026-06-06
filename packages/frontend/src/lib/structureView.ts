// RFC-083 PR-D — pure helpers for the structural-diff view. Kept out of the
// components so the aggregation / grouping / badge mapping get unit coverage.

import type {
  FileStructuralDiff,
  SymbolChange,
  StructuralDiffSummary,
  ChangeCount,
} from '@agent-workflow/shared'

export function changeTotal(c: ChangeCount): number {
  return c.added + c.modified + c.removed + c.renamed
}

export interface SummaryRow {
  key: 'classes' | 'methods' | 'fields' | 'imports' | 'dependencies'
  count: ChangeCount
  total: number
}

/** Ordered summary-card rows (skipping empty categories). */
export function summaryRows(s: StructuralDiffSummary): SummaryRow[] {
  const rows: Array<{ key: SummaryRow['key']; count: ChangeCount }> = [
    { key: 'classes', count: s.classes },
    { key: 'methods', count: s.methods },
    { key: 'fields', count: s.fields },
    { key: 'imports', count: s.imports },
    { key: 'dependencies', count: s.dependencies },
  ]
  return rows.map((r) => ({ ...r, total: changeTotal(r.count) })).filter((r) => r.total > 0)
}

export interface ChangeGroup {
  /** Container qualifiedName (e.g. `OrderService`), or '' for top-level. */
  container: string
  changes: SymbolChange[]
}

/** Group a file's symbol changes by their enclosing container (the qualifiedName
 *  prefix before the last segment), top-level symbols under ''. */
export function groupFileChanges(file: FileStructuralDiff): ChangeGroup[] {
  const groups = new Map<string, SymbolChange[]>()
  for (const ch of file.changes) {
    const node = ch.after ?? ch.before
    const qn = node?.qualifiedName ?? ''
    const dot = qn.lastIndexOf('.')
    const container = dot > 0 ? qn.slice(0, dot) : ''
    const arr = groups.get(container)
    if (arr === undefined) groups.set(container, [ch])
    else arr.push(ch)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([container, changes]) => ({ container, changes }))
}

/** Files worth showing in the left list: those with changes, or a non-ok status
 *  worth surfacing (degraded / parse-error). */
export function displayableFiles(files: FileStructuralDiff[]): FileStructuralDiff[] {
  return files.filter(
    (f) => f.changes.length > 0 || f.status === 'degraded' || f.status === 'parse-error',
  )
}

export function badgeClass(changeType: SymbolChange['changeType']): string {
  switch (changeType) {
    case 'added':
      return 'structure__badge structure__badge--added'
    case 'removed':
      return 'structure__badge structure__badge--removed'
    case 'modified':
      return 'structure__badge structure__badge--modified'
    default:
      return 'structure__badge structure__badge--renamed' // renamed | moved
  }
}

export function badgeSymbol(changeType: SymbolChange['changeType']): string {
  switch (changeType) {
    case 'added':
      return '+'
    case 'removed':
      return '−' // minus sign
    case 'modified':
      return '~'
    default:
      return '→' // → (renamed/moved)
  }
}
