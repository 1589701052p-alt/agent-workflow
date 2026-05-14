// Renders unified-diff text as a list of colored lines. Splits the diff into
// per-file hunks based on `diff --git a/... b/...` markers so very long
// diffs are still navigable.
//
// Real syntax highlighting + collapsible files lands in a M5 polish issue.

import { useMemo } from 'react'

interface DiffViewerProps {
  diff: string
  truncated?: boolean
}

interface FileBlock {
  header: string
  lines: string[]
}

export function DiffViewer({ diff, truncated }: DiffViewerProps) {
  const blocks = useMemo(() => splitByFile(diff), [diff])

  if (diff.trim() === '') {
    return <div className="diff diff--empty muted">No changes since the task started.</div>
  }

  return (
    <div className="diff">
      {truncated === true && (
        <div className="diff__truncated">
          ⚠ Diff truncated at 1 MiB. View the worktree directly for the full output.
        </div>
      )}
      {blocks.map((b, i) => (
        <section key={`${b.header}-${i}`} className="diff__file">
          <div className="diff__file-header">{b.header}</div>
          <pre className="diff__body">
            {b.lines.map((line, j) => (
              <span key={j} className={lineClass(line)}>
                {line === '' ? ' ' : line}
                {'\n'}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  )
}

function splitByFile(diff: string): FileBlock[] {
  const lines = diff.split('\n')
  const out: FileBlock[] = []
  let current: FileBlock | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) out.push(current)
      current = { header: deriveFileHeader(line), lines: [line] }
      continue
    }
    if (current === null) {
      current = { header: '(preamble)', lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  if (current !== null) out.push(current)
  return out
}

function deriveFileHeader(diffLine: string): string {
  // `diff --git a/path b/path`
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(diffLine)
  if (m === null) return diffLine
  const [, from, to] = m
  return from === to ? (from ?? diffLine) : `${from ?? ''} → ${to ?? ''}`
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff__meta'
  if (line.startsWith('@@')) return 'diff__hunk'
  if (line.startsWith('+')) return 'diff__add'
  if (line.startsWith('-')) return 'diff__del'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity ') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to')
  )
    return 'diff__meta'
  return 'diff__ctx'
}

export const __testSplitByFile = splitByFile
export const __testLineClass = lineClass
