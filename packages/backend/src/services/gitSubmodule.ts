// RFC-034: idempotent helper that syncs + initializes git submodules on a
// given working directory. Called from gitRepoCache cold/warm paths and from
// createWorktree right after `git worktree add`.
//
// Contract: never throws — failures are surfaced via `ok: false` so callers
// can decide whether to fail-loud (cold clone) or fail-quiet (warm fetch /
// worktree init, which only emit warnings).

import { redactGitUrl } from '@agent-workflow/shared'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runGit } from '@/util/git'

export type SubmoduleMode = 'auto' | 'always' | 'never'

export interface SubmoduleSyncOptions {
  mode: SubmoduleMode
  jobs: number
  /** Override the redaction step (default: shared `redactGitUrl`). */
  redactStderr?: (s: string) => string
  /** Test hook: replace runGit. */
  runGitImpl?: typeof runGit
}

export interface SubmoduleSyncResult {
  ok: boolean
  /** Already-redacted; safe to log / persist / send to clients. */
  error: string | null
  hasGitmodules: boolean
}

/** Probe-only: does the working tree have a `.gitmodules` at its root? */
export function detectSubmodules(repoPath: string): boolean {
  try {
    return existsSync(join(repoPath, '.gitmodules'))
  } catch {
    return false
  }
}

function defaultRedact(s: string): string {
  return redactGitUrl(s.trim())
}

/**
 * Run `git submodule sync --recursive && git submodule update --init
 * --recursive --jobs N` on `repoPath`. Idempotent — repeated calls on a
 * fully-initialized tree are cheap no-ops.
 *
 * - `mode='never'`: short-circuit with ok=true, hasGitmodules=false, no git
 *   processes spawned. Used as the platform escape hatch.
 * - `mode='auto'`: skip when `.gitmodules` is absent; otherwise run.
 * - `mode='always'`: always run (idempotent no-op when `.gitmodules` absent).
 */
export async function syncSubmodules(
  repoPath: string,
  opts: SubmoduleSyncOptions,
): Promise<SubmoduleSyncResult> {
  const redact = opts.redactStderr ?? defaultRedact
  const run = opts.runGitImpl ?? runGit

  if (opts.mode === 'never') {
    return { ok: true, error: null, hasGitmodules: false }
  }

  const hasGitmodules = detectSubmodules(repoPath)
  if (opts.mode === 'auto' && !hasGitmodules) {
    return { ok: true, error: null, hasGitmodules: false }
  }

  // `submodule sync` is cheap and idempotent — pulls any URL changes from
  // .gitmodules into .git/config. Failure here is fatal for this pass.
  const sync = await run(repoPath, ['submodule', 'sync', '--recursive'])
  if (sync.exitCode !== 0) {
    return {
      ok: false,
      error: redact(sync.stderr) || 'submodule sync failed (no stderr)',
      hasGitmodules,
    }
  }

  const updateArgs = ['submodule', 'update', '--init', '--recursive']
  // jobs=1 is the default; only emit --jobs when > 1 so we play nice with
  // ancient git versions and keep argv small in logs.
  if (opts.jobs > 1) {
    updateArgs.push('--jobs', String(opts.jobs))
  }
  const update = await run(repoPath, updateArgs)
  if (update.exitCode !== 0) {
    return {
      ok: false,
      error: redact(update.stderr) || 'submodule update failed (no stderr)',
      hasGitmodules,
    }
  }

  return { ok: true, error: null, hasGitmodules }
}
