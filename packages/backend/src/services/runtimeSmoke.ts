// RFC-112 PR-B — deep-smoke conformance probe. Given a (protocol, binaryPath),
// run ONE minimal real call through that protocol's driver against the binary
// and verify it speaks the protocol end-to-end: emits a parseable stream of the
// driver's events, captures a session id, and — proving it actually consumed the
// prompt and ran a model turn — echoes back a freshly-generated nonce. This is
// the conformance signal (D2: fork version strings are unreliable, so we never
// probe `--version`). Auth / quota / model failures are CLASSIFIED separately
// (Codex P2) so a conforming fork that merely lacks credentials isn't rejected.
//
// Lifecycle is fully self-contained (NOT runNode — no DB rows / worktree): a
// throwaway temp cwd, a try/finally that drains stdout+stderr under a byte cap,
// a process-group kill escalation on timeout, and temp-dir cleanup on every exit.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getRuntimeDriver, type RuntimeKind } from '@/services/runtime'
import { buildOpencodeSpawn } from '@/services/runtime/opencode/spawn'
import { buildClaudeSpawn } from '@/services/runtime/claudeCode/spawn'
import type { SpawnPlan } from '@/services/runtime/types'
import { createLogger, type Logger } from '@/util/log'

export type SmokeOutcome =
  | 'conforms'
  | 'spawn-failed'
  | 'auth-missing'
  | 'model-call-failed'
  | 'stream-nonconforming'

export interface SmokeResult {
  outcome: SmokeOutcome
  conforms: boolean
  detail: string
  capturedSessionId?: string
  sawNonce: boolean
  sawEnvelope: boolean
  exitCode: number | null
}

export interface SmokeOptions {
  protocol: RuntimeKind
  binaryPath: string
  config?: { opencodePath?: string | null; claudeCodePath?: string | null }
  model?: string
  timeoutMs?: number
  /**
   * Bridge the claude subscription credential into the temp config dir (real
   * runs). Tests pass false (mock-claude) so CI never touches the keychain. No
   * effect for the opencode protocol.
   */
  bridgeCredentials?: boolean
  log?: Logger
}

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const AUTH_SIGNATURES =
  /not logged in|unauthorized|authentication|invalid api key|please run .*login|no api key|anthropic_api_key|log ?in to/i
const MODEL_FAIL_SIGNATURES =
  /rate limit|overloaded|quota|model .*not found|insufficient|too many requests|503|529/i

/** kill the whole process group (the child is `detached`), best-effort. */
function killGroup(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    if (typeof child.pid === 'number') process.kill(-child.pid, signal)
    else child.kill(signal === 'SIGKILL' ? 9 : 15)
  } catch {
    /* already gone */
  }
}

/** Build the protocol's minimal smoke spawn plan (binary head = [binaryPath]). */
function buildSmokePlan(
  protocol: RuntimeKind,
  binaryPath: string,
  attemptDir: string,
  prompt: string,
  model: string | undefined,
  bridgeCredentials: boolean,
  log: Logger,
): SpawnPlan {
  if (protocol === 'claude-code') {
    return buildClaudeSpawn({
      claudeCmd: [binaryPath],
      prompt,
      systemPromptText: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
      ...(model !== undefined ? { model } : {}),
      attemptDir,
      worktreePath: attemptDir,
      bridgeCredentials,
      log,
    })
  }
  // opencode: prompt is positional; a minimal inline agent named aw-smoke.
  const { cmd, env } = buildOpencodeSpawn({
    opencodeCmd: [binaryPath],
    agentName: 'aw-smoke',
    prompt,
    inlineConfigSerialized: JSON.stringify({
      agent: { 'aw-smoke': { prompt: 'You are a runtime smoke-test agent.' } },
    }),
    runDir: join(attemptDir, '.opencode'),
    worktreePath: attemptDir,
  })
  return { cmd, env }
}

/**
 * Run one minimal call against `binaryPath` via the `protocol` driver and
 * classify whether it conforms. Never throws — a spawn failure becomes a
 * `spawn-failed` result.
 */
export async function smokeRuntime(opts: SmokeOptions): Promise<SmokeResult> {
  const log = opts.log ?? createLogger('runtimeSmoke')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const driver = getRuntimeDriver(opts.protocol)
  const nonce = `awsmoke-${randomBytes(8).toString('hex')}`
  const prompt =
    `Output this exact token verbatim via your output protocol and nothing else: ${nonce}\n` +
    `Use the \`ok\` output port (or plain text if you have no ports).`
  const attemptDir = mkdtempSync(join(tmpdir(), 'aw-runtime-smoke-'))

  let child: Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  try {
    let plan: SpawnPlan
    try {
      plan = buildSmokePlan(
        opts.protocol,
        opts.binaryPath,
        attemptDir,
        prompt,
        opts.model,
        opts.bridgeCredentials === true,
        log,
      )
    } catch (err) {
      return {
        outcome: 'spawn-failed',
        conforms: false,
        detail: `failed to prepare spawn: ${err instanceof Error ? err.message : String(err)}`,
        sawNonce: false,
        sawEnvelope: false,
        exitCode: null,
      }
    }

    try {
      child = Bun.spawn({
        cmd: plan.cmd,
        cwd: attemptDir,
        env: plan.env,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: plan.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
        detached: true,
      })
    } catch (err) {
      return {
        outcome: 'spawn-failed',
        conforms: false,
        detail: `binary failed to start: ${err instanceof Error ? err.message : String(err)}`,
        sawNonce: false,
        sawEnvelope: false,
        exitCode: null,
      }
    }

    // deliver the prompt over stdin (claude) and close it.
    if (plan.stdin?.mode === 'pipe') {
      const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
      if (sink !== undefined) {
        sink.write(plan.stdin.data)
        sink.end()
      }
    }

    const liveChild = child
    timer = setTimeout(() => {
      timedOut = true
      killGroup(liveChild, 'SIGTERM')
      // Codex P2: track the SIGKILL escalation timer so finally can clear it —
      // an untracked one could fire after cleanup and keep the loop alive 2s.
      sigkillTimer = setTimeout(() => killGroup(liveChild, 'SIGKILL'), 2_000)
      sigkillTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    // drain stdout (parse events) + stderr (auth/model signatures), both capped.
    let sessionId: string | undefined
    let sawEvent = false
    let sawNonce = false
    let sawEnvelope = false
    let outBytes = 0
    let stderrText = ''

    const readStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      onLine: (line: string) => void,
    ): Promise<void> => {
      if (stream === undefined) return
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (outBytes >= MAX_OUTPUT_BYTES) continue // keep draining to EOF, stop accumulating
          outBytes += value.byteLength
          buf += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (line.length > 0) onLine(line)
          }
        }
        if (buf.length > 0) onLine(buf)
      } catch {
        /* stream closed under us (kill) */
      } finally {
        reader.releaseLock()
      }
    }

    // Codex P2: the nonce + envelope are detected ONLY in PARSED event text —
    // proving the model produced them THROUGH the protocol stream, not on a raw
    // stdout line a non-protocol binary could also print. drainAll runs
    // concurrently; the timeout timer kills the child if it overruns.
    const drainAll = Promise.all([
      readStream(child.stdout as ReadableStream<Uint8Array> | undefined, (line) => {
        const ev = driver.parseEvent(line)
        if (ev !== null) {
          sawEvent = true
          if (ev.sessionId !== undefined && sessionId === undefined) sessionId = ev.sessionId
          if (typeof ev.text === 'string') {
            if (ev.text.includes(nonce)) sawNonce = true
            if (ev.text.includes('<workflow-output')) sawEnvelope = true
          }
        }
      }),
      readStream(child.stderr as ReadableStream<Uint8Array> | undefined, (line) => {
        if (stderrText.length < 8_192) stderrText += line + '\n'
      }),
    ])

    const exitCode = await child.exited
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (sigkillTimer !== null) {
      clearTimeout(sigkillTimer)
      sigkillTimer = null
    }
    // Codex P2: bounded post-exit flush — a grandchild that inherited the stdout
    // pipe must not wedge the probe; classify on whatever drained within 2s.
    await Promise.race([
      drainAll,
      new Promise<void>((resolve) => {
        const g = setTimeout(resolve, 2_000)
        g.unref?.()
      }),
    ])

    const haystack = `${stderrText}`.toLowerCase()
    const authHit = AUTH_SIGNATURES.test(haystack)
    const modelHit = MODEL_FAIL_SIGNATURES.test(haystack)
    // Codex P2: conformance REQUIRES the nonce round-trip (a real protocol turn
    // consumed the prompt) — sawEnvelope alone is too weak (a canned emitter).
    const conformed = !timedOut && exitCode === 0 && sawEvent && sessionId !== undefined && sawNonce

    let outcome: SmokeOutcome
    let detail: string
    if (conformed) {
      outcome = 'conforms'
      detail = `binary speaks the ${opts.protocol} protocol (session captured, nonce echoed)`
    } else if (timedOut) {
      outcome = 'model-call-failed'
      detail = `timed out after ${timeoutMs}ms`
    } else if (authHit) {
      outcome = 'auth-missing'
      detail = 'binary started but authentication failed (may still conform once credentials exist)'
    } else if (modelHit) {
      outcome = 'model-call-failed'
      detail = 'binary started + authed but the model call failed (rate limit / unavailable)'
    } else if (!sawEvent) {
      outcome = 'stream-nonconforming'
      detail = `no parseable ${opts.protocol} events on stdout (exit ${exitCode})`
    } else {
      outcome = 'stream-nonconforming'
      detail = `emitted events but did not complete the protocol turn (exit ${exitCode}, nonce ${
        sawNonce ? 'seen' : 'missing'
      })`
    }

    return {
      outcome,
      conforms: outcome === 'conforms',
      detail,
      ...(sessionId !== undefined ? { capturedSessionId: sessionId } : {}),
      sawNonce,
      sawEnvelope,
      exitCode,
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (sigkillTimer !== null) clearTimeout(sigkillTimer)
    if (child !== null) {
      killGroup(child, 'SIGKILL')
    }
    try {
      rmSync(attemptDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
