// RFC-065 — task detail page "工作目录" tab.
//
// Two-column layout: left side is a lazy-loaded directory tree (folders
// collapsed by default, click to expand/collapse), right side renders the
// selected file's content as plain text inside a <pre>. Files > 2 MiB are
// not previewed — the server returns oversized:true and the panel shows a
// human-readable hint with the real byte count.
//
// State is intentionally kept inside the panel (not lifted to the page
// route) so switching to another tab and back preserves the user's
// expand/select state for the lifetime of the task-detail mount.

import { useMemo, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import {
  WORKTREE_DIR_MAX_ENTRIES,
  WORKTREE_FILE_MAX_BYTES,
  worktreeFileResponseSchema,
  worktreeTreeResponseSchema,
  type WorktreeFileResponse,
  type WorktreeTreeEntry,
  type WorktreeTreeResponse,
} from '@agent-workflow/shared'

// ---------- pure helpers (exported for unit tests) ----------

/** Format a byte count into a short human-readable string. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n} B`
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`
}

/** Join a parent rel-path and a child name into a posix rel-path. */
export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

// ---------- API client wrappers ----------

async function fetchTree(
  taskId: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorktreeTreeResponse> {
  const raw = await api.get<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/worktree-tree`,
    { path },
    signal,
  )
  return worktreeTreeResponseSchema.parse(raw)
}

async function fetchFile(
  taskId: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorktreeFileResponse> {
  const raw = await api.get<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/worktree-file`,
    { path },
    signal,
  )
  return worktreeFileResponseSchema.parse(raw)
}

// ---------- Components ----------

export function WorktreeFilesPanel({ taskId }: { taskId: string }): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // expand state lives here so it survives subtree unmount/remount as the
  // user collapses/expands intermediate folders.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  function toggle(relPath: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  // The tree + file queries use staleTime/gcTime Infinity (intentional — see
  // DirChildren below). That means data fetched while the worktree was empty
  // is otherwise stuck forever. Refresh invalidates every cached tree level
  // for this task plus the currently previewed file.
  function refresh(): void {
    void qc.invalidateQueries({ queryKey: ['worktreeTree', taskId] })
    void qc.invalidateQueries({ queryKey: ['worktreeFile', taskId] })
  }

  return (
    <div className="worktree-files-panel" data-testid="worktree-files-panel">
      <div className="worktree-files-panel__tree">
        <div className="worktree-files-panel__tree-header">
          <button
            type="button"
            className="btn btn--sm"
            onClick={refresh}
            data-testid="worktree-files-refresh"
          >
            {t('tasks.worktreeFilesRefresh')}
          </button>
        </div>
        <div className="worktree-files-panel__tree-body" role="tree" aria-label="worktree files">
          <DirChildren
            taskId={taskId}
            dirPath=""
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            selectedPath={selectedPath}
            onSelectFile={setSelectedPath}
          />
        </div>
      </div>
      <div className="worktree-files-panel__preview">
        <WorktreeFilePreview taskId={taskId} path={selectedPath} />
      </div>
    </div>
  )
}

interface DirChildrenProps {
  taskId: string
  dirPath: string
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function DirChildren(props: DirChildrenProps): ReactElement {
  const { t } = useTranslation()
  const q = useQuery<WorktreeTreeResponse>({
    queryKey: ['worktreeTree', props.taskId, props.dirPath],
    queryFn: ({ signal }) => fetchTree(props.taskId, props.dirPath, signal),
    // Cache forever within this mount — collapsing and re-expanding a folder
    // should not re-hit the server (RFC-065 acceptance §3). Worktrees do
    // change as the worker writes files, but a refresh requires leaving
    // the tab and coming back; that re-mount busts the cache naturally.
    staleTime: Infinity,
    gcTime: Infinity,
  })

  if (q.isLoading) {
    return (
      <div className="worktree-files-tree__loading" style={{ paddingLeft: indentFor(props.depth) }}>
        <LoadingState size="compact" />
      </div>
    )
  }
  if (q.error !== null && q.error !== undefined) {
    return (
      <div className="worktree-files-tree__error" style={{ paddingLeft: indentFor(props.depth) }}>
        <ErrorBanner error={q.error} />
      </div>
    )
  }
  const data = q.data
  if (data === undefined) return <></>

  return (
    <ul className="worktree-files-tree__list" role="group">
      {data.entries.map((entry) => (
        <TreeEntry
          key={entry.name}
          parentPath={props.dirPath}
          entry={entry}
          depth={props.depth}
          expanded={props.expanded}
          onToggle={props.onToggle}
          selectedPath={props.selectedPath}
          onSelectFile={props.onSelectFile}
          taskId={props.taskId}
        />
      ))}
      {data.truncated && (
        <li
          className="worktree-files-tree__row worktree-files-tree__row--truncated"
          style={{ paddingLeft: indentFor(props.depth + 1) }}
        >
          {t('tasks.worktreeFilesTruncated', { limit: WORKTREE_DIR_MAX_ENTRIES })}
        </li>
      )}
    </ul>
  )
}

interface TreeEntryProps {
  taskId: string
  parentPath: string
  entry: WorktreeTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  selectedPath: string | null
  onSelectFile: (path: string) => void
}

function TreeEntry(props: TreeEntryProps): ReactElement {
  const { entry, depth, parentPath } = props
  const rel = joinRel(parentPath, entry.name)
  if (entry.kind === 'directory') {
    const isOpen = props.expanded.has(rel)
    return (
      <li role="treeitem" aria-expanded={isOpen}>
        <button
          type="button"
          className="worktree-files-tree__row worktree-files-tree__row--dir"
          style={{ paddingLeft: indentFor(depth) }}
          onClick={() => props.onToggle(rel)}
          data-testid={`worktree-tree-dir-${rel}`}
        >
          <span className="worktree-files-tree__caret" aria-hidden>
            {isOpen ? '▾' : '▸'}
          </span>
          <span className="worktree-files-tree__name">{entry.name}</span>
        </button>
        {isOpen && (
          <DirChildren
            taskId={props.taskId}
            dirPath={rel}
            depth={depth + 1}
            expanded={props.expanded}
            onToggle={props.onToggle}
            selectedPath={props.selectedPath}
            onSelectFile={props.onSelectFile}
          />
        )}
      </li>
    )
  }
  const isSelected = props.selectedPath === rel
  return (
    <li role="treeitem">
      <button
        type="button"
        className={
          'worktree-files-tree__row worktree-files-tree__row--file' +
          (isSelected ? ' is-selected' : '')
        }
        style={{ paddingLeft: indentFor(depth) }}
        aria-pressed={isSelected}
        onClick={() => props.onSelectFile(rel)}
        data-testid={`worktree-tree-file-${rel}`}
      >
        <span className="worktree-files-tree__name">{entry.name}</span>
      </button>
    </li>
  )
}

function indentFor(depth: number): string {
  // 16px per level keeps deep nesting readable without overflowing the
  // 220-320px tree column.
  return `${depth * 16}px`
}

export function WorktreeFilePreview({
  taskId,
  path,
}: {
  taskId: string
  path: string | null
}): ReactElement {
  const { t } = useTranslation()
  const enabled = path !== null
  const q = useQuery<WorktreeFileResponse>({
    queryKey: ['worktreeFile', taskId, path],
    queryFn: ({ signal }) => fetchFile(taskId, path as string, signal),
    enabled,
    staleTime: 0,
  })

  const sizeLabelData = useMemo(
    () => (q.data === undefined ? null : formatBytes(q.data.size)),
    [q.data],
  )

  if (path === null) {
    return (
      <div className="worktree-files-preview__empty" data-testid="worktree-files-preview-empty">
        <p className="muted">{t('tasks.worktreeFilesEmpty')}</p>
      </div>
    )
  }
  if (q.isLoading) return <LoadingState size="compact" />
  if (q.error !== null && q.error !== undefined) return <ErrorBanner error={q.error} />
  const data = q.data
  if (data === undefined) return <></>

  if (data.oversized) {
    return (
      <div
        className="worktree-files-preview__oversized"
        data-testid="worktree-files-preview-oversized"
      >
        <div className="worktree-files-preview__path">
          <code>{path}</code>
        </div>
        <p className="muted">
          {t('tasks.worktreeFilesOversized', {
            size: formatBytes(data.size),
            limit: formatBytes(WORKTREE_FILE_MAX_BYTES),
          })}
        </p>
      </div>
    )
  }
  return (
    <div className="worktree-files-preview__body" data-testid="worktree-files-preview-body">
      <div className="worktree-files-preview__header">
        <code className="worktree-files-preview__path">{path}</code>
        <span className="worktree-files-preview__size muted">
          {t('tasks.worktreeFilesSizeHeader', { size: sizeLabelData ?? '' })}
        </span>
      </div>
      <pre className="worktree-files-preview__pre">{data.content}</pre>
    </div>
  )
}
