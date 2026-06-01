// RFC-074 PR-A baseline — incident `01KSHVXCH6RQ5F5P64MZ4FZVN6` replay (A18-A20).
//
// WHY THIS FILE EXISTS (regression intent):
//   This is the before-photo of the bug RFC-074 fixes. The user approved a
//   review (v2, whose CONTENT had been refreshed to the agent's cci=8 output)
//   and 18ms later a SECOND awaiting_review row appeared forcing re-approval of
//   the very same content. Root cause (proposal §1.2): the review row was
//   minted at iterate time with `clarifyIteration=3`, then the reuse branch
//   refreshed its doc_version content to cci=6→7→8 WITHOUT ever updating
//   `row.clarifyIteration` (it stayed at the iterate-time value). On resume,
//   `runScope` → the Layer-B freshness invariant compared the review row's
//   STALE cci against the agent's cci=8 and judged it stale → minted a
//   spurious pending review.
//
//   A18 reproduces that spurious mint through the ACTUAL mechanism
//   (`applyClarifyFreshnessInvariant`). A19 pins the helper-level decision that
//   drives it. A20 is the fix target: had the review's recorded freshness
//   matched the content it actually reviewed (what PR-B's provenance achieves),
//   the invariant would mint nothing. PR-B (T-B13 / AC-2) must flip A18 green
//   for the right reason and keep A20 true.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { applyClarifyFreshnessInvariant } from '../src/services/scheduler'
import { isReviewClarifyAlignedWithUpstream } from '../src/services/review'
import { createLogger } from '../src/util/log'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test-incident-replay')

// Real incident identifiers, kept verbatim for traceability.
const TASK_ID = '01KSHVXCH6RQ5F5P64MZ4FZVN6'
const AGENT_NODE = 'designer'
const REVIEW_NODE = 'rev_5h9xpz'

async function seedIncidentTask(db: DbClient): Promise<void> {
  const wfId = `wf_${TASK_ID}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'incident',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: TASK_ID,
    name: 'incident-replay',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/incident',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert> & { id: string },
): Promise<typeof nodeRuns.$inferSelect> {
  await db.insert(nodeRuns).values({
    taskId: TASK_ID,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    ...fields,
  })
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, fields.id))
  return rows[0]!
}

function agentNode(id: string): WorkflowNode {
  return { id, kind: 'agent-single', agentName: 'x' } as WorkflowNode
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-074 PR-A baseline — incident 01KSHVXCH6 replay (A18-A20)', () => {
  // A18 — reproduce the spurious second review. Post-approve DB snapshot:
  //   designer: done rows at cci=6,7,8 (self-clarify progression after iterate)
  //   review  : done at cci=3 (iterate-time row), done at cci=6 (the approved
  //             row — content was refreshed to 8 but cci field stuck at 6)
  // The Layer-B invariant sees review.cci=6 < designer.cci=8 → demotes review
  // and mints a fresh awaiting_review pending at cci=8. THAT is the spurious row.
  test('A18: post-approve Layer-B mints a spurious cci=8 review (current buggy behavior)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedIncidentTask(db)
    await seedRun(db, AGENT_NODE, { id: '01AG_CCI6', clarifyIteration: 6 })
    await seedRun(db, AGENT_NODE, { id: '01AG_CCI7', clarifyIteration: 7 })
    const agentLatest = await seedRun(db, AGENT_NODE, { id: '01AG_CCI8', clarifyIteration: 8 })
    await seedRun(db, REVIEW_NODE, { id: '01RV_CCI3', clarifyIteration: 3 })
    // The approved review row — cci frozen at 6 (denormalization bug).
    const reviewApproved = await seedRun(db, REVIEW_NODE, { id: '01RV_CCI6', clarifyIteration: 6 })

    const allRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, TASK_ID))
    const completed = new Set([AGENT_NODE, REVIEW_NODE])
    await applyClarifyFreshnessInvariant({
      db,
      taskId: TASK_ID,
      iteration: 0,
      scopeNodes: [agentNode(AGENT_NODE), agentNode(REVIEW_NODE)],
      upstreamsOf: new Map([
        [AGENT_NODE, []],
        [REVIEW_NODE, [AGENT_NODE]],
      ]),
      priorRuns: allRuns,
      latestPerNode: new Map([
        [AGENT_NODE, agentLatest],
        [REVIEW_NODE, reviewApproved],
      ]),
      completed,
      remaining: new Map(),
      log,
    })

    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, TASK_ID), eq(nodeRuns.nodeId, REVIEW_NODE)))
    const spurious = reviewRows.find((r) => r.status === 'pending' && r.clarifyIteration === 8)
    // CURRENT (buggy) behavior: a spurious re-review is minted, and the review
    // node is demoted out of completed. PR-B (provenance) must eliminate this.
    expect(spurious, 'spurious cci=8 awaiting_review minted (the bug)').toBeDefined()
    expect(completed.has(REVIEW_NODE), 'review demoted (the bug)').toBe(false)
  })

  // A19 — the helper-level cause. The spurious decision flows from the review
  // approval row's STALE cci (6) being compared against the upstream's true cci
  // (8): the alignment check returns false → "upstream advanced, re-review".
  // The decision is correct GIVEN the inputs — the bug is the desynced input,
  // which provenance removes by stamping the actually-consumed run.
  test('A19: desynced approval (cci=6) vs upstream (cci=8) → alignment false (the root)', () => {
    const reviewApproved = { clarifyIteration: 6 } as unknown as typeof nodeRuns.$inferSelect
    const upstreamAtCci8 = { clarifyIteration: 8 } as unknown as typeof nodeRuns.$inferSelect
    expect(isReviewClarifyAlignedWithUpstream(reviewApproved, upstreamAtCci8)).toBe(false)
  })

  // A20 — the fix target. Had the review row recorded the freshness of the run
  // it ACTUALLY reviewed (cci=8 content → cci=8 stamp, which is exactly what
  // provenance's consumed-run id gives us), the invariant would see the review
  // as fresh and mint nothing. This is the post-fix invariant PR-B must hit.
  test('A20: if approval freshness matched reviewed content (cci=8) → no spurious mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedIncidentTask(db)
    const agentLatest = await seedRun(db, AGENT_NODE, { id: '01AG8', clarifyIteration: 8 })
    // Counterfactual: the approved review row carries cci=8 (== reviewed content).
    const reviewApproved = await seedRun(db, REVIEW_NODE, { id: '01RV8', clarifyIteration: 8 })
    const completed = new Set([AGENT_NODE, REVIEW_NODE])
    await applyClarifyFreshnessInvariant({
      db,
      taskId: TASK_ID,
      iteration: 0,
      scopeNodes: [agentNode(AGENT_NODE), agentNode(REVIEW_NODE)],
      upstreamsOf: new Map([
        [AGENT_NODE, []],
        [REVIEW_NODE, [AGENT_NODE]],
      ]),
      priorRuns: [agentLatest, reviewApproved],
      latestPerNode: new Map([
        [AGENT_NODE, agentLatest],
        [REVIEW_NODE, reviewApproved],
      ]),
      completed,
      remaining: new Map(),
      log,
    })
    expect(completed.has(REVIEW_NODE), 'review stays completed').toBe(true)
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, TASK_ID), eq(nodeRuns.nodeId, REVIEW_NODE)))
    expect(reviewRows.length, 'no spurious mint').toBe(1)
  })
})
