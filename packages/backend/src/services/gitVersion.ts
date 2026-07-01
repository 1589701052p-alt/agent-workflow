// RFC-034: probe `git --version` once at daemon start and cache the result so
// callers (gitRepoCache cold/warm paths, createWorktree) can decide whether
// `--jobs` and worktree-in-submodule are safe on the local git binary.
//
// Why: `git submodule --jobs` is stable from 2.13; worktree + submodule
// interaction is stable from 2.5. Older git is rare on macOS/Linux dev
// machines but the platform must not crash hard when it shows up.

import { runGit } from '@/util/git'

export interface GitSemver {
  major: number
  minor: number
  patch: number
  raw: string
}

export interface GitCapabilities {
  version: GitSemver | null
  /** ≥ 2.13 — required for `git submodule update --jobs N`. */
  supportsSubmoduleJobs: boolean
  /** ≥ 2.5 — required for stable worktree + submodule interaction. */
  supportsRecurseInWorktree: boolean
  /**
   * RFC-130 D7: ≥ 2.38 — required for `git merge-tree --write-tree`, the in-memory
   * 3-way merge that RFC-130's serial merge-back depends on. Below this the daemon
   * refuses isolated execution (fail-loud, not silent corruption).
   */
  supportsMergeTreeWriteTree: boolean
}

let cached: GitCapabilities | null = null

/** Parse `git version 2.39.3 (Apple Git-145)` → semver. */
export function parseGitVersion(raw: string): GitSemver | null {
  const m = raw.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = m[3] === undefined ? 0 : Number(m[3])
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null
  }
  return { major, minor, patch, raw: raw.trim() }
}

/** True iff `v` is ≥ the (major, minor) tuple. */
export function gitVersionAtLeast(v: GitSemver | null, major: number, minor: number): boolean {
  if (!v) return false
  if (v.major > major) return true
  if (v.major < major) return false
  return v.minor >= minor
}

export function capabilitiesFromVersion(v: GitSemver | null): GitCapabilities {
  return {
    version: v,
    supportsSubmoduleJobs: gitVersionAtLeast(v, 2, 13),
    supportsRecurseInWorktree: gitVersionAtLeast(v, 2, 5),
    supportsMergeTreeWriteTree: gitVersionAtLeast(v, 2, 38),
  }
}

/** Run `git --version`, parse, cache. Idempotent — call multiple times safely. */
export async function detectGitCapabilities(): Promise<GitCapabilities> {
  // runGit(cwd, ['--version']) is fine — git ignores -C for --version
  const r = await runGit(process.cwd(), ['--version'])
  const v = r.exitCode === 0 ? parseGitVersion(r.stdout) : null
  cached = capabilitiesFromVersion(v)
  return cached
}

/** Read whatever `detectGitCapabilities` last produced. `null` until first probe. */
export function getCachedGitCapabilities(): GitCapabilities | null {
  return cached
}

/** Test hook: force the cache to a known value (bypassing real git probe). */
export function __setCachedGitCapabilitiesForTesting(caps: GitCapabilities | null): void {
  cached = caps
}
