// Right-side drawer that opens when the user picks a node on the task
// status canvas (P-2-13). M2 ships 4 tabs:
//
//   - Prompt — promptText captured by the runner (read-only).
//   - Events — latest 500 events with kind filter chips; refetches on
//               /ws/tasks/:id node.event invalidations.
//   - Output — port → value cards (copyable).
//   - Stats  — start/finish/duration, exit code, token usage.
//
// Retries history + sub-process listing for fan-out children land in M3.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { NodeRun, NodeRunEventsResponse, NodeRunOutput } from '@agent-workflow/shared'
import { NODE_EVENT_KIND } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'

interface Props {
  taskId: string
  nodeRunId: string | null
  runs: NodeRun[]
  outputs: NodeRunOutput[]
  onClose: () => void
}

type Tab = 'prompt' | 'events' | 'output' | 'stats'

export function NodeDetailDrawer({ taskId, nodeRunId, runs, outputs, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('prompt')

  if (nodeRunId === null) return null
  const run = runs.find((r) => r.id === nodeRunId)
  if (run === undefined) return null
  const nodeOutputs = outputs.filter((o) => o.nodeRunId === nodeRunId)

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div className="inspector__kind">node_run</div>
          <div className="inspector__id">
            <code>{run.nodeId}</code> <span className="muted">/ {run.id.slice(-6)}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="inspector__close" aria-label="Close">
          ×
        </button>
      </header>
      <div className="tabs inspector__tabs">
        {(
          [
            ['prompt', 'Prompt'],
            ['events', 'Events'],
            ['output', 'Output'],
            ['stats', 'Stats'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`tabs__tab ${tab === k ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inspector__body">
        {tab === 'prompt' && <PromptTab run={run} />}
        {tab === 'events' && <EventsTab taskId={taskId} nodeRunId={nodeRunId} />}
        {tab === 'output' && <OutputTab outputs={nodeOutputs} />}
        {tab === 'stats' && <StatsTab run={run} />}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------

function PromptTab({ run }: { run: NodeRun }) {
  if (run.promptText === null) {
    return <div className="muted">Prompt hasn't been assembled yet (node is still pending).</div>
  }
  return <pre className="readonly-pre">{run.promptText}</pre>
}

function OutputTab({ outputs }: { outputs: NodeRunOutput[] }) {
  if (outputs.length === 0) {
    return <div className="muted">No outputs captured yet.</div>
  }
  return (
    <div className="form-grid">
      {outputs.map((o, i) => (
        <article key={`${o.port}-${i}`} className="task-output-card">
          <header className="task-output-card__header">
            <div className="task-output-card__name">{o.port}</div>
            <CopyButton text={o.value} />
          </header>
          <pre className="task-output-card__body">
            {o.value === '' ? <span className="muted">(empty)</span> : o.value}
          </pre>
        </article>
      ))}
    </div>
  )
}

function StatsTab({ run }: { run: NodeRun }) {
  const duration =
    run.startedAt !== null && run.finishedAt !== null
      ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(2)}s`
      : '—'
  return (
    <dl className="task-meta">
      <dt>Status</dt>
      <dd>{run.status}</dd>
      <dt>Started</dt>
      <dd>{run.startedAt === null ? '—' : new Date(run.startedAt).toLocaleString()}</dd>
      <dt>Finished</dt>
      <dd>{run.finishedAt === null ? '—' : new Date(run.finishedAt).toLocaleString()}</dd>
      <dt>Duration</dt>
      <dd>{duration}</dd>
      <dt>Exit code</dt>
      <dd>{run.exitCode === null ? '—' : run.exitCode}</dd>
      <dt>Iteration</dt>
      <dd>{run.iteration}</dd>
      <dt>Retry</dt>
      <dd>{run.retryIndex}</dd>
      <dt>Tokens in</dt>
      <dd>{run.tokInput ?? '—'}</dd>
      <dt>Tokens out</dt>
      <dd>{run.tokOutput ?? '—'}</dd>
      <dt>Tokens total</dt>
      <dd>{run.tokTotal ?? '—'}</dd>
      <dt>Cache create</dt>
      <dd>{run.tokCacheCreate ?? '—'}</dd>
      <dt>Cache read</dt>
      <dd>{run.tokCacheRead ?? '—'}</dd>
      {run.errorMessage !== null && (
        <>
          <dt>Error</dt>
          <dd className="task-meta__error">{run.errorMessage}</dd>
        </>
      )}
    </dl>
  )
}

function EventsTab({ taskId, nodeRunId }: { taskId: string; nodeRunId: string }) {
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(NODE_EVENT_KIND))
  const query = useQuery<NodeRunEventsResponse>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'events'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/events`,
        undefined,
        signal,
      ),
  })

  const visible = useMemo(
    () => (query.data?.events ?? []).filter((e) => enabledKinds.has(e.kind)),
    [query.data, enabledKinds],
  )

  function toggleKind(k: string) {
    setEnabledKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  return (
    <div>
      <div className="events-filter chip-row">
        {NODE_EVENT_KIND.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => toggleKind(k)}
            className={`chip chip--tight ${enabledKinds.has(k) ? 'chip--active' : ''}`}
          >
            {k}
          </button>
        ))}
      </div>
      {query.isLoading && <div className="muted">Loading…</div>}
      {query.error !== null && query.error !== undefined && (
        <div className="error-box">{describeError(query.error)}</div>
      )}
      {visible.length === 0 && !query.isLoading && (
        <div className="muted">No events match the current filters.</div>
      )}
      <ol className="events-list">
        {visible.map((e) => (
          <li key={e.id} className={`events-list__item events-list__item--${e.kind}`}>
            <header className="events-list__header">
              <code className="events-list__kind">{e.kind}</code>
              <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
            </header>
            <pre className="events-list__body">
              {typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2)}
            </pre>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button type="button" className="btn btn--sm" onClick={copy}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
