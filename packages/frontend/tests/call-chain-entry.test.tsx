// RFC-085 §6 — the ⎇ call-chain ENTRY → 5th-tab wiring (no render coverage before).
// Locks: (1) a changed method row shows the ⎇ entry and clicking it switches to the
// "调用链" tab mounting <CallChainView> with that root; (2) the entry is HIDDEN when
// callChainAvailable is false (multi-repo) so there is no dead button.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '../src/i18n'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { ...actual.api, get: vi.fn().mockResolvedValue({ targets: [] }) } }
})

import { StructuralDiffView } from '../src/components/structure/StructuralDiffView'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sym = (): SymbolNode => ({
  id: 'A.java#A.run:method:1',
  kind: 'method',
  name: 'run',
  qualifiedName: 'A.run',
  lang: 'java',
  filePath: 'A.java',
  confidence: 'extracted',
})

function diff(callChainAvailable: boolean): StructuralDiff {
  const files: StructuralDiff['files'] = [
    {
      filePath: 'A.java',
      lang: 'java',
      status: 'ok',
      edges: [],
      impact: [],
      changes: [{ changeType: 'modified', kind: 'method', after: sym() }],
    },
  ]
  return {
    scope: 'task',
    taskId: 't1',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'deep',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    callChainAvailable,
    summary: computeSummary(files, []),
  }
}

function renderView(d: StructuralDiff) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <StructuralDiffView data={d} />
    </QueryClientProvider>,
  )
}

describe('call-chain entry → 5th tab', () => {
  test('⎇ on a changed method row switches to the 调用链 tab + mounts CallChainView', async () => {
    const { container } = renderView(diff(true))
    const entry = container.querySelector('.structure__callchain-entry')
    expect(entry).not.toBeNull()
    fireEvent.click(entry as Element)
    const view = await screen.findByTestId('call-chain')
    expect(view).toBeTruthy()
    expect(view.textContent).toContain('run()') // the root label
  })

  test('no ⎇ entry when callChainAvailable is false (multi-repo → no dead button)', () => {
    const { container } = renderView(diff(false))
    expect(container.querySelector('.structure__callchain-entry')).toBeNull()
  })
})
