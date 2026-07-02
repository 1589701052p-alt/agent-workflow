// RFC-134 — 改派回执（echo）卡片：只读知会形态锁。
//
// 锁定（design AC-10）：
//   1. echo 卡带「回执」StatusChip（tq-echo-chip-*），与承接卡可区分；
//   2. echo 卡 processing 相位即有 confirm（D3 任意相位可收卡）并打到 confirm 端点；
//      同相位的非 echo 卡**没有** confirm（既有 guard 不被放宽波及——黄金锁）；
//   3. echo 卡无改派 Select、无 stage 按钮、无 staged 勾选（生来已下发，与后端 CAS/D10 对齐）。
// 断言走 data-testid / role（i18n 无关）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import '../src/i18n'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'origin-1',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'asker',
  defaultTargetNodeId: 'asker',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'asker',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

const echoEntry = (over: Partial<TaskQuestionEntry> = {}): TaskQuestionEntry =>
  entry({
    id: 'echo-1',
    roleKind: 'echo',
    phase: 'processing',
    sealed: true,
    answerSummary: 'A',
    ...over,
  })

async function wrap(entries: TaskQuestionEntry[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <QueryClientProvider client={qc}>
        <TaskQuestionList
          taskId="task-1"
          nodeOptions={[
            { id: 'asker', label: 'asker' },
            { id: 'fixer', label: 'fixer' },
          ]}
        />
      </QueryClientProvider>
    ),
  })
  const clarify = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, clarify]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router as never} />)
}

describe('RFC-134 echo 卡片（只读知会）', () => {
  test('回执 chip 可见；改派 Select / stage / 勾选一律不渲染；目标以纯文本展示', async () => {
    await wrap([echoEntry()])
    const card = await screen.findByTestId('tq-card-echo-1')
    expect(within(card).getByTestId('tq-echo-chip-echo-1')).toBeTruthy()
    // 无改派下拉（processing 相位非 reassignable → 纯文本目标）。
    expect(within(card).queryByRole('combobox')).toBeNull()
    // 无 stage / 勾选。
    expect(within(card).queryByTestId('tq-stage-echo-1')).toBeNull()
    expect(within(card).queryByTestId('tq-select-echo-1')).toBeNull()
  })

  test('D3：processing 相位的 echo 卡有 confirm 且打 confirm 端点；同相位非 echo 卡没有 confirm', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    await wrap([
      echoEntry(),
      entry({ id: 'plain-1', phase: 'processing', sealed: true, answerSummary: 'A' }),
    ])
    const echoCard = await screen.findByTestId('tq-card-echo-1')
    const plainCard = await screen.findByTestId('tq-card-plain-1')
    // 非 echo 的 processing 卡：无按钮（黄金锁——confirm 放宽只对 echo）。
    expect(within(plainCard).queryByRole('button')).toBeNull()
    // echo 卡有 confirm（ConfirmButton 单按钮两击：armed → 确认）。
    const btn = within(echoCard).getByRole('button')
    fireEvent.click(btn)
    fireEvent.click(within(echoCard).getByRole('button'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/echo-1/confirm'),
    )
  })

  test('done 相位的 echo 卡不再有 confirm（已收卡）', async () => {
    await wrap([echoEntry({ id: 'echo-2', phase: 'done', confirmation: 'confirmed' })])
    const card = await screen.findByTestId('tq-card-echo-2')
    expect(within(card).queryByRole('button')).toBeNull()
  })
})
