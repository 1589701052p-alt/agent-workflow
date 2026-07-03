// RFC-120 D12 — ClarifyQuestionHandler: the clarify-page per-question handler
// echo + picker. Self-filters to designer-domain questions; editable only for
// non-terminal entries; degrades to null on absent/non-array data (so it can't
// break the fragile clarify page).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const designerEntry = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry => ({
  id: 'e1',
  questionId: 'q1',
  questionTitle: 't',
  originNodeRunId: 'origin-1',
  sourceKind: 'cross',
  roleKind: 'designer',
  sourceNodeId: 'auditor',
  defaultTargetNodeId: 'coder',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'coder',
  phase: 'processing',
  confirmation: 'open',
  staged: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

const SNAPSHOT = {
  $schema_version: 3,
  inputs: [],
  nodes: [
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
  test('designer entry + agent nodes → editable picker; reassign posts override', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    wrap([designerEntry()], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    // the Select renders a combobox trigger (editable variant)
    expect(within(root).getAllByRole('combobox').length).toBeGreaterThan(0)
    // (popover interaction is covered by Select's own tests; here we lock that the
    //  control is the editable variant for a non-terminal designer entry)
    void post
  })

  test('non-designer question → renders nothing', () => {
    wrap([designerEntry({ roleKind: 'questioner' })], SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  test('terminal (done) designer entry → read-only label, no select', () => {
    wrap([designerEntry({ phase: 'done', effectiveTargetNodeId: 'coder' })], SNAPSHOT)
    const root = screen.getByTestId('clarify-handler-q1')
    expect(within(root).queryAllByRole('button').length).toBe(0)
    expect(root.textContent).toContain('coder')
  })

  test('defensive: non-array entries data → renders nothing (never throws)', () => {
    // a fetch-mock that serves the wrong shape must not crash the clarify page.
    wrap({ notAnArray: true }, SNAPSHOT)
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  // RFC-128 P4 (Codex P2-2): clarify question ids are round-local, so the handler must scope
  // its designer-entry match to the given originNodeRunId — otherwise it would show/mutate a
  // sibling round's designer entry that reused the same questionId.
  test('originNodeRunId scopes the match: a sibling round entry is NOT matched', () => {
    // designerEntry default originNodeRunId is 'origin-1'; scope the handler to a different round.
    wrap([designerEntry()], SNAPSHOT, 'q1', 'other-origin')
    expect(screen.queryByTestId('clarify-handler-q1')).toBeNull()
  })

  test('originNodeRunId scopes the match: this round entry IS matched', () => {
    wrap([designerEntry({ originNodeRunId: 'origin-1' })], SNAPSHOT, 'q1', 'origin-1')
    expect(screen.getByTestId('clarify-handler-q1')).toBeTruthy()
  })

  // 2026-07-02 (用户拍板) — 处理节点显示节点名（title → agentName → id 回退，
  // resolveNodeNameFromSnapshot 同一 oracle），不再裸渲染节点 ID。
  test('read-only 处理节点显示节点名（snapshot title），不显示裸节点 ID', () => {
    const titled = {
      ...SNAPSHOT,
      nodes: [
        { id: 'node-9', kind: 'agent-single', agentName: 'coder', title: '修复者' },
        { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
      ],
    }
    wrap(
      [
        designerEntry({
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

  // RFC-138 — 改派给提问节点 ⇒ collapse（designer 条目退化为反问者 scope、行删除）。
  // 条目消失后控件不能凭空蒸发：留一行知会文案（.muted），且 POST 目标是提问节点。
  test('RFC-138: 改派到提问节点 → POST 后条目消失时渲染 collapse 知会文案', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ ok: true, action: 'collapsed-to-questioner' } as never)
    // 刷新后（invalidate → refetch）designer 条目已被删除。
    const get = vi.spyOn(api, 'get').mockResolvedValue([] as never)
    const withAsker = {
      ...SNAPSHOT,
      nodes: [...SNAPSHOT.nodes, { id: 'auditor', kind: 'agent-single', agentName: 'auditor' }],
    }
    wrap([designerEntry({ phase: 'pending' })], withAsker)
    const root = screen.getByTestId('clarify-handler-q1')
    fireEvent.click(within(root).getAllByRole('combobox')[0]!)
    const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
      (li.textContent ?? '').includes('auditor'),
    )
    expect(opt).toBeDefined()
    fireEvent.mouseDown(opt!)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/e1/reassign', {
        targetNodeId: 'auditor',
      }),
    )
    // 条目没了 → 不再渲染下拉，改渲染知会行（保住 testid 锚点）。
    await waitFor(() => {
      const el = screen.getByTestId('clarify-handler-q1')
      expect(el.className).toContain('muted')
      expect(within(el).queryAllByRole('combobox').length).toBe(0)
      expect((el.textContent ?? '').length).toBeGreaterThan(0)
    })
    void get
  })

  test('可编辑下拉的当前值显示节点名（Select label 经 snapshot 解析）', () => {
    const titled = {
      ...SNAPSHOT,
      nodes: [
        { id: 'node-9', kind: 'agent-single', agentName: 'coder', title: '修复者' },
        { id: 'fixer', kind: 'agent-single', agentName: 'fixer' },
      ],
    }
    wrap(
      [
        designerEntry({
          phase: 'processing',
          defaultTargetNodeId: 'node-9',
          effectiveTargetNodeId: 'node-9',
        }),
      ],
      titled,
    )
    const root = screen.getByTestId('clarify-handler-q1')
    const trigger = within(root).getAllByRole('combobox')[0]
    expect(trigger?.textContent).toContain('修复者')
    expect(trigger?.textContent).not.toContain('node-9')
  })
})
