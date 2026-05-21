// RFC-054 W2-7 — import / export real-file round-trip e2e.
//
// LOCKS the YAML import + export contracts at the HTTP boundary, using a
// real committed fixture file (e2e/fixtures/import-files/sample-workflow.yaml).
//
// Why bother with fixture files when the API endpoint is what matters:
//   * A committed YAML fixture pins the EXTERNAL shape of an exportable
//     workflow definition. A future PR that adds a required field or
//     renames `$schema_version` would break user-facing import — this
//     test catches that before users hit it.
//   * Round-trip parity (export-then-reimport equals original) is the
//     contract every config tool implicitly relies on (git diff,
//     copy-paste between environments, copy-paste from docs). If any
//     field is lost or renamed in the export path, the round-trip fails.
//
// Conflict modes (RFC-054 plan): the import endpoint supports
// onConflict={fail,overwrite,new} via a query parameter. Each gets its
// own test below.

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures', 'import-files')
const SAMPLE_YAML = readFileSync(join(FIXTURES_DIR, 'sample-workflow.yaml'), 'utf-8')

test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
  // Pre-create the agent the workflow references so import won't fail
  // on missing-agent validation.
  await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'w2-7-sample-agent',
      description: 'sample agent for W2-7 import/export fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function importYaml(
  yaml: string,
  onConflict: 'fail' | 'overwrite' | 'new' = 'fail',
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/workflows/import?onConflict=${onConflict}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/yaml',
    },
    body: yaml,
  })
}

async function exportYaml(id: string): Promise<string> {
  const res = await fetch(`${daemon.baseUrl}/api/workflows/${id}/export`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  if (!res.ok) throw new Error(`export: ${res.status}`)
  return res.text()
}

async function deleteWorkflow(id: string): Promise<void> {
  await fetch(`${daemon.baseUrl}/api/workflows/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
}

interface WorkflowRow {
  id: string
  name: string
  description: string
  version: number
  definition: unknown
}

test.describe('RFC-054 W2-7 — YAML import / export', () => {
  test('fixture imports cleanly (HTTP 201) and produces a workflow row', async () => {
    const res = await importYaml(SAMPLE_YAML, 'fail')
    expect(res.status).toBe(201)
    const wf = (await res.json()) as WorkflowRow
    expect(wf.name).toBe('rfc054-w2-7-sample')
    expect(wf.id).toBeTruthy()
    expect(wf.definition).toBeTruthy()
    await deleteWorkflow(wf.id)
  })

  test('round-trip: imported YAML, exported, re-imported yields equivalent workflow definition', async () => {
    // 1. Import the fixture.
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = (await r1.json()) as WorkflowRow

    // 2. Export and snapshot the YAML.
    const yamlExported = await exportYaml(wf1.id)
    expect(yamlExported.length).toBeGreaterThan(0)
    // Sanity — exported YAML mentions the canonical name.
    expect(yamlExported).toContain('rfc054-w2-7-sample')

    // 3. Delete original.
    await deleteWorkflow(wf1.id)

    // 4. Re-import the EXPORTED YAML (not the original fixture) — locks
    //    that export → import is a closed loop. A drift in either
    //    direction (export drops a field / import requires a different
    //    shape) fails here.
    const r2 = await importYaml(yamlExported, 'fail')
    expect(r2.status).toBe(201)
    const wf2 = (await r2.json()) as WorkflowRow
    expect(wf2.name).toBe('rfc054-w2-7-sample')

    // 5. The two definitions must be structurally equivalent. We do a
    //    JSON deep-compare ignoring auto-assigned fields (id, internal
    //    timestamps). Drizzle definition is JSON-encoded text so the
    //    server-side store path doesn't matter.
    const def1 = typeof wf1.definition === 'string' ? JSON.parse(wf1.definition) : wf1.definition
    const def2 = typeof wf2.definition === 'string' ? JSON.parse(wf2.definition) : wf2.definition
    expect(def2).toEqual(def1)

    await deleteWorkflow(wf2.id)
  })

  // Conflict-resolution tests use the EXPORTED yaml (which includes the
  // server-assigned id) so onConflict actually triggers. The base fixture
  // intentionally omits `id` so it can be imported repeatedly without
  // conflict — these tests grab the assigned id post-import and inject
  // it into the second YAML payload.
  test('onConflict=fail: re-importing with the same id returns 4xx', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = (await r1.json()) as WorkflowRow

    // Export yields YAML with the id baked in — that's the artifact a
    // user would actually paste back to migrate between environments.
    const exported = await exportYaml(wf1.id)
    expect(exported).toContain(`id: ${wf1.id}`)

    const r2 = await importYaml(exported, 'fail')
    expect(r2.status).toBeGreaterThanOrEqual(400)
    expect(r2.status).toBeLessThan(500)

    await deleteWorkflow(wf1.id)
  })

  test('onConflict=overwrite: existing workflow is updated in place (id preserved)', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    const wf1 = (await r1.json()) as WorkflowRow

    const exported = await exportYaml(wf1.id)
    const r2 = await importYaml(exported, 'overwrite')
    expect(r2.status).toBe(201)
    const wf2 = (await r2.json()) as WorkflowRow

    // Same ID — overwrite preserves identity.
    expect(wf2.id).toBe(wf1.id)
    // Overwrite typically bumps version. Allow equal-or-greater so a
    // future "no-op overwrite stays at same version" optimization
    // doesn't break the test.
    expect(wf2.version).toBeGreaterThanOrEqual(wf1.version)

    await deleteWorkflow(wf2.id)
  })

  test('onConflict=new: re-importing with the same id produces a fresh row (id discarded)', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    const wf1 = (await r1.json()) as WorkflowRow

    const exported = await exportYaml(wf1.id)
    const r2 = await importYaml(exported, 'new')
    expect(r2.status).toBe(201)
    const wf2 = (await r2.json()) as WorkflowRow

    // Different ID — `new` discarded the imported id and minted a new one.
    expect(wf2.id).not.toBe(wf1.id)

    await deleteWorkflow(wf1.id)
    await deleteWorkflow(wf2.id)
  })

  test('empty YAML body is rejected with 4xx', async () => {
    const res = await importYaml('', 'fail')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('malformed YAML is rejected with 4xx (does not crash daemon)', async () => {
    const res = await importYaml('this is: not\n  a: valid\n: workflow', 'fail')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
