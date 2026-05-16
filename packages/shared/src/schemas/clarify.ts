// Clarify schemas (RFC-023). The clarify node lets an agent emit a structured
// "I need answers before I can produce output" envelope. The framework parks
// the task, surfaces the questions to the user, captures structured answers,
// and re-spawns the asking agent with the answers injected into the next-round
// prompt.
//
// Reads/parses are PERMISSIVE: agents that over-emit questions/options are
// truncated to limits and a non-fatal warning is recorded. Hard schema
// failures (kind enum, options < 2, empty title) reject the envelope and the
// node fails with the standard retries path.

import { z } from 'zod'

export const CLARIFY_MAX_QUESTIONS = 5
export const CLARIFY_MAX_OPTIONS_PER_QUESTION = 4
export const CLARIFY_MIN_OPTIONS_PER_QUESTION = 2
export const CLARIFY_MAX_CUSTOM_TEXT_LEN = 2000

export const ClarifyQuestionKindSchema = z.enum(['single', 'multi'])
export type ClarifyQuestionKind = z.infer<typeof ClarifyQuestionKindSchema>

/** One question the agent asked. The framework appends a 5th "free-text" row
 *  in the UI automatically; agents must NOT include a free-text option here. */
export const ClarifyQuestionSchema = z.object({
  /** Stable identifier chosen by the agent. ≤ 64 chars. */
  id: z.string().min(1).max(64),
  /** Question text (≤ 512 chars). */
  title: z.string().min(1).max(512),
  /** single = radio + mutually-exclusive custom row; multi = checkbox + parallel custom row. */
  kind: ClarifyQuestionKindSchema,
  /** When true, the UI renders a "(推荐)" / "(Recommended)" badge and the
   *  question becomes required. Defaults to false. */
  recommended: z.boolean().default(false),
  /** Candidate options. Between MIN (2) and MAX (4); over-emission is
   *  truncated and a warning recorded at parse time. */
  options: z
    .array(z.string().min(1).max(256))
    .min(CLARIFY_MIN_OPTIONS_PER_QUESTION)
    .max(CLARIFY_MAX_OPTIONS_PER_QUESTION),
})
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>

/** What `<workflow-clarify>` body JSON.parse must yield (after truncation). */
export const ClarifyEnvelopeBodySchema = z.object({
  questions: z.array(ClarifyQuestionSchema).min(1).max(CLARIFY_MAX_QUESTIONS),
})
export type ClarifyEnvelopeBody = z.infer<typeof ClarifyEnvelopeBodySchema>

/** One user answer for one question. */
export const ClarifyAnswerSchema = z.object({
  questionId: z.string().min(1),
  /** Indices into question.options. Empty array means "no candidate selected". */
  selectedOptionIndices: z.array(z.number().int().nonnegative()).default([]),
  /** Mirrors selectedOptionIndices via question.options[idx]. The backend
   *  re-fills this from the indices on submit — clients cannot inject
   *  arbitrary label strings. */
  selectedOptionLabels: z.array(z.string()).default([]),
  /** User-entered free-text. For single questions: filled means the custom
   *  row was chosen (mutually exclusive with selectedOptionIndices). For
   *  multi questions: filled means the user added supplementary text in
   *  addition to whatever candidates they ticked. */
  customText: z.string().max(CLARIFY_MAX_CUSTOM_TEXT_LEN).default(''),
})
export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>

export const SubmitClarifyAnswersSchema = z.object({
  answers: z.array(ClarifyAnswerSchema),
  /** Optimistic-lock guard: must equal the session's current iterationIndex
   *  or the server returns 412 Precondition Failed (defends against two-tab
   *  double-submit). */
  ifMatchIteration: z.number().int().nonnegative().optional(),
})
export type SubmitClarifyAnswers = z.infer<typeof SubmitClarifyAnswersSchema>

export const ClarifySessionStatusSchema = z.enum(['awaiting_human', 'answered', 'canceled'])
export type ClarifySessionStatus = z.infer<typeof ClarifySessionStatusSchema>

export const ClarifyTruncationWarningSchema = z.object({
  code: z.string(),
  detail: z.string(),
})
export type ClarifyTruncationWarning = z.infer<typeof ClarifyTruncationWarningSchema>

export const ClarifySessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sourceAgentNodeId: z.string(),
  sourceAgentNodeRunId: z.string(),
  /** Shard key when the asking agent is an agent-multi child; null otherwise. */
  sourceShardKey: z.string().nullable().default(null),
  clarifyNodeId: z.string(),
  clarifyNodeRunId: z.string(),
  /** Matches the source agent node_run's clarifyIteration at ask-time. */
  iterationIndex: z.number().int().nonnegative(),
  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  status: ClarifySessionStatusSchema,
  truncationWarnings: z.array(ClarifyTruncationWarningSchema).optional(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable().default(null),
  answeredBy: z.string().nullable().default(null),
})
export type ClarifySession = z.infer<typeof ClarifySessionSchema>

/** Compact entry for /api/clarify list. */
export const ClarifySessionSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sourceAgentNodeId: z.string(),
  sourceShardKey: z.string().nullable(),
  clarifyNodeId: z.string(),
  clarifyNodeRunId: z.string(),
  iterationIndex: z.number().int().nonnegative(),
  questionCount: z.number().int().nonnegative(),
  status: ClarifySessionStatusSchema,
  createdAt: z.number().int(),
  answeredAt: z.number().int().nullable(),
})
export type ClarifySessionSummary = z.infer<typeof ClarifySessionSummarySchema>

export const ListClarifyQuerySchema = z.object({
  taskId: z.string().optional(),
  status: z.union([ClarifySessionStatusSchema, z.literal('all')]).optional(),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListClarifyQuery = z.infer<typeof ListClarifyQuerySchema>

export const ClarifyPendingCountSchema = z.object({
  count: z.number().int().nonnegative(),
})
export type ClarifyPendingCount = z.infer<typeof ClarifyPendingCountSchema>

export const SubmitClarifyAnswersResponseSchema = z.object({
  session: ClarifySessionSchema,
  /** Newly minted source agent node_run id (clarifyIteration + 1, retry_index = 0). */
  rerunNodeRunId: z.string(),
})
export type SubmitClarifyAnswersResponse = z.infer<typeof SubmitClarifyAnswersResponseSchema>
