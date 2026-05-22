// LOCKS: RFC-057 — T2 repair options (task awaiting_human but no awaiting_human run).
// 2 options × 3 cases = 6 tests.

import { afterEach, describe, expect, test } from 'bun:test'

import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertClarifySession,
  insertNodeRun,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — T2.demote-task', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: awaiting_human task with no awaiting_human run → demote + resume', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T2',
      detail: { rule: 'T2', taskId: h.taskId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'T2.demote-task',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'interrupted' } })
  })

  test('preflight-stale: task no longer awaiting_human', async () => {
    h = await buildHarness({ taskStatus: 'running' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.demote-task')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.T2.unavailable.taskNotAwaitingHuman')
  })

  test('preview steps mention resumeTask + SQL', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_human' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.demote-task')
    expect(opt?.previewSteps.length).toBeGreaterThan(0)
    expect(opt?.previewSteps.some((s) => s.includes('resumeTask'))).toBe(true)
  })
})

describe('RFC-057 — T2.resurrect-clarify-run', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: terminal clarify run + open clarify_session → flip back to awaiting_human', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_human',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
        edges: [],
      },
    })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'awaiting_human',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'T2',
      detail: { rule: 'T2' },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'T2.resurrect-clarify-run',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, clarifyRunId)).toBe('awaiting_human')
  })

  test('preflight-stale: no terminal clarify run', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_human',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
        edges: [],
      },
    })
    await insertNodeRun(h.db, h.taskId, { nodeId: 'clarify_1', status: 'done' })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.resurrect-clarify-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T2.resurrectClarifyRun.unavailable.noCandidate',
    )
  })

  test('preflight-stale: terminal run exists but no open clarify_session', async () => {
    h = await buildHarness({
      taskStatus: 'awaiting_human',
      workflow: {
        $schema_version: 4,
        inputs: [],
        nodes: [{ id: 'clarify_1', kind: 'clarify' } as never],
        edges: [],
      },
    })
    const clarifyRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_1',
      status: 'interrupted',
    })
    // Closed session — preflight should refuse.
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: clarifyRunId,
      status: 'answered',
    })
    const alertId = await insertAlert(h.db, h.taskId, { rule: 'T2', detail: { rule: 'T2' } })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'T2.resurrect-clarify-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe(
      'diagnose.repair.T2.resurrectClarifyRun.unavailable.noOpenSession',
    )
  })
})
