// RFC-056 PR-D T10 — cross-clarify e2e (A1 happy path).
//
// Drives a workflow with a designer + questioner + cross-clarify node
// through the full ask → user-answers → designer-rerun-with-external-
// feedback → questioner-rerun-no-questions → final-output cycle. API-driven
// so we exercise the real runtime path (daemon + scheduler + crossClarify
// service + DB + WS).
//
// The stub binary in e2e/fixtures/stub-opencode-cross-clarify.sh emits:
//   Round 1 — designer.first    → <workflow-output> "design v1"
//   Round 2 — questioner.first  → <workflow-clarify> (1 question)
//   ★ task pauses awaiting_human; user POSTs answers ★
//   Round 3 — designer.second   → <workflow-output> "design v2"
//   Round 4 — questioner.second → <workflow-output> "questioner v2"
//
// LOCKS (in addition to status transitions):
//   * GET /api/clarify returns a cross-tagged entry while awaiting_human.
//   * Designer round 3's prompt (captured via CROSS_CLARIFY_PROMPT_LOG)
//     contains `## External Feedback` — proves the framework injected
//     the user's submitted Q&A into the rerun prompt.
//   * clarifyIteration on designer's second node_run is bumped (>0) — under
//     RFC-064 the previously-separate cross_clarify_iteration column was
//     folded into clarify_iteration via the §3.2 max+1 mint algorithm.

import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

const here = dirname(fileURLToPath(import.meta.url))
const stubCrossClarify = resolve(here, 'fixtures', 'stub-opencode-cross-clarify.sh')

interface CrossClarifyInboxEntry {
  // RFC-058 T14/T16: REST /api/clarify now returns ClarifyRoundSummary
  // (unified shape). The cross-clarify rows carry `kind: 'cross'` and the
  // legacy field names map as follows:
  //   crossClarifyNodeId   → intermediaryNodeId
  //   crossClarifyNodeRunId→ intermediaryNodeRunId
  //   sourceQuestionerNodeId → askingNodeId
  //   targetDesignerNodeId → targetConsumerNodeId
  kind: 'cross'
  id: string
  taskId: string
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  askingNodeId: string
  targetConsumerNodeId: string | null
  iteration: number
  questionCount: number
  status: string
  directive: string | null
}

interface ClarifyInboxItem {
  kind?: 'self' | 'cross'
}

interface TaskRow {
  status: string
}

function expectOk(res: Response, what: string): void {
  if (!res.ok) {
    throw new Error(`e2e setup: ${what} failed: HTTP ${res.status}`)
  }
}

async function pollTaskStatus(
  d: DaemonHandle,
  taskId: string,
  predicate: (t: TaskRow) => boolean,
  timeoutMs: number,
): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow = { status: 'pending' }
  while (Date.now() < deadline) {
    const res = await fetch(`${d.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${d.token}` },
    })
    if (res.ok) {
      last = (await res.json()) as TaskRow
      if (predicate(last)) return last
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollTaskStatus: timeout — last=${JSON.stringify(last)}`)
}

async function pollCrossClarifyAwaiting(
  d: DaemonHandle,
  taskId: string,
  timeoutMs: number,
): Promise<CrossClarifyInboxEntry> {
  const deadline = Date.now() + timeoutMs
  let last: ClarifyInboxItem[] = []
  while (Date.now() < deadline) {
    const res = await fetch(
      `${d.baseUrl}/api/clarify?status=awaiting_human&taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${d.token}` } },
    )
    if (res.ok) {
      last = (await res.json()) as ClarifyInboxItem[]
      const row = last.find(
        (r): r is CrossClarifyInboxEntry => (r as { kind?: string }).kind === 'cross',
      )
      if (row !== undefined) return row
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`pollCrossClarifyAwaiting: timeout — last=${JSON.stringify(last)}`)
}

test.describe('RFC-056 cross-clarify e2e — A1 happy path', () => {
  let daemon: DaemonHandle
  let repoDir: string
  let stubState: string
  let promptLog: string
  let fixtures: { workflowId: string; repoPath: string }

  test.beforeAll(async () => {
    stubState = mkdtempSync(join(tmpdir(), 'aw-e2e-cross-clarify-state-'))
    promptLog = join(stubState, 'prompt.log')
    daemon = await startDaemon({
      stubOpencode: stubCrossClarify,
      extraEnv: {
        CROSS_CLARIFY_STUB_STATE: stubState,
        CROSS_CLARIFY_PROMPT_LOG: promptLog,
      },
    })

    repoDir = mkdtempSync(join(tmpdir(), 'aw-e2e-cross-clarify-repo-'))
    writeFileSync(join(repoDir, 'README.md'), '# cross-clarify e2e fixture\n', 'utf-8')
    execSync('git init -b main -q', { cwd: repoDir })
    execSync('git config user.email e2e@example.com', { cwd: repoDir })
    execSync('git config user.name e2e', { cwd: repoDir })
    execSync('git add .', { cwd: repoDir })
    execSync('git commit -qm initial', { cwd: repoDir })

    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }
    expectOk(
      await fetch(`${daemon.baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'designer',
          description: 'e2e cross-clarify designer',
          outputs: ['design'],
          outputKinds: { design: 'markdown' },
          readonly: true,
          bodyMd: 'Stub designer for cross-clarify e2e.',
        }),
      }),
      'create designer agent',
    )
    expectOk(
      await fetch(`${daemon.baseUrl}/api/agents`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'questioner',
          description: 'e2e cross-clarify questioner',
          outputs: ['main'],
          outputKinds: { main: 'markdown' },
          readonly: true,
          bodyMd: 'Stub questioner for cross-clarify e2e.',
        }),
      }),
      'create questioner agent',
    )

    const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'e2e-cross-clarify-happy',
        description: 'Generated by Playwright e2e (RFC-056 PR-D T10).',
        definition: {
          $schema_version: 4,
          inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
            {
              id: 'designer',
              kind: 'agent-single',
              agentName: 'designer',
              promptTemplate: 'Design for {{topic}}.',
              position: { x: 220, y: 0 },
            },
            {
              id: 'questioner',
              kind: 'agent-single',
              agentName: 'questioner',
              promptTemplate: 'Review {{designer.design}}.',
              position: { x: 440, y: 0 },
            },
            {
              id: 'cross1',
              kind: 'clarify-cross-agent',
              title: 'Cross clarify',
              description: 'questioner asks user; user feeds back to designer.',
              position: { x: 440, y: 160 },
            },
            {
              id: 'out_1',
              kind: 'output',
              ports: [{ name: 'design', bind: { nodeId: 'designer', portName: 'design' } }],
              position: { x: 660, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e_in_designer',
              source: { nodeId: 'in_1', portName: 'topic' },
              target: { nodeId: 'designer', portName: 'topic' },
            },
            {
              id: 'e_designer_questioner',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'questioner', portName: 'design' },
            },
            // cross-clarify auto-edges
            {
              id: 'e_questioner_cross',
              source: { nodeId: 'questioner', portName: '__clarify__' },
              target: { nodeId: 'cross1', portName: 'questions' },
            },
            {
              id: 'e_cross_to_questioner',
              source: { nodeId: 'cross1', portName: 'to_questioner' },
              target: { nodeId: 'questioner', portName: '__clarify_response__' },
            },
            // manual edge cross → designer
            {
              id: 'e_cross_to_designer',
              source: { nodeId: 'cross1', portName: 'to_designer' },
              target: { nodeId: 'designer', portName: '__external_feedback__' },
            },
            // designer → output
            {
              id: 'e_designer_out',
              source: { nodeId: 'designer', portName: 'design' },
              target: { nodeId: 'out_1', portName: 'design' },
            },
          ],
        },
      }),
    })
    expectOk(wfRes, 'create workflow')
    const workflow = (await wfRes.json()) as { id: string }

    expectOk(
      await fetch(`${daemon.baseUrl}/api/repos/recent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: repoDir }),
      }),
      'register recent repo',
    )

    fixtures = { workflowId: workflow.id, repoPath: repoDir }
  })

  test.afterAll(async () => {
    try {
      rmSync(repoDir, { recursive: true, force: true })
      rmSync(stubState, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (daemon !== undefined) await daemon.stop()
  })

  test('full cycle: launch → questioner emits cross-clarify → user submits → designer reruns with External Feedback → done', async () => {
    const headers = {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    }

    // 1. Launch task.
    const launchRes = await fetch(`${daemon.baseUrl}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workflowId: fixtures.workflowId,
        name: 'e2e-cross-clarify-task',
        repoPath: fixtures.repoPath,
        baseBranch: 'main',
        inputs: { topic: 'cache eviction strategy' },
      }),
    })
    expectOk(launchRes, 'launch task')
    const taskId = ((await launchRes.json()) as { id: string }).id

    // 2. Task pauses awaiting_human after questioner.first emits cross-clarify.
    const awaiting = await pollTaskStatus(daemon, taskId, (t) => t.status === 'awaiting_human', 30_000)
    expect(awaiting.status).toBe('awaiting_human')

    // 3. /api/clarify list surfaces a cross-tagged entry.
    const row = await pollCrossClarifyAwaiting(daemon, taskId, 10_000)
    expect(row.kind).toBe('cross')
    expect(row.intermediaryNodeId).toBe('cross1')
    expect(row.askingNodeId).toBe('questioner')
    expect(row.targetConsumerNodeId).toBe('designer')
    expect(row.questionCount).toBe(1)

    // 4. POST answers (directive='continue').
    const submitRes = await fetch(
      `${daemon.baseUrl}/api/clarify/${row.intermediaryNodeRunId}/answers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          answers: [
            {
              questionId: 'q-redis',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
          directive: 'continue',
          ifMatchIteration: row.iteration,
        }),
      },
    )
    expectOk(submitRes, 'POST cross-clarify answers')

    // 5. Task reaches terminal done after designer round 2 + questioner round 2.
    const final = await pollTaskStatus(daemon, taskId, (t) => t.status === 'done', 30_000)
    expect(final.status).toBe('done')

    // 6. Designer round 2 prompt contains `## External Feedback` —
    //    proves the framework injected the user's Q&A into the rerun.
    const log = readFileSync(promptLog, 'utf-8')
    const designerRound2 = log.match(/=== designer round 2 ===([\s\S]*?)=== END designer round 2 ===/)
    expect(designerRound2, 'designer round 2 prompt was logged').not.toBeNull()
    expect(designerRound2![1]).toContain('## External Feedback')

    // 7. Designer reran after the cross-clarify submit. RFC-074 PR-C: the
    //    retired clarifyIteration counter is gone — the rerun is identified by
    //    id-order, i.e. a SECOND done top-level designer node_run minted after
    //    the original (the cross-clarify submit triggers triggerDesignerRerun).
    const runsRes = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}/node-runs`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    expectOk(runsRes, 'GET task node-runs')
    const runs = (await runsRes.json()) as {
      runs: Array<{
        id: string
        nodeId: string
        parentNodeRunId: string | null
        status: string
      }>
    }
    const doneDesigners = runs.runs
      .filter((r) => r.nodeId === 'designer' && r.parentNodeRunId === null && r.status === 'done')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    expect(doneDesigners.length, 'designer reran (>= 2 done rows)').toBeGreaterThanOrEqual(2)
    const elevatedDesigner = doneDesigners[doneDesigners.length - 1]
    expect(elevatedDesigner?.status).toBe('done')
  })
})
