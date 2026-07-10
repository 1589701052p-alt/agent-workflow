// RFC-166 — agent capability card: a structured projection of an agent's
// declared capability (description + input/output ports with kinds + role +
// a system-prompt summary), rendered as a markdown block for injection into
// an orchestrator's / leader's prompt, and consumed by frontend previews.
//
// Prompt-isolation invariant (RFC-099): the card carries ONLY the agent's own
// declared fields — never ownerUserId / visibility / timestamps. The input
// type is a `Pick<>` that pins the visible surface at the type layer so a
// caller cannot accidentally leak an ACL/audit field, and the render output
// is asserted (tests) to contain no user id.

import type { Agent } from './schemas/agent'

/** The exact, whitelisted field surface a capability card may read. */
export type CapabilitySource = Pick<
  Agent,
  'name' | 'description' | 'inputs' | 'outputs' | 'outputKinds' | 'role'
> & {
  /** bodyMd is optional here so callers can omit it when promptBudget = 0. */
  bodyMd?: string
}

export interface CapabilityCardOptions {
  /** System-prompt summary char budget. 0 → omit the prompt line. Default 600. */
  promptBudget?: number
}

const DEFAULT_PROMPT_BUDGET = 600

/** Clip to `budget` chars on a word-ish boundary, appending an ellipsis. */
function clipSummary(text: string, budget: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= budget) return collapsed
  const cut = collapsed.slice(0, budget)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > budget * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Render one input port: `name (kind, required)`. */
function renderInputPort(p: NonNullable<Agent['inputs']>[number]): string {
  const bits = [p.kind]
  if (p.required === true) bits.push('required')
  return `${p.name} (${bits.join(', ')})`
}

/** Render one output port: `name (kind)` — kind from outputKinds, default string. */
function renderOutputPort(name: string, kinds: Agent['outputKinds']): string {
  const kind = kinds?.[name] ?? 'string'
  return `${name} (${kind})`
}

/**
 * Render an agent's capability card. Pure — no DB, no ACL fields. Callers that
 * want the leaderboard-style compact form pass `promptBudget: 0`.
 */
export function renderAgentCapabilityCard(
  agent: CapabilitySource,
  opts?: CapabilityCardOptions,
): string {
  const budget = opts?.promptBudget ?? DEFAULT_PROMPT_BUDGET
  const inputs = agent.inputs ?? []
  const outputs = agent.outputs ?? []
  const lines: string[] = [`### ${agent.name}`]
  if (agent.description.trim().length > 0) lines.push(agent.description.trim())
  lines.push(`- role: ${agent.role ?? 'normal'}`)
  lines.push(
    `- inputs: ${inputs.length > 0 ? inputs.map(renderInputPort).join(', ') : '(none declared)'}`,
  )
  lines.push(
    `- outputs: ${
      outputs.length > 0
        ? outputs.map((o) => renderOutputPort(o, agent.outputKinds)).join(', ')
        : '(none declared)'
    }`,
  )
  if (budget > 0 && agent.bodyMd !== undefined && agent.bodyMd.trim().length > 0) {
    lines.push(`- prompt: ${clipSummary(agent.bodyMd, budget)}`)
  }
  return lines.join('\n')
}

export interface RosterCardsOptions extends CapabilityCardOptions {
  /**
   * Total char budget across ALL cards (leader roster with many members).
   * When set and exceeded, later cards are dropped with a trailing note.
   * 0 / undefined → no roster-level cap (per-card promptBudget still applies).
   */
  rosterBudget?: number
}

/**
 * Render a roster of capability cards (orchestrator agent-pool / leader
 * roster). Joined by blank lines; roster-level budget drops the tail with a
 * note so token usage stays bounded.
 */
export function renderRosterCapabilityCards(
  agents: readonly CapabilitySource[],
  opts?: RosterCardsOptions,
): string {
  const rosterBudget = opts?.rosterBudget ?? 0
  const cards: string[] = []
  let used = 0
  let dropped = 0
  for (const agent of agents) {
    const card = renderAgentCapabilityCard(agent, opts)
    if (rosterBudget > 0 && used + card.length > rosterBudget && cards.length > 0) {
      dropped = agents.length - cards.length
      break
    }
    cards.push(card)
    used += card.length + 2
  }
  if (dropped > 0) {
    cards.push(`_(${dropped} more agent(s) omitted — roster budget reached)_`)
  }
  return cards.join('\n\n')
}
