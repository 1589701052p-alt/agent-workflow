// RFC-056 — pure functions and constants for the `clarify-cross-agent` node.
//
// Parallel to `shared/clarify.ts` (RFC-023 self-clarify) — different node kind,
// different runtime semantics (multi-source aggregation, reject persistence,
// designer rerun trigger), but the envelope schema and the per-answer synthesis
// are reused verbatim from RFC-023. No Bun / Node / DB imports — pure module.

import type { ClarifyCrossAgentNode, ClarifyCrossAgentSessionMode } from './schemas/workflow'
import {
  parseClarifyEnvelopeBody,
  type ParseClarifyEnvelopeResult,
  summariseClarifyAnswer,
} from './clarify'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'

// -----------------------------------------------------------------------------
// constants
// -----------------------------------------------------------------------------

/** Title used by the auto-appended External Feedback section in the designer's
 *  user prompt. Exported as a constant so the regression-guard grep test can
 *  catch silent renames in `shared/prompt.ts`. */
export const CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE = '## External Feedback' as const

// -----------------------------------------------------------------------------
// envelope parsing — lifts the RFC-023 5-question cap for the cross path.
// -----------------------------------------------------------------------------

/**
 * RFC-056: parse the JSON body of a `<workflow-clarify>` envelope produced by a
 * questioner agent wired through a cross-clarify node. Reuses the RFC-023
 * parser end-to-end; the only difference is `maxQuestions = +Infinity` which
 * disables the question-count truncation. Per-question option count, kind /
 * options validation, sort-by-recommended, custom-text length cap, etc. all
 * preserve RFC-023 semantics — same parse function under the hood.
 */
export function parseCrossClarifyEnvelopeBody(jsonText: string): ParseClarifyEnvelopeResult {
  return parseClarifyEnvelopeBody(jsonText, { maxQuestions: Number.POSITIVE_INFINITY })
}

// -----------------------------------------------------------------------------
// External Feedback block rendering (designer-side prompt injection).
// -----------------------------------------------------------------------------

/** One source's contribution to the designer's External Feedback batch. The
 *  scheduler builds this per-source by looking up the latest answered +
 *  directive='continue' cross_clarify_sessions row for each cross-clarify
 *  node targeting the same designer. */
export interface CrossClarifySourceContext {
  /** The questioner agent node id whose `<workflow-clarify>` envelope drove
   *  this source. Stable across reruns; used by the renderer to sort sources
   *  in dictionary order for deterministic output. */
  sourceQuestionerNodeId: string
  /** The cross-clarify node id (the human-gated form node). Surfaced in the
   *  sub-heading so the designer can correlate feedback with the node the
   *  user actually filled. */
  crossClarifyNodeId: string
  /** Per-source cross-clarify iteration this batch represents. */
  iteration: number
  /** The questions the questioner asked this round. */
  questions: ClarifyQuestion[]
  /** The user's answers (one per question, indexed by question.id). */
  answers: ClarifyAnswer[]
}

/**
 * Render the designer-facing `## External Feedback` body. Each source becomes
 * a `### From '{nodeId}' (round {iteration})` sub-section, sorted by source
 * questioner nodeId (dictionary order). Within a source, each question gets a
 * `#### Q{N}: {title}` line plus the single-sentence
 * {@link summariseClarifyAnswer} synthesis the user's answer maps to.
 *
 * Returns ONLY the body — the leading `## External Feedback` heading is
 * applied by `shared/prompt.ts` via the auto-append mechanism (when the
 * template doesn't reference `{{__external_feedback__}}`).
 */
export function buildExternalFeedbackBlock(sources: CrossClarifySourceContext[]): string {
  if (sources.length === 0) return ''
  const sorted = [...sources].sort((a, b) =>
    a.sourceQuestionerNodeId.localeCompare(b.sourceQuestionerNodeId),
  )
  const lines: string[] = []
  for (const src of sorted) {
    lines.push(`### From '${src.sourceQuestionerNodeId}' (round ${src.iteration})`)
    lines.push('')
    const byId = new Map(src.answers.map((a) => [a.questionId, a]))
    src.questions.forEach((q, idx) => {
      const a = byId.get(q.id)
      lines.push(`#### Q${idx + 1}: ${q.title}`)
      if (a === undefined) {
        lines.push('- User did not answer this question.')
      } else {
        lines.push(`- ${summariseClarifyAnswer(q, a)}`)
      }
      lines.push('')
    })
  }
  return lines.join('\n').trimEnd()
}

/**
 * Render a single source's contribution — useful for incremental rendering
 * (e.g. an editor preview that streams one source at a time). Same per-source
 * formatting as `buildExternalFeedbackBlock`, but no sort and no leading
 * `## External Feedback` framing.
 */
export function renderCrossClarifySource(src: CrossClarifySourceContext): string {
  return buildExternalFeedbackBlock([src])
}

/**
 * Convenience deterministic synthesis for a single (question, answer) pair.
 * RFC-056 reuses the RFC-023 implementation verbatim — the framework's per-
 * answer English summary semantics are identical regardless of whether the
 * questioner was the designer itself (self-clarify) or a downstream auditor
 * (cross-clarify). Exported under a cross-clarify name so the runtime
 * call-sites read clearly and so future divergence (if any) only requires
 * editing this re-export, not every caller.
 */
export function summariseCrossAnswer(question: ClarifyQuestion, answer: ClarifyAnswer): string {
  return summariseClarifyAnswer(question, answer)
}

// -----------------------------------------------------------------------------
// sessionMode resolution.
// -----------------------------------------------------------------------------

/**
 * RFC-056 + RFC-026: resolve which sessionMode to use for a particular rerun
 * direction off a cross-clarify node.
 *
 *  - 'designer'    → reads `node.sessionModeForDesigner` (the agent that gets
 *                    rerun on submit).
 *  - 'questioner'  → reads `node.sessionModeForQuestioner` (the agent that
 *                    gets rerun on reject + cascade with STOP CLARIFYING).
 *
 * Missing field resolves to `'isolated'` in both cases — preserves RFC-026
 * "default-isolated keeps the run path fresh" semantic and means an older v3
 * doc that does not carry the field after a transparent v3 → v4 upgrade still
 * behaves predictably.
 */
export function resolveCrossClarifySessionMode(
  node: ClarifyCrossAgentNode,
  direction: 'designer' | 'questioner',
): ClarifyCrossAgentSessionMode {
  if (direction === 'designer') {
    return node.sessionModeForDesigner ?? 'isolated'
  }
  return node.sessionModeForQuestioner ?? 'isolated'
}
