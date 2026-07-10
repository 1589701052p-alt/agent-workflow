// RFC-075 — auto commit&push end-to-end against the real daemon binary.
//
// Locks the full runtime path that the unit/integration tests can only mock:
// a real daemon spawns a (stub) opencode worker that dirties the worktree,
// the diff-driven scheduler trigger fires, the framework stages + commits
// (LLM message via the built-in commit agent) and PUSHES to a real bare
// remote, and a synthetic commit&push node_run surfaces via the API with
// pushOutcome=pushed. API-driven (no browser): the commit-row UI is covered by
// the frontend guard test; the value here is real daemon + real git push +
// real opencode-stub spawn + the scheduler trigger, wired together.

import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

const STUB = resolve(import.meta.dirname, 'fixtures', 'stub-opencode-commit.sh')

let daemon: DaemonHandle
let repo: string
let remote: string

function sh(cmd: string): void {
  execSync(cmd, { stdio: 'ignore' })
}

test.beforeAll(async () => {
  // A path-mode repo whose `origin` is a writable bare remote, so the
  // framework's `git push` from the task worktree actually lands.
  remote = mkdtempSync(join(tmpdir(), 'aw-e2e-cp-remote-'))
  sh(`git init -q --bare -b main "${remote}"`)
  repo = mkdtempSync(join(tmpdir(), 'aw-e2e-cp-repo-'))
  sh(`git init -q -b main "${repo}"`)
  sh(`git -C "${repo}" config user.email e2e@test.local`)
  sh(`git -C "${repo}" config user.name e2e`)
  sh(`printf 'seed\\n' > "${repo}/README.md"`)
  sh(`git -C "${repo}" add .`)
  sh(`git -C "${repo}" commit -q -m init`)
  sh(`git -C "${repo}" remote add origin "${remote}"`)
  sh(`git -C "${repo}" push -q -u origin main`)

  daemon = await startDaemon({ stubOpencode: STUB })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true })
  if (remote !== undefined) rmSync(remote, { recursive: true, force: true })
})

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

interface NodeRunLite {
  nodeId: string
  status: string
  commitPush: { pushOutcome: string; commitSha: string | null; repoBranch: string } | null
}

test.describe('RFC-075 — auto commit&push (real daemon + bare remote)', () => {
  test('writer change is committed with an LLM message and pushed to the remote', async () => {
    // Agent that writes (read-write) + emits `answer`.
    const agentRes = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'cp-writer',
        description: 'RFC-075 e2e writer',
        outputs: ['answer'],
        readonly: false,
        bodyMd: '',
      }),
    })
    expect(agentRes.ok).toBe(true)

    const wfRes = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'cp-wf',
        description: 'RFC-075 e2e',
        definition: {
          $schema_version: 1,
          inputs: [{ kind: 'text', key: 't', label: 'T', required: true }],
          nodes: [
            { id: 'in_1', kind: 'input', inputKey: 't', position: { x: 0, y: 0 } },
            {
              id: 'w',
              kind: 'agent-single',
              agentName: 'cp-writer',
              promptTemplate: '{{t}}',
              position: { x: 300, y: 0 },
            },
            {
              id: 'o',
              kind: 'output',
              ports: [{ name: 'answer', bind: { nodeId: 'w', portName: 'answer' } }],
              position: { x: 600, y: 0 },
            },
          ],
          edges: [
            {
              id: 'e1',
              source: { nodeId: 'in_1', portName: 't' },
              target: { nodeId: 'w', portName: 't' },
            },
            {
              id: 'e2',
              source: { nodeId: 'w', portName: 'answer' },
              target: { nodeId: 'o', portName: 'answer' },
            },
          ],
        },
      }),
    })
    expect(wfRes.ok).toBe(true)
    const wf = (await wfRes.json()) as { id: string }

    // Launch with auto commit&push ON, file:// URL against our repo (RFC-165).
    const taskRes = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'cp-task',
        workflowId: wf.id,
        repoUrl: pathToFileURL(repo).href,
        ref: 'main',
        autoCommitPush: true,
        inputs: { t: 'go' },
      }),
    })
    expect(taskRes.status).toBe(201)
    const task = (await taskRes.json()) as { id: string }
    expect(task.id).toBeTruthy()

    // Poll until the task reaches a terminal status (≤ 60s).
    const deadline = Date.now() + 60_000
    let status = 'pending'
    while (Date.now() < deadline) {
      const r = await api(`/api/tasks/${task.id}`)
      status = ((await r.json()) as { status: string }).status
      if (['done', 'failed', 'canceled'].includes(status)) break
      await new Promise((res) => setTimeout(res, 1000))
    }
    expect(status).toBe('done')

    // The synthetic commit&push node_run surfaced via the API, pushed.
    const runsRes = await api(`/api/tasks/${task.id}/node-runs`)
    const { runs } = (await runsRes.json()) as { runs: NodeRunLite[] }
    const commitRow = runs.find(
      (r) => r.nodeId.startsWith('__commit_push__') && r.commitPush != null,
    )
    expect(commitRow).toBeDefined()
    expect(commitRow!.commitPush!.pushOutcome).toBe('pushed')
    expect(commitRow!.commitPush!.commitSha).toMatch(/^[a-f0-9]{40}$/)

    // The bare remote received the task's isolation branch.
    const branch = commitRow!.commitPush!.repoBranch
    const ls = execSync(`git -C "${remote}" rev-parse --verify "refs/heads/${branch}"`, {
      encoding: 'utf8',
    }).trim()
    expect(ls).toMatch(/^[a-f0-9]{40}$/)
  })
})
