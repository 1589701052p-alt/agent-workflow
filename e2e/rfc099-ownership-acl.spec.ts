// RFC-099 — resource-ownership ACL through TWO real browser contexts.
//
// LOCKS the owner/grant story at the UI layer (proposal 用户故事 1):
//   1. alice (regular user) owns an agent; via the detail page's AclPanel she
//      flips it PRIVATE → carol's /agents list no longer shows it and the
//      direct detail URL dead-ends (the 404 renders the error state).
//   2. alice grants carol through the UserPicker → carol sees the agent
//      again; her AclPanel is READ-ONLY (no save button, owner shown).
//   3. The workflow editor's 「Permissions」 dialog opens the same panel for
//      workflows (smoke — panel renders with owner row).
//
// Backend route matrices live in rfc099-resource-routes.test.ts; this spec
// pins the browser-visible wiring: panel mounts, picker search round-trip,
// list filtering after ACL changes.

import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

interface SeededUser {
  username: string
  sessionToken: string
  userId: string
}

async function createUserAndLogin(opts: {
  username: string
  password: string
  role: 'admin' | 'user'
}): Promise<SeededUser> {
  const createRes = await fetch(`${daemon.baseUrl}/api/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: opts.username,
      displayName: opts.username,
      role: opts.role,
      password: opts.password,
    }),
  })
  if (!createRes.ok) throw new Error(`createUser ${opts.username}: ${createRes.status}`)
  const { id } = (await createRes.json()) as { id: string }
  const loginRes = await fetch(`${daemon.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: opts.username, password: opts.password }),
  })
  if (!loginRes.ok) throw new Error(`login ${opts.username}: ${loginRes.status}`)
  const { sessionToken } = (await loginRes.json()) as { sessionToken: string }
  return { username: opts.username, userId: id, sessionToken }
}

async function primeAuth(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    ({ baseUrl, tok }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', tok)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, tok: token },
  )
}

const AGENT_NAME = 'rfc099-secret-agent'

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-099: private agent disappears for strangers; granting via AclPanel restores read-only access', async ({
  browser,
}) => {
  const alice = await createUserAndLogin({
    username: 'alice99',
    password: 'longEnoughPassword',
    role: 'user',
  })
  const carol = await createUserAndLogin({
    username: 'carol99',
    password: 'longEnoughPassword',
    role: 'user',
  })

  // alice creates the agent via API (the AgentForm itself is covered by
  // existing e2e); RFC-099 stamps her as owner.
  const createAgent = await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: AGENT_NAME,
      description: 'rfc099 e2e fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: 'secret instructions',
    }),
  })
  expect(createAgent.ok).toBe(true)

  const aliceCtx = await browser.newContext()
  await primeAuth(aliceCtx, alice.sessionToken)
  const alicePage: Page = await aliceCtx.newPage()

  const carolCtx = await browser.newContext()
  await primeAuth(carolCtx, carol.sessionToken)
  const carolPage: Page = await carolCtx.newPage()

  // (0) Default public: carol sees the agent in her list.
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME }).first()).toBeVisible()

  // (1) alice opens the detail page; the AclPanel shows her as owner and she
  // flips visibility to private.
  await alicePage.goto(`${daemon.baseUrl}/agents/${AGENT_NAME}`)
  await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  await expect(alicePage.getByTestId('acl-panel')).toContainText('alice99')
  await alicePage.getByTestId('acl-visibility-private').click()
  await alicePage.getByTestId('acl-save').click()
  // Save settles → button disables again (dirty cleared on success).
  await expect(alicePage.getByTestId('acl-save')).toBeDisabled()

  // (2) carol: list no longer contains the agent; direct URL dead-ends.
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME })).toHaveCount(0)
  await carolPage.goto(`${daemon.baseUrl}/agents/${AGENT_NAME}`)
  await expect(carolPage.getByTestId('acl-panel')).toHaveCount(0)

  // (3) alice grants carol through the UserPicker and saves.
  await alicePage.getByTestId('acl-members-input').click()
  await alicePage.getByTestId('acl-members-input').fill('carol')
  await alicePage.getByTestId('acl-members-option-carol99').click()
  await alicePage.getByTestId('acl-save').click()
  await expect(alicePage.getByTestId('acl-save')).toBeDisabled()

  // (4) carol sees it again; her panel is read-only (no save / transfer).
  await carolPage.goto(`${daemon.baseUrl}/agents/${AGENT_NAME}`)
  await expect(carolPage.getByTestId('acl-panel')).toBeVisible()
  await expect(carolPage.getByTestId('acl-panel')).toContainText('alice99')
  await expect(carolPage.getByTestId('acl-save')).toHaveCount(0)
  await expect(carolPage.getByTestId('acl-transfer-owner')).toHaveCount(0)
  await carolPage.goto(`${daemon.baseUrl}/agents`)
  await expect(carolPage.getByRole('link', { name: AGENT_NAME }).first()).toBeVisible()

  // (5) Workflow editor surfaces the same panel behind the 「Permissions」
  // button (smoke).
  const wfRes = await fetch(`${daemon.baseUrl}/api/workflows`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${alice.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'rfc099-flow',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    }),
  })
  const wf = (await wfRes.json()) as { id: string }
  await alicePage.goto(`${daemon.baseUrl}/workflows/${wf.id}`)
  await alicePage.getByTestId('workflow-acl-button').click()
  await expect(alicePage.getByTestId('acl-panel')).toBeVisible()
  await expect(alicePage.getByTestId('acl-panel')).toContainText('alice99')

  await aliceCtx.close()
  await carolCtx.close()
})
