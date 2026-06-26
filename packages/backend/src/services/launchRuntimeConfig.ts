// RFC-103 T2 + RFC-108 T4 — single source for launch-time runtime config.
//
// Resolves the settings that must be threaded into `StartTaskDeps` for EVERY
// scheduler-kicking entry point (JSON start / multipart start / resume / retry /
// repair-resume / parked clarify+review resume / fusion). Before this lived in
// routes/tasks.ts and only the task routes used it, so other production kicks
// (fusion, parked clarify/review resume) ran nodes with no commit&push, no
// concurrency cap, and — pre-RFC-108 — no hard-timeout floor (Codex impl gate
// P2). Hoisting it here lets all routes share one resolver.

import { loadConfig } from '@/config'

/** RFC-075: read the auto commit&push runtime config from settings. */
export function resolveCommitPushConfig(
  configPath: string,
): { model?: string; maxRepairRetries?: number; diffMaxBytes?: number } | undefined {
  try {
    const cfg = loadConfig(configPath)
    const out: { model?: string; maxRepairRetries?: number; diffMaxBytes?: number } = {}
    if (cfg.commitPushModel !== undefined) out.model = cfg.commitPushModel
    if (cfg.commitPushMaxRepairRetries !== undefined)
      out.maxRepairRetries = cfg.commitPushMaxRepairRetries
    if (cfg.commitPushDiffMaxBytes !== undefined) out.diffMaxBytes = cfg.commitPushDiffMaxBytes
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve runtime config (auto commit&push + global concurrency cap + RFC-108
 * per-node hard-timeout floor) from settings ONCE, for every launch entry
 * point. Single source so the entries can't drift again.
 *
 * RFC-108 T4 (AR-01): `defaultPerNodeTimeoutMs` (config default 30min) is read
 * here and threaded into `StartTaskDeps`; the scheduler uses it as
 * `pickNumber(node,'timeoutMs') ?? opts.defaultPerNodeTimeoutMs`, so every node
 * gets a hard kill bound (a per-node override still RAISES it). Before RFC-108
 * this field existed but was threaded NOWHERE — default-config nodes ran with
 * no timeout, so a hung-but-alive opencode child was effectively immortal.
 */
export function resolveLaunchRuntimeConfig(configPath: string): {
  commitPush?: { model?: string; maxRepairRetries?: number; diffMaxBytes?: number }
  maxConcurrentNodes?: number
  defaultPerNodeTimeoutMs?: number
  defaultRuntime?: 'opencode' | 'claude-code'
} {
  const out: {
    commitPush?: { model?: string; maxRepairRetries?: number; diffMaxBytes?: number }
    maxConcurrentNodes?: number
    defaultPerNodeTimeoutMs?: number
    defaultRuntime?: 'opencode' | 'claude-code'
  } = {}
  const commitPush = resolveCommitPushConfig(configPath)
  if (commitPush !== undefined) out.commitPush = commitPush
  try {
    const cfg = loadConfig(configPath)
    if (cfg.maxConcurrentNodes !== undefined) out.maxConcurrentNodes = cfg.maxConcurrentNodes
    if (cfg.defaultPerNodeTimeoutMs !== undefined && cfg.defaultPerNodeTimeoutMs > 0)
      out.defaultPerNodeTimeoutMs = cfg.defaultPerNodeTimeoutMs
    // RFC-111: global default runtime threaded to the scheduler dispatch site.
    if (cfg.defaultRuntime !== undefined) out.defaultRuntime = cfg.defaultRuntime
  } catch {
    // fall back to the scheduler defaults
  }
  return out
}
