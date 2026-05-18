// RFC-032 PR3: homepage pure helpers.
//
// Three pieces of logic intentionally factored out of the component layer
// so they can be exhaustively unit-tested without React: how we merge the
// review + clarify inbox lists, how we pick the greeting variant based on
// the time of day, and how we format relative timestamps for task rows.
// Keeping these in a separate module also lets the homepage and the
// sidebar inbox drawer share the merge logic in the future without
// introducing cross-component coupling.

import type { ClarifySessionSummary, ReviewSummary } from '@agent-workflow/shared'

export type GreetingKey = 'morning' | 'afternoon' | 'evening'

export interface InboxPreviewItem {
  kind: 'review' | 'clarify'
  id: string
  taskId: string
  title: string
  subtitle: string
  /** Used for sort + relative-time rendering. */
  timestamp: number
}

/** Cap on how many inbox preview items the homepage section shows. */
export const INBOX_PREVIEW_LIMIT = 8

/**
 * Merge pending reviews + pending clarify sessions into a single list sorted
 * newest-first, then trim to `INBOX_PREVIEW_LIMIT`. Both list endpoints
 * fail soft (the upstream `useQuery` may have errored); either side can
 * pass an empty array and the merge still works.
 */
export function mergeInboxItems(
  reviews: ReviewSummary[],
  clarify: ClarifySessionSummary[],
  limit: number = INBOX_PREVIEW_LIMIT,
): InboxPreviewItem[] {
  const out: InboxPreviewItem[] = []
  for (const r of reviews) {
    out.push({
      kind: 'review',
      id: r.nodeRunId,
      taskId: r.taskId,
      title: r.title,
      subtitle: r.workflowName,
      timestamp: r.createdAt,
    })
  }
  for (const c of clarify) {
    // Prefer the source-agent node's user-set display name (RFC node-title
    // field) so the inbox shows "节点名" — matches what the review tab
    // already does. Null/empty falls back to the raw node id.
    const agentTitle =
      typeof c.sourceAgentNodeTitle === 'string' && c.sourceAgentNodeTitle.length > 0
        ? c.sourceAgentNodeTitle
        : c.sourceAgentNodeId
    out.push({
      kind: 'clarify',
      id: c.clarifyNodeRunId,
      taskId: c.taskId,
      title: agentTitle,
      subtitle:
        c.sourceShardKey !== null && c.sourceShardKey !== ''
          ? `shard ${c.sourceShardKey}`
          : `iter ${c.iterationIndex}`,
      timestamp: c.createdAt,
    })
  }
  out.sort((a, b) => b.timestamp - a.timestamp)
  return out.slice(0, limit)
}

/**
 * Greeting variant for the homepage hero, in the user's locale's time of
 * day. Boundaries are inclusive on the lower end (06:00 → morning,
 * 12:00 → afternoon, 18:00 → evening) so a user at exactly noon gets the
 * "afternoon" greeting.
 */
export function pickGreetingKey(when: Date): GreetingKey {
  const h = when.getHours()
  if (h < 6) return 'evening' // very early morning still reads as the prior night
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

export interface RelativeTimeToken {
  /** i18n key under `home.taskRow.*`. */
  key: 'relativeJustNow' | 'relativeMinAgo' | 'relativeHourAgo' | 'relativeDayAgo'
  opts?: Record<string, number>
}

/**
 * Map a millis-since-epoch timestamp to an i18n token + interpolation
 * options the row renders via `t()`. Anything within 60 s is "just now";
 * < 60 min → minutes; < 24 h → hours; otherwise days.
 *
 * The pure-function shape keeps the test deterministic — callers pass
 * `Date.now()` (or a fixed timestamp in tests), no implicit clock.
 */
export function formatRelativeTime(nowMs: number, atMs: number): RelativeTimeToken {
  const dt = Math.max(0, nowMs - atMs)
  if (dt < 60_000) return { key: 'relativeJustNow' }
  const mins = Math.floor(dt / 60_000)
  if (mins < 60) return { key: 'relativeMinAgo', opts: { n: mins } }
  const hours = Math.floor(dt / 3_600_000)
  if (hours < 24) return { key: 'relativeHourAgo', opts: { n: hours } }
  const days = Math.floor(dt / 86_400_000)
  return { key: 'relativeDayAgo', opts: { n: days } }
}
