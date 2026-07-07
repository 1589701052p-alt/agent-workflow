// opencode binary discovery + version probe + min-version gate.
//
// Min version was verified hands-on in P-0-01 (design.md §18 #1).
// Bumping requires re-validating the 4 isolation experiments.

import { createLogger } from './log'
import { killProcessTree } from './platform'

const log = createLogger('opencode')

/**
 * Minimum supported opencode version.
 * Below this the daemon refuses to start (design.md §11.2).
 *
 * There is intentionally NO upper bound: the daemon accepts any version
 * `>= MIN_OPENCODE_VERSION`. A cap used to exist as a "you just bumped past a
 * minor — manually re-verify" tripwire, but the PWD/cwd spawn regression that
 * motivated it is now handled at the spawn site (services/runner.ts +
 * services/memoryDistiller.ts explicitly set `PWD = cwd`), so newer opencode
 * releases no longer need a gate to admit them. See the test file for the full
 * historical rationale.
 */
export const MIN_OPENCODE_VERSION = '1.14.0'

/**
 * RFC-135: optional knobs for the `--version` probes (opencode + claude-code).
 * Omitting both fields is byte-identical to the historical behavior — the
 * daemon startup probe and the legacy callers pass nothing.
 */
export interface ProbeOpts {
  /**
   * Kill the probe after this many ms. Uses SIGKILL (an ignorable SIGTERM
   * followed by an unbounded `proc.exited` wait would re-hang the caller —
   * RFC-135 D5); the result reads as a failed probe (`ran: false`).
   */
  timeoutMs?: number
  /**
   * Suppress per-probe warn logs. The polling status endpoint owns its own
   * surfacing (the response/UI already shows the failure); without this an
   * expectedly-missing optional runtime would warn every poll cycle.
   */
  quiet?: boolean
}

export interface OpencodeProbe {
  /** Resolved binary path (absolute when overridden, "opencode" when on PATH). */
  binary: string
  /** Parsed "X.Y.Z" string, or null if not found / parse failed. */
  version: string | null
  /**
   * True iff `version >= MIN_OPENCODE_VERSION`.
   * False on probe failure or too old (there is no upper bound).
   */
  compatible: boolean
  /**
   * When the binary is present but below the minimum, this carries a
   * human-readable reason so the daemon log / runtime route surfaces "why
   * incompatible" rather than just "<= min".
   */
  incompatibleReason?: string
  /**
   * RFC-135: true iff the `--version` process exited 0 — availability without
   * any version parsing/gating (a custom binary with an unparseable version
   * string still counts as runnable). `version`/`compatible` stay as-is for
   * the daemon startup gate, which is out of RFC-135's scope.
   */
  ran?: boolean
}

/**
 * Spawn `<binary> --version`, parse the semver prefix.
 * Returns null if the binary cannot be executed or output is unparseable.
 */
export async function probeOpencode(
  opencodePath?: string,
  opts: ProbeOpts = {},
): Promise<OpencodeProbe> {
  const binary = opencodePath ?? 'opencode'
  const warn: typeof log.warn = opts.quiet === true ? () => {} : (msg, ctx) => log.warn(msg, ctx)
  let version: string | null = null
  let ran = false
  try {
    // With a timeout the probe runs in its OWN process group (detached) so the
    // timeout can SIGKILL the whole tree: killing only the direct child leaves
    // a hung wrapper's grandchild alive and leaking once per poll (Codex impl
    // gate). Without a timeout the historical flat spawn is kept byte-for-byte.
    const proc = Bun.spawn({
      cmd: [binary, '--version'],
      stdout: 'pipe',
      stderr: 'pipe',
      ...(opts.timeoutMs !== undefined ? { detached: true } : {}),
    })
    let timedOut = false
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            // RFC-144 PR-1: delegate to platform.killProcessTree — POSIX still
            // group-kills via `process.kill(-pid)` (byte-for-byte), Windows uses
            // `taskkill /T /F`. The previous `proc.kill` fallback is handled
            // inside killProcessTree's single-pid branch.
            if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
          }, opts.timeoutMs)
        : undefined
    try {
      // Do NOT tie the exit wait to the stdout read: a grandchild process can
      // inherit the pipe's write end and keep text() from ever seeing EOF even
      // after SIGKILL reaps the direct child (a hung `sh`-wrapper fork does
      // exactly this). Await the exit first; then bound the stdout read too.
      const outPromise = new Response(proc.stdout).text().catch(() => '')
      const exitCode = await proc.exited
      if (timedOut) {
        warn('opencode --version timed out', { binary, timeoutMs: opts.timeoutMs })
      } else if (exitCode === 0) {
        ran = true
        const out =
          opts.timeoutMs !== undefined
            ? await Promise.race([
                outPromise,
                new Promise<string>((res) => setTimeout(() => res(''), opts.timeoutMs)),
              ])
            : await outPromise
        version = extractVersion(out)
      } else {
        warn('opencode --version non-zero exit', { binary, exitCode })
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        // The probe is over — anything still alive in the detached group is a
        // leaked descendant of a misbehaving wrapper (e.g. it forked then
        // exited non-zero BEFORE the timer fired, so the timeout never reaped
        // the group). Kill unconditionally; an already-gone group is a no-op.
        // RFC-144 PR-1: delegated to platform.killProcessTree (cross-platform).
        if (typeof proc.pid === 'number') killProcessTree(proc.pid, 'SIGKILL')
      }
    }
  } catch (err) {
    warn('opencode binary not executable', { binary, error: (err as Error).message })
  }

  if (version === null) {
    return { binary, version, compatible: false, ran }
  }
  if (compareSemver(version, MIN_OPENCODE_VERSION) < 0) {
    return {
      binary,
      version,
      compatible: false,
      incompatibleReason: `opencode ${version} is older than required minimum ${MIN_OPENCODE_VERSION}`,
      ran,
    }
  }
  return { binary, version, compatible: true, ran }
}

/** Extract first "X.Y.Z" from arbitrary output. */
export function extractVersion(s: string): string | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/**
 * Compare two semver strings (major.minor.patch only; prerelease ignored).
 * Returns negative / 0 / positive (sortable).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return 0
  for (let i = 0; i < 3; i++) {
    const ai = pa[i]
    const bi = pb[i]
    if (ai === undefined || bi === undefined) continue
    if (ai !== bi) return ai - bi
  }
  return 0
}

function parse(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  const out: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (out.some((n) => !Number.isFinite(n))) return null
  return out
}
