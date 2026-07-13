// RFC-W002 - 交互时间线 feed (task「评论区」). Pure, runtime-agnostic aggregation
// of the four interaction types a task accumulates over its lifetime:
//
//   1. human_input    - the launcher form values (the original requirement)
//   2. node_output    - a done agent node_run's parsed port content
//   3. clarify_question / clarify_answer - an agent's ask-back round + the human answer
//   4. review_decision - a human approve/reject/iterate on a reviewed doc version
//
// All "原始信息" lives in dedicated columns across tasks / node_runs /
// node_run_outputs / clarify_rounds / doc_versions / review_comments. This module
// UNIONs them into one chronologically ordered list. It is PURE (zero IO): the
// backend route maps DB rows to the Feed*Input shapes below and calls
// buildInteractionFeed; tests call it directly with mock data. This is the
// CLAUDE.md「首选可断言面」pure-data oracle for the timeline.
//
// Ordering: primary key is the per-event semantic timestamp `ts`; the ULID
// `sortId` is a monotonic tiebreaker so two events with equal ts still order
// deterministically (ULIDs are time-prefixed, so lexical order = creation order).
// A clarify round splits into TWO events - question (createdAt) and answer
// (answeredAt) - so "ask -> answer" sequencing stays correct even though they
// share a round row.

import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { WorkflowDefinition } from './schemas/workflow'

// -----------------------------------------------------------------------------
// output contract (returned by GET /api/tasks/:taskId/interaction-feed)
// -----------------------------------------------------------------------------

export type InteractionKind =
  | 'human_input'
  | 'node_output'
  | 'clarify_question'
  | 'clarify_answer'
  | 'review_decision'

export interface InteractionPortOutput {
  portName: string
  content: string
  kind: string | null
}

export interface InteractionReviewComment {
  selectedText: string | null
  commentText: string
  author: string | null
}

export interface InteractionJumpTarget {
  /** 'session' jumps to the node_run's Session tab; 'clarify' to /clarify/<runId>;
   *  'review' to /reviews/<runId>. */
  kind: 'session' | 'clarify' | 'review'
  nodeRunId?: string
  roundId?: string
  docVersionId?: string
}

export interface InteractionItem {
  id: string
  kind: InteractionKind
  /** Event timestamp (ms) - primary sort key. */
  ts: number
  /** ULID tiebreaker - secondary sort key (keeps equal-ts events monotonic). */
  sortId: string
  /** Workflow node id the interaction is anchored to (absent for human_input). */
  nodeId?: string
  /** node_run id (the asking run for clarify, the producing run for output,
   *  the review node run for review_decision). */
  nodeRunId?: string
  /** Agent name resolved from the workflow snapshot (agent-single nodes). */
  agentName?: string
  /** Resolved display name (title ?? agentName ?? nodeId). */
  nodeName?: string
  // kind-specific payload (only the matching field is populated):
  /** human_input */
  inputs?: Record<string, string>
  /** node_output - one entry per declared port the run produced. */
  outputs?: InteractionPortOutput[]
  /** clarify_question */
  questions?: ClarifyQuestion[]
  /** clarify_answer */
  answers?: ClarifyAnswer[]
  /** review_decision */
  review?: {
    decision: string
    reason: string | null
    comments: InteractionReviewComment[]
  }
  jumpTarget?: InteractionJumpTarget
}

export interface InteractionFeedResult {
  items: InteractionItem[]
  /** Total item count before the cap was applied (items.length when not truncated). */
  total: number
  /** True when total > INTERACTION_FEED_MAX_ITEMS (the oldest items were dropped). */
  truncated: boolean
}

/** Hard cap on returned items. The most recent N are kept when exceeded; the
 *  `truncated` flag surfaces this to the UI. Generous for typical tasks (tens
 *  to low hundreds of interactions); loop-heavy tasks that exceed it get a
 *  notice. Cursor pagination is a future enhancement (see RFC-W002 design §4.2). */
export const INTERACTION_FEED_MAX_ITEMS = 1000

// -----------------------------------------------------------------------------
// input shapes (DB-row-like plain objects; the backend maps drizzle rows to these)
// -----------------------------------------------------------------------------

export interface FeedTaskInput {
  id: string
  startedAt: number | null
  /** JSON `Record<string,string>` of launcher form values (tasks.inputs). */
  inputsJson: string | null
}

export interface FeedNodeRunInput {
  id: string
  nodeId: string
  status: string
  finishedAt: number | null
}

export interface FeedOutputInput {
  nodeRunId: string
  portName: string
  content: string
  kind: string | null
}

export interface FeedClarifyRoundInput {
  id: string
  /** self (RFC-023) / cross (RFC-056) / to-agent (RFC-W004). The feed surfaces
   *  every clarify family's interaction; to-agent rendering lands in PR-2. */
  kind: 'self' | 'cross' | 'to-agent'
  /** The agent node that asked (askingNodeId). */
  askingNodeId: string
  /** The clarify / clarify-cross-agent node's run (jump target for the detail page). */
  intermediaryNodeRunId: string
  status: string
  /** JSON `ClarifyQuestion[]`. */
  questionsJson: string
  /** JSON `ClarifyAnswer[]`; null until submitted. */
  answersJson: string | null
  createdAt: number
  answeredAt: number | null
}

export interface FeedDocVersionInput {
  id: string
  /** The review node's run (jump target for /reviews/<runId>). */
  reviewNodeRunId: string
  /** The node whose output was reviewed. */
  sourceNodeId: string
  decision: string
  decisionReason: string | null
  /** JSON `ReviewComment[]` frozen at decision time (kept for completeness; the
   *  live `review_comments` rows are the primary comment source). */
  commentsJson: string | null
  decidedAt: number | null
}

export interface FeedReviewCommentInput {
  docVersionId: string
  selectedText: string | null
  commentText: string
  author: string | null
}

export interface BuildInteractionFeedArgs {
  task: FeedTaskInput
  nodeRuns: FeedNodeRunInput[]
  outputs: FeedOutputInput[]
  clarifyRounds: FeedClarifyRoundInput[]
  docVersions: FeedDocVersionInput[]
  reviewComments: FeedReviewCommentInput[]
  /** JSON `WorkflowDefinition` (tasks.workflowSnapshot). Parsed defensively;
   *  a corrupt snapshot degrades to nodeId fallbacks, never throws. */
  workflowSnapshot: string
}

// -----------------------------------------------------------------------------
// node-name resolution (mirrors backend clarify.ts loadNodeTitlesByTask +
// frontend nodeTitle(): title wins, then agentName, then nodeId)
// -----------------------------------------------------------------------------

interface NodeMeta {
  name: string
  agentName?: string
}

function resolveNodeNames(snapshotJson: string): Map<string, NodeMeta> {
  const out = new Map<string, NodeMeta>()
  try {
    const def = JSON.parse(snapshotJson) as WorkflowDefinition
    for (const node of def.nodes ?? []) {
      const rec = node as Record<string, unknown>
      const title = typeof rec.title === 'string' ? rec.title.trim() : ''
      const agentName = typeof rec.agentName === 'string' ? rec.agentName : undefined
      const name = title.length > 0 ? title : (agentName ?? node.id)
      out.set(node.id, { name, agentName })
    }
  } catch {
    // corrupt snapshot - callers fall back to nodeId
  }
  return out
}

// -----------------------------------------------------------------------------
// defensive JSON parsers (stored data is trusted, but a corrupt row must never
// crash the whole feed - the offending item is skipped)
// -----------------------------------------------------------------------------

function parseInputs(json: string | null): Record<string, string> | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = typeof val === 'string' ? val : JSON.stringify(val)
    }
    return out
  } catch {
    return null
  }
}

function safeParseArray<T>(json: string | null | undefined): T[] | undefined {
  if (!json) return undefined
  try {
    const v = JSON.parse(json)
    if (Array.isArray(v)) return v as T[]
    return undefined
  } catch {
    return undefined
  }
}

// -----------------------------------------------------------------------------
// main builder
// -----------------------------------------------------------------------------

/**
 * Aggregate the four interaction sources into one chronologically ordered
 * `InteractionItem[]`. Pure: no IO, no clocks (uses the timestamps passed in).
 *
 * Ordering: `(ts asc, sortId asc)`. The cap keeps the most recent
 * {@link INTERACTION_FEED_MAX_ITEMS} items when exceeded.
 */
export function buildInteractionFeed(args: BuildInteractionFeedArgs): InteractionFeedResult {
  const names = resolveNodeNames(args.workflowSnapshot)
  const items: InteractionItem[] = []

  // 1. human input (one per task; the original requirement)
  const inputs = parseInputs(args.task.inputsJson)
  if (inputs !== null) {
    items.push({
      id: `input:${args.task.id}`,
      kind: 'human_input',
      ts: args.task.startedAt ?? 0,
      sortId: args.task.id,
      inputs,
    })
  }

  // 2. node outputs (one card per done run that produced >=1 port)
  const outputsByRun = new Map<string, InteractionPortOutput[]>()
  for (const o of args.outputs) {
    let list = outputsByRun.get(o.nodeRunId)
    if (!list) {
      list = []
      outputsByRun.set(o.nodeRunId, list)
    }
    list.push({ portName: o.portName, content: o.content, kind: o.kind })
  }
  for (const run of args.nodeRuns) {
    if (run.status !== 'done' || run.finishedAt == null) continue
    const outs = outputsByRun.get(run.id)
    if (!outs || outs.length === 0) continue
    const meta = names.get(run.nodeId)
    items.push({
      id: `output:${run.id}`,
      kind: 'node_output',
      ts: run.finishedAt,
      sortId: run.id,
      nodeId: run.nodeId,
      nodeRunId: run.id,
      nodeName: meta?.name ?? run.nodeId,
      agentName: meta?.agentName,
      outputs: outs,
      jumpTarget: { kind: 'session', nodeRunId: run.id },
    })
  }

  // 3. clarify question + answer (two events per round; answer only when submitted)
  for (const r of args.clarifyRounds) {
    const questions = safeParseArray<ClarifyQuestion>(r.questionsJson)
    if (questions) {
      const meta = names.get(r.askingNodeId)
      items.push({
        id: `question:${r.id}`,
        kind: 'clarify_question',
        ts: r.createdAt,
        sortId: r.id,
        nodeId: r.askingNodeId,
        nodeRunId: r.intermediaryNodeRunId,
        nodeName: meta?.name ?? r.askingNodeId,
        agentName: meta?.agentName,
        questions,
        jumpTarget: { kind: 'clarify', roundId: r.id, nodeRunId: r.intermediaryNodeRunId },
      })
    }
    if (r.answeredAt != null && r.answersJson) {
      const answers = safeParseArray<ClarifyAnswer>(r.answersJson)
      if (answers) {
        const meta = names.get(r.askingNodeId)
        items.push({
          id: `answer:${r.id}`,
          kind: 'clarify_answer',
          ts: r.answeredAt,
          sortId: r.id,
          nodeId: r.askingNodeId,
          nodeRunId: r.intermediaryNodeRunId,
          nodeName: meta?.name ?? r.askingNodeId,
          // Carry the questions so the answer card can render "Q -> A" context
          // without a separate fetch (undefined only when questionsJson was corrupt).
          questions,
          answers,
          jumpTarget: { kind: 'clarify', roundId: r.id, nodeRunId: r.intermediaryNodeRunId },
        })
      }
    }
  }

  // 4. review decisions (one per decided doc_version; comments from review_comments)
  const commentsByVersion = new Map<string, InteractionReviewComment[]>()
  for (const c of args.reviewComments) {
    let list = commentsByVersion.get(c.docVersionId)
    if (!list) {
      list = []
      commentsByVersion.set(c.docVersionId, list)
    }
    list.push({ selectedText: c.selectedText, commentText: c.commentText, author: c.author })
  }
  for (const dv of args.docVersions) {
    // 'pending' (not yet decided) and 'superseded' (system-retired) are not human
    // decisions - exclude them from the timeline.
    if (dv.decision === 'pending' || dv.decision === 'superseded') continue
    if (dv.decidedAt == null) continue
    const meta = names.get(dv.sourceNodeId)
    const comments = commentsByVersion.get(dv.id) ?? []
    items.push({
      id: `review:${dv.id}`,
      kind: 'review_decision',
      ts: dv.decidedAt,
      sortId: dv.id,
      nodeId: dv.sourceNodeId,
      nodeRunId: dv.reviewNodeRunId,
      nodeName: meta?.name ?? dv.sourceNodeId,
      review: { decision: dv.decision, reason: dv.decisionReason, comments },
      jumpTarget: { kind: 'review', nodeRunId: dv.reviewNodeRunId, docVersionId: dv.id },
    })
  }

  items.sort((a, b) => a.ts - b.ts || (a.sortId < b.sortId ? -1 : a.sortId > b.sortId ? 1 : 0))

  const total = items.length
  let truncated = false
  if (items.length > INTERACTION_FEED_MAX_ITEMS) {
    // keep the most recent N (drop the oldest); stay in ascending order
    items.splice(0, items.length - INTERACTION_FEED_MAX_ITEMS)
    truncated = true
  }
  return { items, total, truncated }
}
