// LOCKS: RFC-057 — R1 repair options (approved doc_version but review run not done).
// 3 options × 3 cases = 9 tests.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { docVersions, nodeRunOutputs } from '../src/db/schema'
import { applyRepairOption, listRepairOptionsForAlert } from '../src/services/lifecycleRepair'
import {
  buildHarness,
  insertAlert,
  insertDocVersion,
  insertNodeRun,
  readAlert,
  readAuditRows,
  readNodeRunStatus,
  settleResumes,
  type RepairHarness,
} from './lifecycle-repair-harness'

describe('RFC-057 — R1.approve-run', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc approved + run awaiting_review → run goes done + outputs upserted', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
      versionIndex: 3,
      reviewIteration: 2,
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: {
        rule: 'R1',
        docVersionId: dvId,
        reviewNodeRunId: reviewRunId,
        reviewNodeId: 'rev_1',
        actualStatus: 'awaiting_review',
      },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: 'u-1',
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('done')

    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, reviewRunId))
    const ports = outputs.map((o) => o.portName).sort()
    expect(ports).toContain('approved_doc')
    expect(ports).toContain('approval_meta')

    const alert = await readAlert(h.db, alertId)
    expect(alert?.resolvedAt).not.toBeNull()
  })

  test('happy variant: terminal-non-done run + doc approved → still force-done via allowTerminal', async () => {
    h = await buildHarness({ taskStatus: 'failed' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'interrupted',
      finishedAt: Date.now(),
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.approve-run',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('done')
  })

  test('preflight-stale: run already done', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.approve-run')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.runAlreadyDone')
  })
})

describe('RFC-057 — R1.unapprove-doc', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: doc → pending, decided_at/by cleared; run untouched', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.unapprove-doc',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    expect(await readNodeRunStatus(h.db, reviewRunId)).toBe('awaiting_review')
    const dvAfter = (
      await h.db.select().from(docVersions).where(eq(docVersions.id, dvId)).limit(1)
    )[0]!
    expect(dvAfter.decision).toBe('pending')
    expect(dvAfter.decidedAt).toBeNull()
    expect(dvAfter.decidedBy).toBeNull()
  })

  test('preflight-stale: doc not approved', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'pending',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.docNotApproved')
  })

  test('detail drift: docVersionId in alert points to deleted row', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: 'missing-doc-id', reviewNodeRunId: 'missing-run' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.unapprove-doc')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.detailDrift')
  })
})

describe('RFC-057 — R1.mark-task-failed', () => {
  let h: RepairHarness
  afterEach(async () => {
    await settleResumes()
    h?.cleanup()
  })

  test('happy: non-terminal task → failed', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const res = await applyRepairOption({
      db: h.db,
      taskId: h.taskId,
      alertId,
      optionId: 'R1.mark-task-failed',
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    expect(res.outcome).toBe('success')
    const audits = await readAuditRows(h.db, h.taskId)
    expect(audits[0]!.afterSnapshot).toMatchObject({ task: { status: 'failed' } })
  })

  test('preflight-stale: task already terminal', async () => {
    h = await buildHarness({ taskStatus: 'done' })
    const reviewRunId = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
    })
    const dvId = await insertDocVersion(h.db, h.taskId, {
      reviewNodeRunId: reviewRunId,
      reviewNodeId: 'rev_1',
      decision: 'approved',
    })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1', docVersionId: dvId, reviewNodeRunId: reviewRunId },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.available).toBe(false)
    expect(opt?.unavailableReasonKey).toBe('diagnose.repair.R1.unavailable.taskTerminal')
  })

  test('destructive flag + high risk on mark-task-failed', async () => {
    h = await buildHarness({ taskStatus: 'awaiting_review' })
    const alertId = await insertAlert(h.db, h.taskId, {
      rule: 'R1',
      detail: { rule: 'R1' },
    })
    const list = await listRepairOptionsForAlert({
      db: h.db,
      taskId: h.taskId,
      alertId,
      actorUserId: null,
      appHome: h.tmpDir,
      deps: h.deps,
    })
    const opt = list.options.find((o) => o.id === 'R1.mark-task-failed')
    expect(opt?.destructive).toBe(true)
    expect(opt?.risk).toBe('high')
  })
})
