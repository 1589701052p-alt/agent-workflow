// util/platform.ts — the SINGLE source of platform branching for the daemon.
//
// RFC-144 PR-1: every `process.platform === 'win32'` check in the business
// layer must live here (or in runtime/wsl-opencode/). Callers in runner /
// scheduler / routes / services call these primitives and never inspect the
// platform themselves — same discipline as RFC-143's "判别归零" rule, applied
// to the OS axis. Source-text lock in tests/platform.test.ts guards this.
//
// POSIX behaviour is byte-for-byte identical to the pre-RFC-144 implementations
// that lived in util/process.ts (which now delegates here). Windows branches
// realise the same semantics via Job-Object-equivalent / wmic / taskkill
// mechanisms — see design/RFC-144-windows-adaptation/design.md §3.

/** True iff the daemon is running under Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff `pid` is a live process this user can signal (or at least exists).
 * Cross-platform: `process.kill(pid, 0)` works on both POSIX and Windows
 * (EPERM ⇒ exists but unowned, ESRCH ⇒ gone).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // EPERM means the process exists but we don't have permission to signal it.
    return e.code === 'EPERM'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-tree kill
// ─────────────────────────────────────────────────────────────────────────────

export type KillTreeSignal = 'SIGTERM' | 'SIGKILL'

/**
 * Best-effort kill of `pid`'s WHOLE process tree.
 *
 * - POSIX: the runner spawns opencode with `detached: true` (setsid() → the
 *   child is its own group leader), so `process.kill(-pid, sig)` reaches
 *   grandchildren too. Falls back to a single-pid kill when the group signal
 *   fails. Byte-for-byte identical to the pre-RFC-144 implementation.
 * - Windows: there are no process groups / setsid. `taskkill /T /F /PID` kills
 *   the whole tree (the closest equivalent without a kernel Job Object).
 *   Job-Object hardening for grandchildren that detach from the tree is
 *   tracked as future work (design §3.1 / §9); `/T` is sufficient for the
 *   common case and ships without a native addon.
 */
export function killProcessTree(pid: number, signal: KillTreeSignal): boolean {
  if (isWindows()) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    // Windows ignores the `signal` argument — there is no graceful SIGTERM, so
    // both SIGTERM and SIGKILL map to a forced tree kill. The runner's
    // SIGTERM→SIGKILL escalation is a no-op escalation on Windows (by design:
    // graceful shutdown goes through the HTTP /shutdown channel instead, see
    // design §3.2). We still honour the call for parity with the POSIX API.
    try {
      const res = Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)])
      return res.exitCode === 0
    } catch {
      return false
    }
  }

  // POSIX (byte-for-byte original).
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PID command-line fingerprint (stale-process identity gate, RFC-108 T9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The raw command-line string of `pid`, or null if it cannot be obtained.
 *
 * - POSIX: `ps -p <pid> -o command=` (byte-for-byte original).
 * - Windows: `wmic process where ProcessId=<pid> get CommandLine` (present on
 *   Win7+, deprecated on new Win11 but still shipped) with a PowerShell
 *   `Get-CimInstance Win32_Process` fallback.
 */
export function pidCommandLine(pid: number): string | null {
  if (isWindows()) {
    // 1. wmic (broad compatibility).
    try {
      const res = Bun.spawnSync([
        'wmic',
        'process',
        'where',
        `ProcessId=${pid}`,
        'get',
        'CommandLine',
        '/format:list',
      ])
      if (res.exitCode === 0) {
        const out = res.stdout.toString()
        // /format:list → "CommandLine=<...>\r\n"
        const m = out.match(/CommandLine=(.*)/)
        const cmd = m?.[1]
        if (typeof cmd === 'string' && cmd.trim().length > 0) return cmd.trim()
      }
    } catch {
      /* fall through to PowerShell */
    }
    // 2. PowerShell CIM fallback (wmic absent / future Win deprecation).
    try {
      const res = Bun.spawnSync([
        'powershell',
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ])
      if (res.exitCode === 0) {
        const out = res.stdout.toString().trim()
        if (out.length > 0) return out
      }
    } catch {
      /* give up */
    }
    return null
  }

  // POSIX (byte-for-byte original).
  try {
    const res = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command='])
    if (res.exitCode !== 0) return null
    return res.stdout.toString()
  } catch {
    return null
  }
}

/**
 * RFC-108 T9 fuzzy gate: does the live pid's command look like one of our
 * children (the real `opencode` binary, or `bun` running a test fixture /
 * source checkout)? POSIX: `/opencode|bun/i` over `ps` output (original).
 * Windows: same regex over the wmic/CIM command line.
 */
export function pidCommandLooksLikeAgentChild(pid: number): boolean {
  const cmd = pidCommandLine(pid)
  if (cmd === null) return false
  return /opencode|bun/i.test(cmd)
}

/**
 * RFC-108 T9 SPECIFIC gate: does the live pid's command contain the EXACT
 * binary path we spawned for this run? POSIX: case-sensitive `.includes`
 * (original). Windows: case-insensitive — Windows paths are case-insensitive
 * and the path wmic echoes back may differ in case / separator from the spawn
 * argument, so a case-sensitive match would falsely report 'command-mismatch'
 * (recycled pid) for our own child.
 */
export function pidCommandContainsBinary(pid: number, binaryPath: string): boolean {
  const cmd = pidCommandLine(pid)
  if (cmd === null) return false
  if (isWindows()) {
    // Normalise backslashes to a common separator and compare case-insensitively.
    const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/')
    return norm(cmd).includes(norm(binaryPath))
  }
  return cmd.includes(binaryPath)
}
