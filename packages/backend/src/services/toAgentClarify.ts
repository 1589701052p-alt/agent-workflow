// RFC-W004 - to-agent clarify business logic (PR-2 T9).
//
// Parallel to services/crossClarify.ts (RFC-056) + services/clarify.ts
// (RFC-023 self-clarify): different node kind, different answerer (an UPSTREAM
// AGENT A, not a human), but reuses the clarify_rounds unified table (kind=
// 'to-agent') + the awaiting_human status + the parked-intermediary-node_run
// pattern.
//
// Key architectural difference from cross-clarify:
//   - cross-clarify: B asks -> PARK (awaiting_human) -> HUMAN answers ->
//     dispatchTaskQuestions mints the designer A rerun. The trigger is
//     decoupled (human-REST-driven) and goes through routes/clarify.ts ->
//     autoDispatchClarifyRound.
//   - to-agent:      B asks -> PARK (awaiting_human) AND immediately MINT A's
//     answerer rerun (cause='clarify-to-agent-answer', status='pending',
//     inherits A's preSnapshot for worktree rollback). A is an AGENT - it
//     answers via the <workflow-clarify-answer> envelope in stdout, not a
//     human REST POST. So createToAgentSessionAndTriggerAnswerer is a
//     runner->service call (like createClarifySession), and the A answer
//     arrives via the runner parsing the envelope -> scheduler routes to
//     commitToAgentAnswerAndTriggerQuestioner.
//
//   - createToAgentSessionAndTriggerAnswerer: B emitted <workflow-clarify>.
//     Park to-agent node_run (awaiting_human) + insert clarify_rounds
//     (kind='to-agent', answererNodeId=A) + broadcast created + mint A's
//     answerer rerun (pending, cause='clarify-to-agent-answer').
//   - commitToAgentAnswerAndTriggerQuestioner: A emitted
//     <workflow-clarify-answer>. Seal the round (answered, answersJson) +
//     to-agent node_run awaiting_human->done + broadcast answered + mint B's
//     questioner rerun (pending, cause='clarify-to-agent-questioner-rerun',
//     inherits B's preSnapshot; the answer is injected as flat Q&A).
//   - escalateToHuman: A emitted <workflow-clarify> (it cannot answer). The
//     to-agent session stays awaiting_human; A's own RFC-023 self-clarify
//     channel parks A separately (existing path). Broadcast escalated.
//   - evaluateAnswererRerunReadiness: multi-source barrier. A rerun is
//     triggered ONLY when A has no in-flight answerer run (cause=
//     'clarify-to-agent-answer'); pending to-agent sessions pointing at A
//     feed the multi-source ## Clarify Request prompt assembly (design §3.4).

import type {
  ClarifyAnswerEnvelope,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRuns } from '@/db/schema'
import { setNodeRunStatus } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { ConflictError, NotFoundError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const log = createLogger('to-agent-clarify')

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export type ToAgentClarifySessionStatus = 'awaiting_human' | 'answered' | 'abandoned'

export interface ToAgentClarifySession {
  id: string
  taskId: string
  toAgentNodeId: string
  toAgentNodeRunId: string
  sourceQuestionerNodeId: string
  sourceQuestionerNodeRunId: string
  answererNodeId: string | null
  answererNodeRunId: string | null
  loopIter: number
  iteration: number
  questions: ClarifyQuestion[]
  /** A's answer markdown (set on commit). */
  answer: string | null
  status: ToAgentClarifySessionStatus
  createdAt: number
  answeredAt: number | null
  abandonedAt: number | null
}

// ---------------------------------------------------------------------------
// createToAgentSessionAndTriggerAnswerer - runner-side entry point.
// ---------------------------------------------------------------------------

export interface CreateToAgentSessionArgs {
  db: DbClient
  taskId: string
  /** Workflow nodeId of the to-agent clarify node. */
  toAgentNodeId: string
  /** Workflow nodeId of the questioner agent B (emitted <workflow-clarify>). */
  sourceQuestionerNodeId: string
  /** node_runs.id of the questioner B run that produced this envelope. */
  sourceQuestionerNodeRunId: string
  /** Workflow nodeId of the answerer agent A resolved from the to_answerer
   *  manual edge. Pass null only if the edge is missing at runtime (validator
   *  warns at edit time; runtime fails B's run - see createToAgentSession). */
  answererNodeId: string | null
  /** wrapper-loop iteration index (parent loop scope). 0 for non-loop. */
  loopIter: number
  /** Parsed to-agent envelope questions (already validated by the runner). */
  questions: ClarifyQuestion[]
  /** Non-fatal warnings from the parser; mirrors RFC-023 truncation surface. */
  truncationWarnings?: ClarifyTruncationWarning[]
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface CreateToAgentSessionResult {
  session: ToAgentClarifySession
  /** node_runs.id of the parked to-agent node_run owning this session. */
  toAgentNodeRunId: string
  /** node_runs.id of A's freshly-minted answerer rerun, or null when the
   *  multi-source barrier deferred it (A already has an in-flight answer run
   *  that will pick up this session's questions via prompt assembly). */
  answererNodeRunId: string | null
}

/**
 * Park a to-agent clarify session + trigger A's answerer rerun.
 *
 * Sequence (design §3.1):
 *   1. Derive iteration index (max prior + 1 for this node+loopIter).
 *   2. Mint the to-agent node_run parked at awaiting_human (cause=
 *      'clarify-to-agent-park').
 *   3. Insert clarify_rounds (kind='to-agent', answererNodeId=A,
 *      answererNodeRunId=null until A answers).
 *   4. Broadcast clarify-to-agent.created.
 *   5. evaluateAnswererRerunReadiness: if A has no in-flight answerer run,
 *      mint A's answerer rerun (pending, cause='clarify-to-agent-answer',
 *      inherits A's freshest preSnapshot). If A is already answering, defer
 *      (the in-flight run's prompt will assemble this session's questions).
 *
 * Throws ConflictError('clarify-to-agent-answerer-missing-at-runtime') when
 * answererNodeId is null (the to_answerer edge resolved to no node at runtime).
 */
export async function createToAgentSessionAndTriggerAnswerer(
  args: CreateToAgentSessionArgs,
): Promise<CreateToAgentSessionResult> {
  if (args.answererNodeId === null) {
    // design §7 - the to_answerer edge target vanished at runtime (validator
    // warned at edit time but didn't block save). Fail B's run.
    throw new ConflictError(
      'clarify-to-agent-answerer-missing-at-runtime',
      `to-agent node '${args.toAgentNodeId}' has no answerer (to_answerer edge unresolved at runtime)`,
    )
  }

  const now = args.now ?? Date.now
  const createdAt = now()

  // 1. Iteration index: max(existing.iteration) + 1 for (node, loopIter).
  const prior = await args.db
    .select({ iteration: clarifyRounds.iteration })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.intermediaryNodeId, args.toAgentNodeId),
        eq(clarifyRounds.loopIter, args.loopIter),
        eq(clarifyRounds.kind, 'to-agent'),
      ),
    )
    .orderBy(desc(clarifyRounds.iteration))
    .limit(1)
  const iteration = prior.length === 0 ? 0 : (prior[0]?.iteration ?? 0) + 1

  // 2. Mint the parked to-agent node_run (awaiting_human, cause=park).
  const toAgentNodeRunId = await mintNodeRun(args.db, {
    taskId: args.taskId,
    nodeId: args.toAgentNodeId,
    status: 'awaiting_human',
    cause: 'clarify-to-agent-park',
    iteration: args.loopIter,
    overrides: { startedAt: createdAt },
  })

  // 3. Insert clarify_rounds (kind='to-agent').
  const sessionId = ulid()
  const questionsJson = JSON.stringify(args.questions)
  await args.db.insert(clarifyRounds).values({
    id: sessionId,
    taskId: args.taskId,
    kind: 'to-agent',
    askingNodeId: args.sourceQuestionerNodeId,
    askingNodeRunId: args.sourceQuestionerNodeRunId,
    askingShardKey: null,
    intermediaryNodeId: args.toAgentNodeId,
    intermediaryNodeRunId: toAgentNodeRunId,
    targetConsumerNodeId: null, // to-agent has no designer consumer
    answererNodeId: args.answererNodeId,
    answererNodeRunId: null, // set on commit (A answers)
    loopIter: args.loopIter,
    iteration,
    questionsJson,
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt: null,
    answeredBy: null,
  })

  if (args.truncationWarnings && args.truncationWarnings.length > 0) {
    log.warn('to-agent clarify envelope truncated to limits', {
      sessionId,
      warnings: args.truncationWarnings.map((w) => w.code),
    })
  }

  const session: ToAgentClarifySession = {
    id: sessionId,
    taskId: args.taskId,
    toAgentNodeId: args.toAgentNodeId,
    toAgentNodeRunId,
    sourceQuestionerNodeId: args.sourceQuestionerNodeId,
    sourceQuestionerNodeRunId: args.sourceQuestionerNodeRunId,
    answererNodeId: args.answererNodeId,
    answererNodeRunId: null,
    loopIter: args.loopIter,
    iteration,
    questions: args.questions,
    answer: null,
    status: 'awaiting_human',
    createdAt,
    answeredAt: null,
    abandonedAt: null,
  }
  broadcastToAgentCreated(args.taskId, session)

  // 5. Multi-source barrier + trigger A's answerer rerun.
  const readiness = await evaluateAnswererRerunReadiness({
    db: args.db,
    taskId: args.taskId,
    answererNodeId: args.answererNodeId,
    definition: undefined, // not needed - we query clarify_rounds directly
    loopIter: args.loopIter,
    // The freshly-parked session is pending; it should feed A's prompt.
  })
  let answererNodeRunId: string | null = null
  if (readiness.ready) {
    answererNodeRunId = await triggerAnswererRerun(args.db, {
      taskId: args.taskId,
      answererNodeId: args.answererNodeId,
      loopIter: args.loopIter,
      now,
    })
  } else {
    log.info('to-agent answerer rerun deferred (A already answering)', {
      taskId: args.taskId,
      answererNodeId: args.answererNodeId,
      pendingSessionCount: readiness.pendingSessions.length,
    })
  }

  return { session, toAgentNodeRunId, answererNodeRunId }
}

// ---------------------------------------------------------------------------
// triggerAnswererRerun - mint A's answerer node_run (cause=clarify-to-agent-answer).
// ---------------------------------------------------------------------------

/**
 * Mint A's answerer rerun: a fresh 'pending' node_run for the answerer agent A
 * that inherits A's freshest run's preSnapshot (for worktree rollback to A's
 * pre-clarify state, mirroring self-clarify's resolveSelfRollbackRun). The
 * scheduler picks up the pending row on its next frontier tick and injects the
 * `## Clarify Request` block (design §6.1, T13). Does NOT roll back the
 * worktree here - rollback is the scheduler's rollbackNodeRunWorktrees call at
 * dispatch (isolated mode), same as self-clarify.
 */
async function triggerAnswererRerun(
  db: DbClient,
  args: { taskId: string; answererNodeId: string; loopIter: number; now: () => number },
): Promise<string> {
  // A's freshest run to inherit preSnapshot + iteration from. ULID `id` is
  // monotonic-time-ordered, so ordering by id desc gives the most recent row
  // (node_runs has no createdAt; startedAt is null on parked rows).
  const freshest = (
    await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.answererNodeId)))
      .orderBy(desc(nodeRuns.id))
      .limit(1)
  )[0]

  const answererNodeRunId = await mintNodeRun(db, {
    taskId: args.taskId,
    nodeId: args.answererNodeId,
    status: 'pending',
    cause: 'clarify-to-agent-answer',
    iteration: args.loopIter,
    inheritFrom: freshest ?? null,
    overrides: { startedAt: null },
  })
  log.info('to-agent answerer rerun minted', {
    taskId: args.taskId,
    answererNodeId: args.answererNodeId,
    answererNodeRunId,
    inheritedPreSnapshot: freshest?.preSnapshot ?? null,
  })
  return answererNodeRunId
}

// ---------------------------------------------------------------------------
// commitToAgentAnswerAndTriggerQuestioner - A answered -> seal + trigger B.
// ---------------------------------------------------------------------------

export interface CommitToAgentAnswerArgs {
  db: DbClient
  taskId: string
  /** node_runs.id of A's answerer run that produced the
   *  <workflow-clarify-answer> envelope. */
  answererNodeRunId: string
  /** The parsed answer envelope ({ markdown }). */
  answer: ClarifyAnswerEnvelope
  /** Workflow definition (to resolve the questioner B nodeId per to-agent
   *  session for B's rerun). */
  definition: WorkflowDefinition
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface CommitToAgentAnswerResult {
  /** The to-agent session(s) sealed by this answer. Multi-source: A's single
   *  answer covers every awaiting_human to-agent session pointing at A. */
  sealedSessions: ToAgentClarifySession[]
  /** node_runs.id of B's freshly-minted questioner rerun(s) (one per sealed
   *  session's questioner). */
  questionerNodeRunIds: string[]
}

/**
 * A emitted <workflow-clarify-answer>. Seal every awaiting_human to-agent
 * session pointing at A (design §3.4 multi-source: A's single answer covers
 * all pending to-agent sessions for A), transition each to-agent node_run
 * awaiting_human->done, broadcast answered, and mint B's questioner rerun
 * (cause='clarify-to-agent-questioner-rerun', inherits B's preSnapshot).
 *
 * The answer markdown is stored on each sealed session's answersJson; T13
 * injects it into B's flat `## Clarify Q&A` block as a peer entry.
 */
export async function commitToAgentAnswerAndTriggerQuestioner(
  args: CommitToAgentAnswerArgs,
): Promise<CommitToAgentAnswerResult> {
  const now = args.now ?? Date.now
  const sealedAt = now()

  // Resolve the answerer A nodeId from the answerer run row.
  const answererRun = (
    await args.db
      .select({ nodeId: nodeRuns.nodeId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.answererNodeRunId))
      .limit(1)
  )[0]
  if (answererRun === undefined) {
    throw new NotFoundError(
      'node-run-not-found',
      `answerer node_run ${args.answererNodeRunId} not found`,
    )
  }
  const answererNodeId = answererRun.nodeId

  // Collect every awaiting_human to-agent session pointing at A (multi-source).
  const pendingRows = await args.db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'to-agent'),
        eq(clarifyRounds.status, 'awaiting_human'),
        eq(clarifyRounds.answererNodeId, answererNodeId),
      ),
    )
    .orderBy(desc(clarifyRounds.createdAt))

  if (pendingRows.length === 0) {
    // No pending session - A answered without a to-agent ask (e.g. A also has
    // a self-clarify). This is a no-op (the answer envelope is spurious for
    // to-agent). The runner's mutual-exclusion check (T10) should have caught
    // a stray answer; reaching here is a defensive no-op.
    log.warn('to-agent answer with no pending session', {
      taskId: args.taskId,
      answererNodeId,
      answererNodeRunId: args.answererNodeRunId,
    })
    return { sealedSessions: [], questionerNodeRunIds: [] }
  }

  const answerJson = JSON.stringify(args.answer.markdown)
  const sealedSessions: ToAgentClarifySession[] = []
  const questionerNodeRunIds: string[] = []

  for (const row of pendingRows) {
    // Seal the round: answered + answersJson + answererNodeRunId + answeredAt.
    await args.db
      .update(clarifyRounds)
      .set({
        status: 'answered',
        answersJson: answerJson,
        answererNodeRunId: args.answererNodeRunId,
        answeredAt: sealedAt,
        answeredBy: null, // to-agent: the answerer is agent A, not a human user
      })
      .where(eq(clarifyRounds.id, row.id))

    // Transition the to-agent node_run awaiting_human -> done (resume-clarify).
    await setNodeRunStatus({
      db: args.db,
      nodeRunId: row.intermediaryNodeRunId,
      to: 'done',
      allowedFrom: ['awaiting_human'],
      reason: 'to-agent-answered',
    })

    const session = rowToSession(row, {
      status: 'answered',
      answer: args.answer.markdown,
      answererNodeRunId: args.answererNodeRunId,
      answeredAt: sealedAt,
    })
    sealedSessions.push(session)
    broadcastToAgentAnswered(args.taskId, session)

    // Mint B's questioner rerun (cause='clarify-to-agent-questioner-rerun').
    // B resumes its session carrying A's answer (flat Q&A peer entry, T13).
    const questionerNodeRunId = await triggerQuestionerRerun(args.db, {
      taskId: args.taskId,
      questionerNodeId: row.askingNodeId,
      loopIter: row.loopIter,
      now,
    })
    questionerNodeRunIds.push(questionerNodeRunId)
  }

  log.info('to-agent answer committed', {
    taskId: args.taskId,
    answererNodeId,
    sealedCount: sealedSessions.length,
  })

  return { sealedSessions, questionerNodeRunIds }
}

/**
 * Mint B's questioner rerun: a fresh 'pending' node_run that resumes B's
 * session (cause='clarify-to-agent-questioner-rerun' is in isClarifyRerunCause
 * -> gate-2 inline-session resume + flat Q&A injection, design §6.3).
 */
async function triggerQuestionerRerun(
  db: DbClient,
  args: { taskId: string; questionerNodeId: string; loopIter: number; now: () => number },
): Promise<string> {
  const freshest = (
    await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, args.taskId), eq(nodeRuns.nodeId, args.questionerNodeId)))
      .orderBy(desc(nodeRuns.id))
      .limit(1)
  )[0]

  const questionerNodeRunId = await mintNodeRun(db, {
    taskId: args.taskId,
    nodeId: args.questionerNodeId,
    status: 'pending',
    cause: 'clarify-to-agent-questioner-rerun',
    iteration: args.loopIter,
    inheritFrom: freshest ?? null,
    overrides: { startedAt: null },
  })
  return questionerNodeRunId
}

// ---------------------------------------------------------------------------
// escalateToHuman - A cannot answer -> A's self-clarify parks separately.
// ---------------------------------------------------------------------------

export interface EscalateToHumanArgs {
  db: DbClient
  taskId: string
  /** node_runs.id of A's answerer run that emitted <workflow-clarify>
   *  (A could not answer, escalates to a human via its own RFC-023 channel). */
  answererNodeRunId: string
  /** Defaults to Date.now(). */
  now?: () => number
}

export interface EscalateToHumanResult {
  /** The to-agent session(s) that remain awaiting_human (A will answer B
   *  after A gets its human answer and re-emits the answer envelope). */
  escalatedSessions: ToAgentClarifySession[]
}

/**
 * A emitted <workflow-clarify> instead of <workflow-clarify-answer> (it cannot
 * answer B's question). The to-agent session(s) pointing at A STAY
 * awaiting_human (A hasn't answered B yet). A's own RFC-023 self-clarify
 * channel parks A separately (the existing scheduler self-clarify path mints
 * A's self-clarify session + A's self-clarify node_run awaiting_human). This
 * function only broadcasts the escalated event so the UI can show the
 * to-agent node as "A is asking a human" (design §3.3).
 *
 * After the human answers A's self-clarify, A re-runs and (now knowing the
 * answer) emits <workflow-clarify-answer> -> commitToAgentAnswerAndTriggerQuestioner.
 */
export async function escalateToHuman(args: EscalateToHumanArgs): Promise<EscalateToHumanResult> {
  const answererRun = (
    await args.db
      .select({ nodeId: nodeRuns.nodeId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.answererNodeRunId))
      .limit(1)
  )[0]
  if (answererRun === undefined) {
    throw new NotFoundError(
      'node-run-not-found',
      `answerer node_run ${args.answererNodeRunId} not found`,
    )
  }

  // Every awaiting_human to-agent session pointing at A stays awaiting_human.
  const rows = await args.db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'to-agent'),
        eq(clarifyRounds.status, 'awaiting_human'),
        eq(clarifyRounds.answererNodeId, answererRun.nodeId),
      ),
    )

  const escalatedSessions = rows.map((row) => rowToSession(row))
  for (const session of escalatedSessions) {
    broadcastToAgentEscalated(args.taskId, session)
  }
  log.info('to-agent escalated to human (A self-clarify)', {
    taskId: args.taskId,
    answererNodeId: answererRun.nodeId,
    escalatedCount: escalatedSessions.length,
  })
  return { escalatedSessions }
}

// ---------------------------------------------------------------------------
// evaluateAnswererRerunReadiness - multi-source barrier.
// ---------------------------------------------------------------------------

export interface EvaluateAnswererRerunReadinessArgs {
  db: DbClient
  taskId: string
  answererNodeId: string
  /** The workflow definition (used to enumerate sibling to-agent nodes
   *  pointing at A). Optional - when omitted, readiness is computed purely
   *  from clarify_rounds rows (the freshly-parked session is included). */
  definition?: WorkflowDefinition
  loopIter: number
}

export interface AnswererRerunReadinessSource {
  sessionId: string
  toAgentNodeId: string
  sourceQuestionerNodeId: string
  iteration: number
  questions: ClarifyQuestion[]
}

export interface AnswererRerunReadiness {
  /** ready=true ⟺ A has no in-flight answerer run AND ≥1 pending to-agent
   *  session points at A (there's something for A to answer). When false, A
   *  is already answering (the in-flight run's prompt will assemble the
   *  pending sessions' questions) - do NOT trigger a duplicate A run. */
  ready: boolean
  /** The awaiting_human to-agent sessions pointing at A (feed the
   *  ## Clarify Request prompt assembly, design §3.4). */
  pendingSessions: AnswererRerunReadinessSource[]
  /** True when A has an in-flight answerer run (cause='clarify-to-agent-answer',
   *  status pending|running). */
  hasInFlightAnswererRun: boolean
}

/**
 * Multi-source barrier (design §3.1.2 / §3.4). A answerer rerun is triggered
 * ONLY when A has no in-flight answer run; the pending to-agent sessions
 * (multiple B's asking A) feed a single A run's ## Clarify Request prompt.
 *
 * Unlike cross-clarify's evaluateDesignerRerunReadiness (which waits for ALL
 * siblings to resolve before triggering the designer), to-agent triggers A
 * immediately on the FIRST ask - the barrier is about not DOUBLE-triggering A
 * while it's already answering, not about batching waits.
 */
export async function evaluateAnswererRerunReadiness(
  args: EvaluateAnswererRerunReadinessArgs,
): Promise<AnswererRerunReadiness> {
  // Pending to-agent sessions pointing at A (awaiting_human).
  const pendingRows = await args.db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'to-agent'),
        eq(clarifyRounds.status, 'awaiting_human'),
        eq(clarifyRounds.answererNodeId, args.answererNodeId),
      ),
    )
    .orderBy(desc(clarifyRounds.createdAt))

  const pendingSessions = pendingRows.map((row) => ({
    sessionId: row.id,
    toAgentNodeId: row.intermediaryNodeId,
    sourceQuestionerNodeId: row.askingNodeId,
    iteration: row.iteration,
    questions: JSON.parse(row.questionsJson) as ClarifyQuestion[],
  }))

  // In-flight A answerer run: cause='clarify-to-agent-answer' AND status in
  // pending|running (A hasn't finished answering yet).
  const inFlight = (
    await args.db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, args.taskId),
          eq(nodeRuns.nodeId, args.answererNodeId),
          eq(nodeRuns.rerunCause, 'clarify-to-agent-answer'),
          inArray(nodeRuns.status, ['pending', 'running']),
        ),
      )
      .limit(1)
  )[0]
  const hasInFlightAnswererRun = inFlight !== undefined

  const ready = pendingSessions.length > 0 && !hasInFlightAnswererRun
  return { ready, pendingSessions, hasInFlightAnswererRun }
}

// ---------------------------------------------------------------------------
// broadcasters - mirror crossClarify.ts shape.
// ---------------------------------------------------------------------------

function broadcastToAgentCreated(taskId: string, session: ToAgentClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify-to-agent.created',
    nodeRunId: session.toAgentNodeRunId,
    toAgentNodeId: session.toAgentNodeId,
    sessionId: session.id,
    iteration: session.iteration,
    sourceQuestionerNodeId: session.sourceQuestionerNodeId,
    answererNodeId: session.answererNodeId,
  })
}

function broadcastToAgentAnswered(taskId: string, session: ToAgentClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify-to-agent.answered',
    nodeRunId: session.toAgentNodeRunId,
    sessionId: session.id,
    iteration: session.iteration,
    answererNodeId: session.answererNodeId ?? '',
  })
}

function broadcastToAgentEscalated(taskId: string, session: ToAgentClarifySession): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'clarify-to-agent.escalated',
    nodeRunId: session.toAgentNodeRunId,
    sessionId: session.id,
    iteration: session.iteration,
    answererNodeId: session.answererNodeId ?? '',
  })
}

// ---------------------------------------------------------------------------
// read helpers (minimal - full read side is T18).
// ---------------------------------------------------------------------------

function rowToSession(
  row: typeof clarifyRounds.$inferSelect,
  overrides?: Partial<ToAgentClarifySession>,
): ToAgentClarifySession {
  return {
    id: row.id,
    taskId: row.taskId,
    toAgentNodeId: row.intermediaryNodeId,
    toAgentNodeRunId: row.intermediaryNodeRunId,
    sourceQuestionerNodeId: row.askingNodeId,
    sourceQuestionerNodeRunId: row.askingNodeRunId,
    answererNodeId: row.answererNodeId,
    answererNodeRunId: row.answererNodeRunId,
    loopIter: row.loopIter,
    iteration: row.iteration,
    questions: JSON.parse(row.questionsJson) as ClarifyQuestion[],
    answer: row.answersJson,
    status: row.status as ToAgentClarifySessionStatus,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    abandonedAt: row.abandonedAt,
    ...overrides,
  }
}

/**
 * Abandon awaiting_human to-agent sessions whose answerer A's run has reached
 * a terminal failure (failed/canceled). Called by the RFC-053 invariant scan
 * (T15) + task failure. Idempotent: already-abandoned/answered rows are
 * skipped (status filter).
 */
export async function abandonToAgentSessionsForFailedAnswerer(
  db: DbClient,
  args: { taskId: string; answererNodeId: string; now?: () => number },
): Promise<number> {
  const now = args.now ?? Date.now
  const abandonedAt = now()
  const updated = await db
    .update(clarifyRounds)
    .set({ status: 'abandoned', abandonedAt })
    .where(
      and(
        eq(clarifyRounds.taskId, args.taskId),
        eq(clarifyRounds.kind, 'to-agent'),
        eq(clarifyRounds.status, 'awaiting_human'),
        eq(clarifyRounds.answererNodeId, args.answererNodeId),
      ),
    )
    .returning({ id: clarifyRounds.id })
  return updated.length
}

/** Re-export the inverse-lookup helper for the scheduler / canvas. */
export { findToAgentNodesPointingToAnswerer } from '@agent-workflow/shared'
