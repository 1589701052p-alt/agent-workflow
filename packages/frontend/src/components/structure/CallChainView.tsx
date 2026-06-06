// RFC-085 — the "调用链" view: a root (changed) method and its forward call chain,
// expanded LAZILY one level at a time (GET /call-targets per method). Resolved
// callees get a ▸ to drill deeper; external/unresolved are grey leaves; cycles +
// the depth cap stop the recursion. Default-open one level (the root's callees).

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { CallTarget } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { expandState, type ExpandState } from '@/lib/callChain'
import { LoadingState } from '@/components/LoadingState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'

export interface CallChainRoot {
  /** `${filePath}#${qualifiedName}` of the root (changed) method. */
  ref: string
  /** display label, e.g. `charge()`. */
  label: string
}

export function CallChainView({ taskId, root }: { taskId: string; root: CallChainRoot | null }) {
  const { t } = useTranslation()
  if (root === null) {
    return <EmptyState title={t('tasks.structCallPick')} />
  }
  return (
    <div className="callchain" data-testid="call-chain">
      <div className="callchain__root">
        <span className="callchain__root-glyph" aria-hidden="true">
          ⎇
        </span>
        <span className="callchain__root-label">{root.label}</span>
      </div>
      <CallLevel taskId={taskId} parentRef={root.ref} ancestors={new Set([root.ref])} depth={1} />
    </div>
  )
}

/** One level of callees for `parentRef` (always loads — that's the "lazy" unit). */
function CallLevel({
  taskId,
  parentRef,
  ancestors,
  depth,
}: {
  taskId: string
  parentRef: string
  ancestors: ReadonlySet<string>
  depth: number
}) {
  const { t } = useTranslation()
  const q = useQuery<{ targets: CallTarget[] }>({
    queryKey: ['callTargets', taskId, parentRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/call-targets?methodRef=${encodeURIComponent(parentRef)}`,
        undefined,
        signal,
      ),
  })
  if (q.isLoading) return <LoadingState />
  if (q.isError) return <ErrorBanner error={q.error} />
  const targets = (q.data?.targets ?? []).slice().sort((a, b) => a.order - b.order)
  if (targets.length === 0) {
    return <div className="callchain__empty muted">{t('tasks.structCallNoCalls')}</div>
  }
  return (
    <ul className="callchain__list">
      {targets.map((tg, i) => (
        <CallNode
          key={`${tg.order}-${tg.label}-${i}`}
          taskId={taskId}
          target={tg}
          ancestors={ancestors}
          depth={depth}
        />
      ))}
    </ul>
  )
}

const STATE_TAG: Record<Exclude<ExpandState, 'expandable'>, string> = {
  leaf: '', // external/unresolved get their own tag below
  cycle: 'tasks.structCallCycle',
  'too-deep': 'tasks.structCallTruncated',
}

function CallNode({
  taskId,
  target,
  ancestors,
  depth,
}: {
  taskId: string
  target: CallTarget
  ancestors: ReadonlySet<string>
  depth: number
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const state = expandState(target, ancestors, depth)
  const expandable = state === 'expandable'
  return (
    <li className="callchain__node">
      <div className={`callchain__row callchain__row--${target.resolution}`}>
        {expandable ? (
          <button
            type="button"
            className="callchain__toggle"
            aria-expanded={open}
            aria-label={t(open ? 'tasks.structCallCollapse' : 'tasks.structCallExpand')}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="callchain__bullet" aria-hidden="true">
            ·
          </span>
        )}
        <span className="callchain__label">{target.label}</span>
        {target.resolution === 'external' && (
          <span className="callchain__tag callchain__tag--external">
            {t('tasks.structCallExternal')}
          </span>
        )}
        {target.resolution === 'unresolved' && (
          <span className="callchain__tag callchain__tag--unresolved">
            {t('tasks.structCallUnresolved')}
          </span>
        )}
        {state !== 'expandable' && state !== 'leaf' && (
          <span className="callchain__tag">{t(STATE_TAG[state])}</span>
        )}
      </div>
      {open && expandable && target.ref !== undefined && (
        <div className="callchain__children">
          <CallLevel
            taskId={taskId}
            parentRef={target.ref}
            ancestors={new Set([...ancestors, target.ref])}
            depth={depth + 1}
          />
        </div>
      )}
    </li>
  )
}
