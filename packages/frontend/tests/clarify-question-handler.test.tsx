// RFC-120 D12 / RFC-162 — ClarifyQuestionHandler: the clarify-page per-question handler
// picker. RFC-162 归一: it is anchored on the ASKER entry (self/questioner) and EDITS the
// question's designer handler group — reassign(asker, X) adds a designer targeting X (or
// removes it when X is the asking node). Shows the current effective handler (the designer's
// target if one was added, else the asker's own node). Degrades to null when no asker entry is
// present (so it can't break the fragile clarify page). Collapse/scope/echo were deleted.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const askerEntry = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry => ({
  id: 'e-ask',
  questionId: 'q1',
  questionTitle: 't',
  originNodeRunId: 'origin-1',
  sourceKind: 'cross',
  roleKind: 'questioner',
  sourceNodeId: 'auditor',
  defaultTargetNodeId: 'auditor',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'auditor',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  autoDispatchDeferred: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

const designerEntry = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry => ({
  ...askerEntry(),
  id: 'e-des',
  roleKind: 'designer',
  defaultTargetNodeId: 'coder',
  effectiveTargetNodeId: 'coder',
  ...over,
})

const SNAPSHOT = {
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'auditor', kind: 'agent-single', agentName: 'auditor' },
    { id: 'coder', kind: 'agent-single', agentName: 'coder' },
    { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
  ],
  edges: [],
  outputs: [],
}

function wrap(entries: unknown, snapshot: unknown, questionId = 'q1', originNodeRunId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: snapshot })
  return render(
    <QueryClientProvider client={qc}>
      <ClarifyQuestionHandler
        taskId="task-1"
        questionId={questionId}
        {...(originNodeRunId !== undefined ? { originNodeRunId } : {})}
      />
    </QueryClientProvider>,
  )
}

describe('ClarifyQuestionHandler', () => {
  test('asker entry + agent nodes → editable picker anchored on the asker', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    wrap([askerEntry()], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    expect(within(root).getAllByRole('combobox').length).toBeGreaterThan(0)
    void post
  })

  test('RFC-162: current effective handler = the added designer target when present', () => {
    wrap([askerEntry(), designerEntry({ effectiveTargetNodeId: 'fixer' })], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    const trigger = within(root).getAllByRole('combobox')[0]
    expect(trigger?.textContent).toContain('fixer')
  })

  test('no asker entry → renders nothing', () => {
    wrap([designerEntry()], SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  test('terminal (done) asker entry → read-only label, no select', () => {
    wrap([askerEntry({ phase: 'done' })], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    expect(within(root).queryAllByRole('combobox').length).toBe(0)
    expect(root.textContent).toContain('auditor')
  })

  test('defensive: non-array entries data → renders nothing (never throws)', () => {
    wrap({ notAnArray: true }, SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  // RFC-128 P4 (Codex P2-2): clarify question ids are round-local, so the handler must scope its
  // match to the given originNodeRunId — otherwise it would show/mutate a sibling round's entry.
  test('originNodeRunId scopes the match: a sibling round entry is NOT matched', () => {
    wrap([askerEntry()], SNAPSHOT, 'q1', 'other-origin')
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  test('originNodeRunId scopes the match: this round entry IS matched', () => {
    wrap([askerEntry({ originNodeRunId: 'origin-1' })], SNAPSHOT, 'q1', 'origin-1')
    expect(screen.getByTestId('clarify-handler-q1')).toBeTruthy()
  })

  // 2026-07-02 (用户拍板) — 处理节点显示节点名（title → agentName → id 回退）。
  test('read-only 处理节点显示节点名（snapshot title），不显示裸节点 ID', () => {
    const titled = {
      ...SNAPSHOT,
      nodes: [
        { id: 'node-9', kind: 'agent-single', agentName: 'coder', title: '修复者' },
        { id: 'auditor', kind: 'agent-single', agentName: 'auditor' },
      ],
    }
    wrap(
      [
        askerEntry({
          phase: 'done',
          defaultTargetNodeId: 'node-9',
          effectiveTargetNodeId: 'node-9',
        }),
      ],
      titled,
    )
    const root = screen.getByTestId('clarify-handler-q1')
    expect(root.textContent).toContain('修复者')
    expect(root.textContent).not.toContain('node-9')
  })
})
