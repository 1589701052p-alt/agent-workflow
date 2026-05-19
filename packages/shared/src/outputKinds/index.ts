// RFC-049 — static OutputKindHandler registry.
//
// Adding a new kind = (1) add a handler file in this directory, (2) import +
// register it in HANDLERS below. The module-load-time assert at the bottom
// of this file refuses to boot if two handlers claim the same `subReason`
// short-code, so cross-kind namespace collisions are caught in CI rather
// than at runtime when an unrelated kind happens to emit a colliding code.
//
// Do NOT export a public `register(handler)` API; do NOT load handlers from
// `package.json` plugin fields; do NOT introduce dynamic registration. The
// handlers are baked into the build. Future "runtime plugin loader" — if
// ever needed — must come via a separate RFC; do not bolt it onto this
// registry as a convenience.

import type { AgentOutputKind } from '../schemas/review'
import stringHandler from './string'
import markdownHandler from './markdown'
import markdownFileHandler from './markdownFile'
import type { OutputKindHandler } from './types'

export const HANDLERS: Readonly<Record<AgentOutputKind, OutputKindHandler>> = Object.freeze({
  string: stringHandler,
  markdown: markdownHandler,
  markdown_file: markdownFileHandler,
})

export function getOutputKindHandler(kind: AgentOutputKind): OutputKindHandler {
  const h = HANDLERS[kind]
  if (!h) {
    // Defense-in-depth: AgentOutputKind is a string-literal union, so the
    // type system already prevents missing entries. This throw is the
    // runtime sibling for cases like dynamic JSON inputs where a kind value
    // bypasses TS narrowing.
    throw new Error(`outputKind handler not registered: ${String(kind)}`)
  }
  return h
}

export type DistinctKindGroup = {
  handler: OutputKindHandler
  /** Ports declared as the handler's kind (in declaration order). */
  ports: string[]
}

/**
 * Group `agentOutputKinds` into per-kind buckets in first-occurrence order,
 * pairing each kind with its registered handler. Ports whose `outputKinds`
 * entry is absent (legacy default) fall back to the `string` handler so
 * `buildPromptGuidance` etc still has a place to dispatch.
 *
 * Ports that appear in `agentOutputKinds` but are absent from
 * `declaredOutputs` are dropped — they have no first-turn slot to render
 * guidance for. Conversely, ports in `declaredOutputs` with no
 * `agentOutputKinds` entry land in the `string` bucket.
 */
export function groupPortsByKind(
  declaredOutputs: readonly string[],
  agentOutputKinds?: Record<string, AgentOutputKind>,
): DistinctKindGroup[] {
  const byKind = new Map<AgentOutputKind, string[]>()
  const orderedKinds: AgentOutputKind[] = []
  for (const port of declaredOutputs) {
    const k = (agentOutputKinds?.[port] ?? 'string') as AgentOutputKind
    if (!byKind.has(k)) {
      byKind.set(k, [])
      orderedKinds.push(k)
    }
    byKind.get(k)!.push(port)
  }
  return orderedKinds.map((k) => ({ handler: getOutputKindHandler(k), ports: byKind.get(k)! }))
}

// -----------------------------------------------------------------------------
// Module-load-time invariant: every subReason short-code is owned by exactly
// one handler. Cross-kind collisions break the `port-validation-<kind>-<sub>`
// reverse lookup and indicate a sloppy new-kind PR — fail loudly here so the
// PR can never land.
// -----------------------------------------------------------------------------
{
  const claimedBy = new Map<string, AgentOutputKind>()
  for (const h of Object.values(HANDLERS)) {
    for (const sub of h.subReasons) {
      const prev = claimedBy.get(sub)
      if (prev !== undefined && prev !== h.kind) {
        throw new Error(
          `RFC-049 outputKinds: subReason collision: '${sub}' claimed by both ${prev} and ${h.kind}`,
        )
      }
      claimedBy.set(sub, h.kind)
    }
  }
}

export { stringHandler, markdownHandler, markdownFileHandler }
export * from './types'
