// RFC-027: normalized conversation-tree model for the NodeDetailDrawer
// Session tab. Re-parses persisted node_run_events into a structured
// SessionTree where assistant messages, tool calls, and subagent (task
// tool) invocations become first-class blocks with recursive nesting.
//
// The parser is a pure function: input is the raw event rows from the
// `node_run_events` table (already enriched with session_id /
// parent_session_id by the runner + sessionCapture), output is one
// SessionTree per root session. The frontend SessionTab consumes the
// tree directly; the backend `/session` endpoint serializes it.

export type SessionMessageKind =
  | 'user'
  | 'assistant-text'
  | 'assistant-reasoning'
  | 'tool-call'
  | 'subagent-call'

export interface SessionUserMessage {
  kind: 'user'
  text: string
  ts: number
}

export interface SessionAssistantText {
  kind: 'assistant-text'
  text: string
  ts: number
  /** opencode messageID when known; null for tests / events that didn't expose one. */
  messageId: string | null
}

/**
 * Model thinking / chain-of-thought block. opencode emits these as
 * `part.type === 'reasoning'` (cli/cmd/run.ts:671) whenever the parent
 * runner is launched with `--thinking`. Stream deltas land as repeated
 * events with the same messageID, so the parser folds them with the
 * same last-write-wins merge used for assistant-text.
 */
export interface SessionAssistantReasoning {
  kind: 'assistant-reasoning'
  text: string
  ts: number
  messageId: string | null
}

export interface SessionToolCall {
  kind: 'tool-call'
  toolName: string
  callId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  // Matches zod's z.unknown() inferred shape (optional). Always present
  // when written by the backend, but type stays optional so the
  // SessionViewResponseSchema → SessionTree assignment stays type-safe.
  input?: unknown
  /** Final tool output text (state.output) when completed; null otherwise. */
  output: string | null
  ts: number
  messageId: string | null
}

export interface SessionSubagentCall {
  kind: 'subagent-call'
  toolName: string
  callId: string
  status: 'pending' | 'running' | 'completed' | 'error'
  // Matches z.unknown() inferred shape (optional). See SessionToolCall.
  input?: unknown
  output: string | null
  ts: number
  messageId: string | null
  /** Child session id extracted from part.metadata.sessionID; null when capture missed. */
  childSessionId: string | null
  /** Recursive child tree (null when child events are not in the bucket map). */
  child: SessionTree | null
  /** AC-10 fallback: parent-side final tool output when child events are missing. */
  childOutputFallback: string | null
  /** Best-effort agent name for the child session (e.g. from input.subagent_type). */
  childAgentName: string | null
}

export type SessionMessage =
  | SessionUserMessage
  | SessionAssistantText
  | SessionAssistantReasoning
  | SessionToolCall
  | SessionSubagentCall

export interface SessionTree {
  sessionId: string
  parentSessionId: string | null
  agentName: string | null
  messages: SessionMessage[]
  /** False when this session's bucket is empty or contains a capture-failed marker. */
  captureComplete: boolean
}

export interface ParseSessionInputEvent {
  id: number
  ts: number
  /** Same enum as node_run_events.kind, plus the synthetic 'subagent_capture_failed' marker. */
  kind: string
  /** Bucket key; null events fall into the root bucket. */
  sessionId: string | null
  parentSessionId: string | null
  /** Raw JSON line (NDJSON from opencode stdout, or transcoder output). */
  payload: string
}

export interface ParseSessionInput {
  rootSessionId: string | null
  promptText: string | null
  startedAt: number | null
  primaryAgentName: string
  events: ParseSessionInputEvent[]
  /**
   * RFC-027 §UX merge — extra user prompts from sibling node_runs
   * sharing the same opencode session (e.g. RFC-026 inline clarify
   * reruns). Each entry becomes an additional SessionUserMessage in
   * the root tree, inserted at its `ts` so it interleaves correctly
   * with assistant events emitted between the prompts. The legacy
   * `promptText` field still seeds the FIRST user prompt; this array
   * carries the subsequent rounds.
   *
   * When this field is absent or empty, the parser preserves the
   * pre-RFC-027 §UX behavior of unshifting promptText to index 0
   * regardless of ts (legacy callers unchanged).
   */
  extraUserPrompts?: Array<{ text: string; ts: number }>
}

const UNKNOWN_SESSION_ID = '(unknown)'

/**
 * Pure parser: groups events by session_id and reconstructs the
 * conversation tree. See RFC-027 design.md §2.2 for the algorithm.
 *
 * Invariants:
 *  - Tool parts with the same callID are folded by last-write-wins;
 *    'task' tool parts upgrade to SessionSubagentCall.
 *  - Subagent recursion is bounded by the event bucket map — there is
 *    no unbounded loop even on malformed input.
 *  - The root tree always includes a leading SessionUserMessage when
 *    promptText is provided, even if events is empty.
 */
export function parseSessionTree(input: ParseSessionInput): SessionTree {
  const buckets = new Map<string, ParseSessionInputEvent[]>()
  const parentOf = new Map<string, string | null>()
  const captureFailed = new Set<string>()

  const rootKey = input.rootSessionId ?? deriveRootBucketKey(input.events)

  for (const evt of input.events) {
    const key = evt.sessionId ?? rootKey
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(evt)
    if (!parentOf.has(key)) {
      parentOf.set(key, evt.parentSessionId ?? null)
    }
    if (evt.kind === 'subagent_capture_failed') {
      // The marker payload carries the *child* session id whose capture
      // failed (or the parent id when we don't know the child).
      const target = readCaptureFailedTarget(evt.payload) ?? key
      captureFailed.add(target)
    }
  }

  // Make sure each bucket is in stable (ts, id) order so downstream
  // folding is deterministic regardless of insert order (stdout +
  // post-run SQLite write into the same table out-of-order).
  for (const arr of buckets.values()) {
    arr.sort((a, b) => a.ts - b.ts || a.id - b.id)
  }

  const visited = new Set<string>()
  function build(
    sessionId: string,
    parentSessionId: string | null,
    agentHint: string | null,
  ): SessionTree {
    visited.add(sessionId)
    const bucket = buckets.get(sessionId) ?? []
    const messages: SessionMessage[] = []
    const tools = new Map<string, SessionToolCall | SessionSubagentCall>()
    const textsByMessageId = new Map<string, SessionAssistantText>()
    const reasoningByMessageId = new Map<string, SessionAssistantReasoning>()

    for (const evt of bucket) {
      const parsed = safeJsonParse(evt.payload)
      if (parsed === null) continue
      const part = (parsed as { part?: unknown }).part
      if (!isRecord(part)) continue
      const partType = typeof part.type === 'string' ? part.type : null

      if (partType === 'text' && evt.kind === 'text') {
        const text = typeof part.text === 'string' ? part.text : ''
        if (text === '') continue
        const messageId = pickMessageId(parsed, part)
        const key = messageId ?? `__anon__:${evt.id}`
        const existing = textsByMessageId.get(key)
        if (existing !== undefined) {
          existing.text = text
          existing.ts = evt.ts
        } else {
          const block: SessionAssistantText = {
            kind: 'assistant-text',
            text,
            ts: evt.ts,
            messageId,
          }
          textsByMessageId.set(key, block)
          messages.push(block)
        }
        continue
      }

      // RFC: reasoning parts (model thinking blocks) folded with the
      // same last-write-wins strategy as assistant-text. Empty deltas
      // (final part.text === '') are skipped so we never push hollow
      // "Thinking · 0 chars" blocks into the UI.
      if (partType === 'reasoning' && evt.kind === 'reasoning') {
        const text = typeof part.text === 'string' ? part.text : ''
        if (text === '') continue
        const messageId = pickMessageId(parsed, part)
        const key = messageId ?? `__anon__:${evt.id}`
        const existing = reasoningByMessageId.get(key)
        if (existing !== undefined) {
          existing.text = text
          existing.ts = evt.ts
        } else {
          const block: SessionAssistantReasoning = {
            kind: 'assistant-reasoning',
            text,
            ts: evt.ts,
            messageId,
          }
          reasoningByMessageId.set(key, block)
          messages.push(block)
        }
        continue
      }

      if (partType === 'tool' && evt.kind === 'tool_use') {
        const callId = typeof part.callID === 'string' ? part.callID : `__anon_call__:${evt.id}`
        const toolName = typeof part.tool === 'string' ? part.tool : 'unknown'
        const state = isRecord(part.state) ? part.state : {}
        const status = normalizeToolStatus(typeof state.status === 'string' ? state.status : null)
        const output = typeof state.output === 'string' ? state.output : null
        const input = state.input ?? null
        const messageId = pickMessageId(parsed, part)
        const ts = evt.ts

        const existing = tools.get(callId)
        if (toolName === 'task') {
          // opencode 1.15.x writes the spawned child sessionID at
          // `part.state.metadata.sessionId` (see opencode
          // packages/opencode/src/tool/task.ts:170-180 and
          // packages/opencode/src/session/prompt.ts:780-787 which
          // spreads ctx.metadata's `{title, metadata}` into part.state).
          // Earlier drafts of this parser looked at top-level
          // `part.metadata`, which never exists in real captures and made
          // every task tool_use render as "未能捕获子代理事件" even when
          // sessionCapture had successfully readback the child's events.
          // The top-level fallback is kept so test fixtures asserting the
          // legacy shape continue to pass.
          const stateMeta = isRecord(state.metadata) ? state.metadata : {}
          const partMeta = isRecord(part.metadata) ? part.metadata : {}
          const childSessionId = pickChildSessionId(stateMeta) ?? pickChildSessionId(partMeta)
          const childAgentName = pickSubagentAgentName(input)
          const block: SessionSubagentCall = {
            kind: 'subagent-call',
            toolName,
            callId,
            status,
            input,
            output,
            ts,
            messageId,
            childSessionId,
            child: null,
            childOutputFallback: output,
            childAgentName,
          }
          if (existing !== undefined) {
            // Replace in place to keep insertion order.
            replaceMessage(messages, existing, block)
          } else {
            messages.push(block)
          }
          tools.set(callId, block)
        } else {
          const block: SessionToolCall = {
            kind: 'tool-call',
            toolName,
            callId,
            status,
            input,
            output,
            ts,
            messageId,
          }
          if (existing !== undefined) {
            replaceMessage(messages, existing, block)
          } else {
            messages.push(block)
          }
          tools.set(callId, block)
        }
      }
    }

    // RFC-048: surface orphan child sessions while the parent's `task`
    // tool_use part is still in flight. opencode 1.15.x emits the
    // `tool_use` envelope (carrying `state.metadata.sessionId`) only after
    // the subagent has produced some output — but the live SQLite poller
    // is already capturing the child's message/part rows. Without this
    // pass the child bucket exists in `buckets` but is never linked,
    // leaving the conversation flow stuck on the parent's reasoning/text
    // while the subagent is hard at work.
    //
    // We synthesize a placeholder `subagent-call` block for every child
    // sessionId whose `parent_id` points at this session and which is not
    // already represented by a real `task` tool_use. The placeholder's
    // `callId` is namespaced so a later refetch — when the real `tool_use`
    // arrives via stdout — replaces it through `replaceMessage` instead of
    // adding a duplicate (see the `__orphan__:` prefix path below).
    const claimedChildSessionIds = new Set<string>()
    for (const m of messages) {
      if (m.kind === 'subagent-call' && m.childSessionId !== null) {
        claimedChildSessionIds.add(m.childSessionId)
      }
    }
    const orphanChildren: Array<{ id: string; firstTs: number }> = []
    for (const [childId, parentId] of parentOf) {
      if (parentId !== sessionId) continue
      if (claimedChildSessionIds.has(childId)) continue
      if (visited.has(childId)) continue
      const childBucket = buckets.get(childId)
      if (childBucket === undefined || childBucket.length === 0) continue
      orphanChildren.push({ id: childId, firstTs: childBucket[0]!.ts })
    }
    orphanChildren.sort((a, b) => a.firstTs - b.firstTs || a.id.localeCompare(b.id))
    for (const orphan of orphanChildren) {
      const placeholder: SessionSubagentCall = {
        kind: 'subagent-call',
        toolName: 'task',
        callId: `__orphan__:${orphan.id}`,
        status: 'running',
        input: null,
        output: null,
        ts: orphan.firstTs,
        messageId: null,
        childSessionId: orphan.id,
        child: null,
        childOutputFallback: null,
        childAgentName: null,
      }
      const insertAt = messages.findIndex((m) => m.ts > orphan.firstTs)
      if (insertAt === -1) messages.push(placeholder)
      else messages.splice(insertAt, 0, placeholder)
    }

    // Resolve subagent children — recursive build, bounded by buckets map
    // and visited set (no cycles possible).
    for (const msg of messages) {
      if (msg.kind !== 'subagent-call') continue
      if (msg.childSessionId === null) continue
      if (visited.has(msg.childSessionId)) continue
      const childAgent = msg.childAgentName
      msg.child = build(msg.childSessionId, sessionId, childAgent)
    }

    const bucketIsEmpty = bucket.length === 0
    const captureMarker = captureFailed.has(sessionId)
    const captureComplete = !bucketIsEmpty && !captureMarker

    return {
      sessionId,
      parentSessionId,
      agentName: agentHint,
      messages,
      captureComplete,
    }
  }

  const tree = build(rootKey, null, input.primaryAgentName)

  const extras = input.extraUserPrompts ?? []
  if (extras.length === 0) {
    // Legacy path — promptText (when present) unshifted to index 0
    // regardless of ts. Preserves pre-RFC-027 §UX merge behavior so
    // every single-attempt caller sees no change.
    if (input.promptText !== null && input.promptText !== '') {
      const userMsg: SessionUserMessage = {
        kind: 'user',
        text: input.promptText,
        ts: input.startedAt ?? earliestTs(tree.messages) ?? 0,
      }
      tree.messages.unshift(userMsg)
    }
  } else {
    // RFC-027 §UX merge — when multiple sibling node_runs share an
    // opencode session, each round's user prompt becomes its own
    // SessionUserMessage interleaved with the assistant events by ts.
    const userMsgs: SessionUserMessage[] = []
    if (input.promptText !== null && input.promptText !== '') {
      userMsgs.push({
        kind: 'user',
        text: input.promptText,
        ts: input.startedAt ?? earliestTs(tree.messages) ?? 0,
      })
    }
    for (const p of extras) {
      userMsgs.push({ kind: 'user', text: p.text, ts: p.ts })
    }
    for (const um of userMsgs) {
      insertByTs(tree.messages, um)
    }
  }

  // Root is always captureComplete=true once any user prompt exists
  // (parent stdout is by definition captured); empty buckets only flip
  // captureComplete for genuine child sessions.
  if ((input.promptText !== null && input.promptText !== '') || extras.length > 0) {
    tree.captureComplete = true
  }

  return tree
}

/**
 * Insert a user message into `messages` at the first index whose
 * existing ts is greater. Keeps the array in stable (ts, insertion)
 * order — important when several user prompts share a ts boundary
 * with an assistant event (e.g. clarify reply emitted in the same ms).
 */
function insertByTs(messages: SessionMessage[], userMsg: SessionUserMessage): void {
  const idx = messages.findIndex((m) => m.ts > userMsg.ts)
  if (idx === -1) messages.push(userMsg)
  else messages.splice(idx, 0, userMsg)
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function deriveRootBucketKey(events: ParseSessionInputEvent[]): string {
  for (const e of events) {
    if (e.sessionId !== null) return e.sessionId
  }
  return UNKNOWN_SESSION_ID
}

function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function normalizeToolStatus(s: string | null): SessionToolCall['status'] {
  if (s === 'pending' || s === 'running' || s === 'completed' || s === 'error') return s
  return 'pending'
}

function pickMessageId(envelope: unknown, part: Record<string, unknown>): string | null {
  if (typeof part.messageID === 'string') return part.messageID
  if (isRecord(envelope) && typeof envelope['messageID'] === 'string')
    return envelope['messageID'] as string
  return null
}

function pickChildSessionId(meta: Record<string, unknown>): string | null {
  if (typeof meta['sessionID'] === 'string') return meta['sessionID'] as string
  if (typeof meta['sessionId'] === 'string') return meta['sessionId'] as string
  return null
}

function pickSubagentAgentName(input: unknown): string | null {
  if (!isRecord(input)) return null
  if (typeof input['subagent_type'] === 'string') return input['subagent_type'] as string
  if (typeof input['agent'] === 'string') return input['agent'] as string
  return null
}

function replaceMessage(
  messages: SessionMessage[],
  oldMsg: SessionMessage,
  newMsg: SessionMessage,
): void {
  const idx = messages.indexOf(oldMsg)
  if (idx >= 0) messages[idx] = newMsg
}

function earliestTs(messages: SessionMessage[]): number | null {
  let min: number | null = null
  for (const m of messages) {
    if (min === null || m.ts < min) min = m.ts
  }
  return min
}

function readCaptureFailedTarget(payload: string): string | null {
  const parsed = safeJsonParse(payload)
  if (!isRecord(parsed)) return null
  if (typeof parsed['sessionID'] === 'string') return parsed['sessionID'] as string
  if (typeof parsed['sessionId'] === 'string') return parsed['sessionId'] as string
  return null
}
