// RFC-112 PR-B — deep-smoke conformance probe. smokeRuntime runs ONE minimal
// call through a protocol driver against a binary and classifies whether it
// speaks the protocol end-to-end (parseable events + captured session id + an
// echoed nonce). Auth/quota failures are classified apart from non-conformance
// (Codex P2). The mock binaries echo the prompt (MOCK_*_ECHO_PROMPT) so the
// freshly-generated nonce round-trips; a non-protocol binary (/bin/echo) emits
// no parseable events → stream-nonconforming; a missing path → spawn-failed.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { smokeRuntime } from '../src/services/runtimeSmoke'

const MOCK_CLAUDE = resolve(import.meta.dir, 'fixtures', 'mock-claude.ts')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const SMOKE_TIMEOUT = 30_000

/** A single executable wrapper that execs `bun run <mock>` (binaryPath is one path). */
function wrapperFor(mockFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-smoke-bin-'))
  const wrapper = join(dir, 'runtime-bin')
  writeFileSync(wrapper, `#!/bin/sh\nexec bun run ${mockFile} "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

const SET_ENV_KEYS = [
  'MOCK_CLAUDE_ECHO_PROMPT',
  'MOCK_CLAUDE_SESSION_ID',
  'MOCK_CLAUDE_SKIP_ENVELOPE',
  'MOCK_CLAUDE_OUTPUTS',
  'MOCK_CLAUDE_IS_ERROR',
  'MOCK_CLAUDE_RESULT_TEXT',
  'MOCK_CLAUDE_EXIT_CODE',
  'MOCK_OPENCODE_ECHO_PROMPT',
  'MOCK_OPENCODE_EMIT_SESSION_ID',
  'MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS',
]
afterEach(() => {
  for (const k of SET_ENV_KEYS) delete process.env[k]
})

describe('smokeRuntime (RFC-112 PR-B)', () => {
  test(
    'claude binary that echoes the prompt + emits a session → conforms',
    async () => {
      process.env.MOCK_CLAUDE_ECHO_PROMPT = '1'
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-cc'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.sawNonce).toBe(true)
      expect(r.capturedSessionId).toBe('smoke-sess-cc')
      expect(r.exitCode).toBe(0)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'opencode binary that echoes the prompt + emits a session → conforms',
    async () => {
      process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
      process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
      const r = await smokeRuntime({
        protocol: 'opencode',
        binaryPath: wrapperFor(MOCK_OPENCODE),
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.sawNonce).toBe(true)
      expect(r.capturedSessionId).toBe('opc_mock_session_01')
    },
    SMOKE_TIMEOUT,
  )

  // Regression: opencode 1.17+ writes a `.gitignore` into OPENCODE_CONFIG_DIR on
  // startup and exits 1 (no events) if the dir is missing. The smoke probe set
  // OPENCODE_CONFIG_DIR=<attemptDir>/.opencode but never mkdir'd it, so EVERY
  // real opencode probe failed → stream-nonconforming ("no parseable events").
  // The mock now reproduces the startup write; with the runDir mkdir in place
  // this conforms, and reverting the mkdir turns it red.
  test(
    'opencode whose startup writes into OPENCODE_CONFIG_DIR → conforms (smoke must create the runDir)',
    async () => {
      process.env.MOCK_OPENCODE_ECHO_PROMPT = '1'
      process.env.MOCK_OPENCODE_EMIT_SESSION_ID = '1'
      process.env.MOCK_OPENCODE_REQUIRE_CONFIG_DIR_EXISTS = '1'
      const r = await smokeRuntime({
        protocol: 'opencode',
        binaryPath: wrapperFor(MOCK_OPENCODE),
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('conforms')
      expect(r.conforms).toBe(true)
      expect(r.exitCode).toBe(0)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a binary that emits events + a session but never the nonce → stream-nonconforming',
    async () => {
      // session emitted, but envelope suppressed + no echo → no nonce, no envelope.
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-x'
      process.env.MOCK_CLAUDE_SKIP_ENVELOPE = '1'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
      expect(r.sawNonce).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a binary that emits an envelope but never echoes the nonce → stream-nonconforming (Codex P2: nonce required)',
    async () => {
      // envelope present (sawEnvelope) but no prompt echo → the nonce never
      // round-trips. The old (sawNonce ∨ sawEnvelope) gate would have FALSELY
      // passed this; conformance now requires the nonce.
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-env'
      process.env.MOCK_CLAUDE_OUTPUTS = '{"ok":"done"}'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.sawEnvelope).toBe(true)
      expect(r.sawNonce).toBe(false)
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  // Regression: claude reports auth / API failures on STDOUT (the stream-json
  // `result` event, e.g. "...authentication failed... 403 Request not allowed"),
  // not stderr — so a reachable-but-unauthenticated (or proxy-blocked) claude
  // that speaks the protocol perfectly was misclassified as `stream-nonconforming`
  // ("doesn't speak the protocol"). The smoke now scans stdout too, so this lands
  // as `auth-missing`. The user-facing symptom was claude probes showing red
  // "non-conforming" when the daemon simply lacked the proxy to reach the API.
  test(
    'claude that emits an auth error on stdout → auth-missing (not stream-nonconforming)',
    async () => {
      process.env.MOCK_CLAUDE_SESSION_ID = 'smoke-sess-autherr'
      process.env.MOCK_CLAUDE_IS_ERROR = '1'
      process.env.MOCK_CLAUDE_EXIT_CODE = '1'
      process.env.MOCK_CLAUDE_RESULT_TEXT =
        'API Error: 403 Request not allowed (authentication failed)'
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: wrapperFor(MOCK_CLAUDE),
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('auth-missing')
      expect(r.conforms).toBe(false)
      expect(r.sawNonce).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a non-protocol binary (/bin/echo) emits no parseable events → stream-nonconforming',
    async () => {
      const r = await smokeRuntime({
        protocol: 'claude-code',
        binaryPath: '/bin/echo',
        bridgeCredentials: false,
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('stream-nonconforming')
      expect(r.conforms).toBe(false)
    },
    SMOKE_TIMEOUT,
  )

  test(
    'a missing binary path → spawn-failed',
    async () => {
      const r = await smokeRuntime({
        protocol: 'opencode',
        binaryPath: '/definitely/not/a/real/binary/aw-xyz',
        timeoutMs: SMOKE_TIMEOUT,
      })
      expect(r.outcome).toBe('spawn-failed')
      expect(r.conforms).toBe(false)
      expect(r.exitCode).toBeNull()
    },
    SMOKE_TIMEOUT,
  )
})
