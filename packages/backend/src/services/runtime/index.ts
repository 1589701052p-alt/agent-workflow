// RFC-111 PR-A — runtime driver registry + resolution.
//
// `getRuntimeDriver` is the factory (multica's Backend-factory pattern) that
// maps a frozen `node_runs.runtime` kind to its driver. `RUNTIME_KINDS` /
// `isKnownRuntimeKind` are the single source for "which runtime kinds exist",
// derived from the DRIVERS registry (RFC-143).
//
// (RFC-143 deleted the old `resolveRuntime` pure fn — a hardcoded three-way with
// zero production callers; fresh-dispatch runtime selection flows through
// runtimeRegistry.resolveAgentRuntime, and resume/retry read the frozen
// node_runs.runtime.)

import type { RuntimeDriver, RuntimeKind } from './types'
import { opencodeDriver } from './opencode/driver'
import { claudeCodeDriver } from './claudeCode/driver'

export type { RuntimeKind, RuntimeDriver } from './types'

const DRIVERS: Record<RuntimeKind, RuntimeDriver> = {
  opencode: opencodeDriver,
  'claude-code': claudeCodeDriver,
}

/** Look up the driver for a (frozen) runtime kind. Unregistered → opencode. */
export function getRuntimeDriver(kind: RuntimeKind): RuntimeDriver {
  return DRIVERS[kind] ?? opencodeDriver
}

/**
 * RFC-143 — the SINGLE source for "which runtime kinds exist", derived from the
 * DRIVERS registry. `RUNTIME_PROTOCOLS` / `BUILTIN_RUNTIMES` / `BUILTIN_NAMES`
 * (runtimeRegistry.ts) and `ProtocolSchema` (routes/runtimes.ts) all derive from
 * this instead of each re-hardcoding the `'opencode' | 'claude-code'` literal
 * set. Adding a runtime = register a driver here + widen the RuntimeKind union;
 * every derived set updates automatically.
 */
export const RUNTIME_KINDS = Object.keys(DRIVERS) as RuntimeKind[]

/** Type guard: is `v` a registered runtime kind? Replaces the hand-copied
 *  `v === 'opencode' || v === 'claude-code'` checks (nodeRunMint, registry). */
export function isKnownRuntimeKind(v: string | null | undefined): v is RuntimeKind {
  return v != null && (RUNTIME_KINDS as string[]).includes(v)
}
