// RFC-027 §UX revision — locks the AttemptPicker chip-row in SessionTab:
//   - renders a `radiogroup` with one `radio` per attempt
//   - the active attempt is the only aria-checked=true row
//   - iter label uses the right key for retry / loop / clarify / initial
//   - clicking a different chip flips the active state without remount
//   - shard chips render their shardKey
//
// Importantly this replaces the prior `<select>`-based picker that the
// user flagged as "丑" — keep this suite green to prevent a regression
// back to a bare native dropdown.

import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { NodeRun, SessionViewResponse } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { NodeDetailDrawer } from '../src/components/NodeDetailDrawer'

function run(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'agent_1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    clarifyIteration: partial.clarifyIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? 1700_000_000_000,
    finishedAt: partial.finishedAt ?? 1700_000_001_000,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

function renderDrawer(props: {
  nodeRunId: string
  nodeId: string | null
  workflowNodeKind: string | null
  runs: NodeRun[]
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <NodeDetailDrawer
          taskId="t1"
          taskStatus="done"
          nodeRunId={props.nodeRunId}
          nodeId={props.nodeId}
          workflowNodeKind={props.workflowNodeKind}
          agentName={null}
          runs={props.runs}
          outputs={[]}
          onClose={vi.fn()}
        />
      </I18nextProvider>
    </QueryClientProvider>,
  )
}

const SAMPLE_SESSION: SessionViewResponse = {
  tree: {
    sessionId: 's',
    parentSessionId: null,
    agentName: null,
    captureComplete: true,
    messages: [],
  },
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(SAMPLE_SESSION), { status: 200 }),
  ) as unknown as typeof globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.innerHTML = ''
})

describe('RFC-027 §UX — Session attempts chip-row picker', () => {
  test('multi-attempts renders one radio per attempt + only the picked is aria-checked', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100 })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200 })
    const r2 = run({ id: 'r2', retryIndex: 2, startedAt: 300 })
    renderDrawer({
      nodeRunId: r2.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1, r2],
    })
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    // attempts are sorted ascending by (iteration, retryIndex, startedAt)
    // and rendered in that order. The picked one (selectedRunId='r2') is
    // the last chip.
    expect(checked[0]).toBe(radios[2]!)
  })

  test('clicking a chip flips the active row without errors', () => {
    const r0 = run({ id: 'r0', retryIndex: 0, startedAt: 100 })
    const r1 = run({ id: 'r1', retryIndex: 1, startedAt: 200 })
    renderDrawer({
      nodeRunId: r1.id,
      nodeId: r0.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r0, r1],
    })
    const radios = screen.getAllByRole('radio')
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(radios[0]!)
    const after = screen.getAllByRole('radio')
    expect(after[0]!.getAttribute('aria-checked')).toBe('true')
    expect(after[1]!.getAttribute('aria-checked')).toBe('false')
  })

  test('iter label distinguishes initial / retry / loop / clarify rows', () => {
    const initial = run({ id: 'a', retryIndex: 0, iteration: 0, clarifyIteration: 0 })
    const retry = run({ id: 'b', retryIndex: 1, iteration: 0, clarifyIteration: 0, startedAt: 200 })
    const loop = run({ id: 'c', retryIndex: 0, iteration: 2, clarifyIteration: 0, startedAt: 300 })
    const clarify = run({
      id: 'd',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 3,
      startedAt: 400,
    })
    renderDrawer({
      nodeRunId: clarify.id,
      nodeId: initial.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [initial, retry, loop, clarify],
    })
    const html = document.body.innerHTML
    expect(html).toMatch(/initial/i)
    expect(html).toMatch(/retry#1/i)
    expect(html).toMatch(/loop#2/i)
    expect(html).toMatch(/clarify#3/i)
  })

  test('shard rows show the shardKey alongside the iter label', () => {
    const parent = run({ id: 'p', promptText: null })
    const shardA = run({ id: 'sa', parentNodeRunId: 'p', shardKey: 'src/a.ts', startedAt: 200 })
    const shardB = run({ id: 'sb', parentNodeRunId: 'p', shardKey: 'src/b.ts', startedAt: 300 })
    renderDrawer({
      nodeRunId: shardA.id,
      nodeId: parent.nodeId,
      workflowNodeKind: 'agent-multi',
      runs: [parent, shardA, shardB],
    })
    const html = document.body.innerHTML
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
  })

  test('no native <select> remains under the attempts picker (the ugly dropdown is gone)', () => {
    const r = run({ id: 'r1' })
    renderDrawer({
      nodeRunId: r.id,
      nodeId: r.nodeId,
      workflowNodeKind: 'agent-single',
      runs: [r],
    })
    const group = screen.getByRole('radiogroup', { name: /attempt/i })
    expect(group.querySelector('select')).toBeNull()
  })
})
