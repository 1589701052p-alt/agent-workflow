// Prompt assembly logic shared between the backend runner and the frontend
// preview pane (NodeInspector). Pure functions — no Bun / Node / DB
// imports. Mirrors design.md §7.2.

/**
 * Review-driven re-run context (RFC-005 + RFC-014).
 *
 * Filled only when a node is being re-run because a downstream review decision
 * (`reject` or `iterate`) fired. All fields are pre-rendered strings — the
 * structured-to-markdown serialization lives in `services/review.ts` so this
 * module stays a pure substitution engine.
 *
 * Builtin tokens populated from this context:
 *   {{__review_rejection__}}     ← rejection (set on reject path)
 *   {{__review_comments__}}      ← comments  (set on iterate path; markdown list)
 *   {{__iterate_target_port__}}  ← iterateTargetPort (set on iterate path)
 *   {{__sibling_outputs__}}      ← siblingOutputs (set on iterate path when the
 *                                  upstream agent declares ≥ 2 markdown[_file]
 *                                  outputs AND opted into `syncOutputsOnIterate`;
 *                                  carries the other documents' current bodies
 *                                  prefixed with a stable English consistency
 *                                  instruction — RFC-014 §3.1)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt (just like unreferenced ports).
 */
export interface ReviewPromptContext {
  /** Reject reason text, when set. */
  rejection?: string
  /** Comments list, already rendered as a markdown string. */
  comments?: string
  /**
   * On iterate path, the source port name being iterated on. Lets agents
   * branch their generation logic on "regen this port only, leave others".
   */
  iterateTargetPort?: string
  /**
   * RFC-014: pre-rendered markdown listing the other markdown[_file] outputs
   * of the same upstream node. Only set on iterate path when the upstream
   * declares ≥ 2 markdown[_file] outputs AND has `syncOutputsOnIterate: true`.
   * Includes the leading English consistency instruction line — see
   * `buildSiblingOutputsBlock` in services/review.ts.
   */
  siblingOutputs?: string
}

/**
 * RFC-023 clarify-driven re-run context.
 *
 * Filled when an agent is being re-spawned because its previous reply was a
 * `<workflow-clarify>` envelope and the user has now answered. All fields are
 * pre-rendered strings — the structured-to-markdown serialization lives in
 * shared/clarify.ts so this module stays a pure substitution engine.
 *
 * Builtin tokens populated from this context:
 *   {{__clarify_questions__}}  ← questionsBlock (markdown listing of what the agent asked)
 *   {{__clarify_answers__}}    ← answersBlock   (markdown listing of user answers + synthesis)
 *   {{__clarify_iteration__}}  ← iteration      (string form of source.clarifyIteration)
 *   {{__clarify_remaining__}}  ← remaining      (string; "max - current" when inside a
 *                                                wrapper-loop with a cap, "" otherwise)
 *
 * Templates that don't reference these tokens get framework-auto-appended
 * sections at the tail of the user prompt — same auto-append pattern as the
 * RFC-005 review context.
 */
export interface ClarifyPromptContext {
  /** Markdown listing of the last-round questions. */
  questionsBlock?: string
  /** Markdown listing of user answers (incl. deterministic synthesis line per question). */
  answersBlock?: string
  /** Current clarifyIteration as string. '0' means first asking-back; '1' means
   *  first answers-received run; '2' means second ask-then-answer, etc. */
  iteration?: string
  /** Empty string when not inside a wrapper-loop with a cap; otherwise
   *  String(max_iterations - current iteration). Agent reads this to know how
   *  many ask-back rounds it has left before the framework exhausts the loop. */
  remaining?: string
}

export interface RenderPromptInput {
  /** Node-level prompt template. May be undefined or empty. */
  promptTemplate?: string
  /** Resolved input ports — { portName -> concatenated content }. */
  inputs: Record<string, string>
  /** Built-in template variables. */
  meta: {
    repoPath: string
    baseBranch: string
    taskId: string
    /** Workflow node id (always available at run time). */
    nodeId?: string
    /** Loop wrapper iteration (0-based). Only present inside a loop. */
    iteration?: number
    /** Shard key for multi-process nodes. Only present in child runs. */
    shardKey?: string
  }
  /** Declared outputs for the protocol block instructions. */
  agentOutputs: string[]
  /** RFC-005 review-driven re-run context. Absent for normal first-time runs. */
  reviewContext?: ReviewPromptContext
  /** RFC-023 clarify-driven re-run context. Absent for first runs and runs
   *  where the agent's clarify channel is wired but it hasn't yet asked. */
  clarifyContext?: ClarifyPromptContext
}

const TEMPLATE_RE = /\{\{(\w+)\}\}/g

const BUILTIN_VARS = new Set([
  '__repo_path__',
  '__base_branch__',
  '__task_id__',
  '__node_id__',
  '__iteration__',
  '__shard_key__',
  // RFC-005 review context tokens. They are stable names — see
  // packages/backend/tests/review-prompt-injection.test.ts for the
  // source-code-text grep regression guard.
  '__review_rejection__',
  '__review_comments__',
  '__iterate_target_port__',
  // RFC-014 sibling-outputs token — stable name; same grep contract as the
  // review tokens above. See packages/backend/tests/review-prompt-injection.test.ts.
  '__sibling_outputs__',
  // RFC-023 clarify context tokens. Stable names; renaming is a contract
  // break — see packages/backend/tests/clarify-prompt-injection.test.ts
  // for the source-code-text grep regression guard.
  '__clarify_questions__',
  '__clarify_answers__',
  '__clarify_iteration__',
  '__clarify_remaining__',
])

/**
 * Compose the user-prompt string sent to opencode for one node invocation:
 *
 *   1. Node-level template with `{{port_name}}` + built-in substitutions.
 *   2. Per-port sections for any input not referenced by the template.
 *   3. English protocol block at the end instructing the agent how to format
 *      its `<workflow-output>` reply.
 */
export function renderUserPrompt(input: RenderPromptInput): string {
  const tpl = input.promptTemplate ?? ''
  const referenced = new Set<string>()
  const rc = input.reviewContext
  const cc = input.clarifyContext

  const body = tpl.replace(TEMPLATE_RE, (_match, name: string) => {
    referenced.add(name)
    if (BUILTIN_VARS.has(name)) {
      switch (name) {
        case '__repo_path__':
          return input.meta.repoPath
        case '__base_branch__':
          return input.meta.baseBranch
        case '__task_id__':
          return input.meta.taskId
        case '__node_id__':
          return input.meta.nodeId ?? ''
        case '__iteration__':
          return input.meta.iteration !== undefined ? String(input.meta.iteration) : ''
        case '__shard_key__':
          return input.meta.shardKey ?? ''
        case '__review_rejection__':
          return rc?.rejection ?? ''
        case '__review_comments__':
          return rc?.comments ?? ''
        case '__iterate_target_port__':
          return rc?.iterateTargetPort ?? ''
        case '__sibling_outputs__':
          return rc?.siblingOutputs ?? ''
        case '__clarify_questions__':
          return cc?.questionsBlock ?? ''
        case '__clarify_answers__':
          return cc?.answersBlock ?? ''
        case '__clarify_iteration__':
          return cc?.iteration ?? ''
        case '__clarify_remaining__':
          return cc?.remaining ?? ''
      }
    }
    const v = input.inputs[name]
    return v ?? ''
  })

  let sections = ''
  for (const [name, content] of Object.entries(input.inputs)) {
    if (referenced.has(name)) continue
    sections += `\n\n## ${name}\n${content}`
  }

  // RFC-005: auto-append review context sections when the template didn't
  // reference the tokens. Lets author-written prompts stay terse while still
  // getting the rejection / comments / target-port surfaced at the tail.
  if (rc !== undefined) {
    if (
      rc.rejection !== undefined &&
      rc.rejection.trim().length > 0 &&
      !referenced.has('__review_rejection__')
    ) {
      sections += `\n\n## Review Rejection\n${rc.rejection}`
    }
    if (
      rc.comments !== undefined &&
      rc.comments.trim().length > 0 &&
      !referenced.has('__review_comments__')
    ) {
      sections += `\n\n## Review Comments\n${rc.comments}`
    }
    if (
      rc.iterateTargetPort !== undefined &&
      rc.iterateTargetPort.length > 0 &&
      !referenced.has('__iterate_target_port__')
    ) {
      sections += `\n\n## Iterate Target Port\n${rc.iterateTargetPort}`
    }
    // RFC-014: auto-append sibling outputs when the iterate path populated them.
    if (
      rc.siblingOutputs !== undefined &&
      rc.siblingOutputs.trim().length > 0 &&
      !referenced.has('__sibling_outputs__')
    ) {
      sections += `\n\n## Sibling Outputs\n${rc.siblingOutputs}`
    }
  }

  // RFC-023: auto-append the clarify Q&A sections at the prompt tail when the
  // author's template did not explicitly reference the tokens. Same shape as
  // the review section above so authors can rely on a predictable trailing
  // structure.
  if (cc !== undefined) {
    if (
      cc.questionsBlock !== undefined &&
      cc.questionsBlock.trim().length > 0 &&
      !referenced.has('__clarify_questions__')
    ) {
      sections += `\n\n## Clarify Q&A — Last-Round Questions\n${cc.questionsBlock}`
    }
    if (
      cc.answersBlock !== undefined &&
      cc.answersBlock.trim().length > 0 &&
      !referenced.has('__clarify_answers__')
    ) {
      sections += `\n\n## Clarify Q&A — User Answers\n${cc.answersBlock}`
    }
  }

  return body + sections + buildProtocolBlock(input.agentOutputs)
}

/**
 * The English protocol block. Always appended to user prompt, never to the
 * agent's system prompt (agent.md body is passed through verbatim).
 */
export function buildProtocolBlock(agentOutputs: string[]): string {
  let s = '\n\n---\nYou MUST end your reply with a `<workflow-output>` block listing these ports:\n'
  for (const port of agentOutputs) {
    s += `  - ${port}\n`
  }
  s += '\nFormat:\n<workflow-output>\n'
  for (const port of agentOutputs) {
    s += `  <port name="${port}">...</port>\n`
  }
  s += '</workflow-output>'
  return s
}

/**
 * RFC-023 — the clarify protocol block. Appended to the user prompt by the
 * runner only when the current agent node has a clarify channel wired
 * (i.e. an outbound edge on its system port `__clarify__`). When present, it
 * lives AFTER the standard `<workflow-output>` block so the agent reads both
 * envelopes and chooses exactly one. Returns a leading `\n\n` so callers can
 * concatenate without injecting their own separator.
 */
export function buildClarifyProtocolBlock(): string {
  return `

---
**Clarify mode is enabled for this node.** If — and ONLY if — you have unresolved questions that block you from producing your normal output, you MUST instead emit a <workflow-clarify> block (no <workflow-output> in the same reply).

Format:
<workflow-clarify>
{
  "questions": [
    {
      "id": "<stable-id>",
      "title": "<question text>",
      "kind": "single" | "multi",
      "options": [
        {
          "label": "<picker text>",
          "description": "<what this option does / expected outcome / trade-offs>",
          "recommended": true | false,
          "recommendationReason": "<why the user should pick this one>"
        }
      ]
    }
  ]
}
</workflow-clarify>

Hard rules — violation is treated as a malformed reply and the node will fail / retry:
- A reply must contain EITHER one <workflow-output> block OR one <workflow-clarify> block — NEVER both, NEVER neither.
- Asking back means deferring all output ports to the next round; do not also output partial data.
- Limits: at most 5 questions, each question 2–4 options. Do NOT add a "free text / other" option — the framework appends a user-input row automatically.
- Each option needs a non-empty "label". The other three fields are optional but strongly recommended: "description" (always render an explanation of what picking this option means), and — when "recommended" is true — "recommendationReason" (why this is your pick).
- Mark at most a couple of options across the whole envelope as "recommended": true. Recommended options sort to the top of the picker for the user.
- Legacy form is also accepted: \`"options": ["a", "b", "c"]\` — strings are lifted into \`{label, description:"", recommended:false, recommendationReason:""}\`. Prefer the structured form for new emissions.
- Once the user submits answers, you will receive them in the next prompt under "## Clarify Q&A — User Answers" plus a deterministic synthesis line per question.`
}
