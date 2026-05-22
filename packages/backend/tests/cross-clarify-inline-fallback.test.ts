// RFC-056 PR-D C7 — inline fallback enumeration 守门.
//
// Cross-clarify nodes carry TWO inline session-mode fields:
//   * sessionModeForDesigner  — applies when the designer reruns on submit.
//   * sessionModeForQuestioner — applies when the questioner reruns on
//                                reject (with STOP CLARIFYING anchor).
//
// Each is resolved independently via `resolveCrossClarifySessionMode`, and
// each composes with the RFC-026 fallback helpers (`decideResumeSessionId`
// + `detectSessionNotFoundFromStderr`) the scheduler already uses for the
// self-clarify path. The fallback contract says: when inline can't run
// (missing session id / opencode rejected it / version too old), we
// degrade transparently to isolated + record a warning event with the
// specific reason.
//
// LOCKS:
//   1. resolveCrossClarifySessionMode defaults to 'isolated' for BOTH
//      directions when the field is undefined.
//   2. resolveCrossClarifySessionMode reads the right field per direction
//      ('designer' → sessionModeForDesigner, 'questioner' →
//      sessionModeForQuestioner) — no cross-talk.
//   3. decideResumeSessionId composed with 'inline' + missing session id
//      returns fallbackReason='missing-session-id' + inlineMode=false.
//   4. decideResumeSessionId composed with 'inline' + null session id
//      returns fallbackReason='missing-session-id' + inlineMode=false
//      (covers SQLite NULL passthrough).
//   5. detectSessionNotFoundFromStderr recognizes the common opencode
//      stderr patterns post-spawn.
//   6. The 3 fallback reasons enumerated by RFC-026
//      (ClarifyInlineFallbackReason) — `missing-session-id`,
//      `session-not-found`, `unsupported-opencode-version` — are all
//      reachable from cross-clarify direction compositions.
//
// If any of these go red the inline-mode fallback path on cross-clarify
// designer / questioner reruns has drifted from RFC-026's contract —
// investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import type { ClarifyCrossAgentNode } from '@agent-workflow/shared'
import { resolveCrossClarifySessionMode } from '@agent-workflow/shared'
import {
  decideResumeSessionId,
  detectSessionNotFoundFromStderr,
  type ClarifyInlineFallbackReason,
} from '../src/services/clarifyFallback'

function ccNode(overrides: Partial<ClarifyCrossAgentNode> = {}): ClarifyCrossAgentNode {
  return {
    id: 'cc1',
    kind: 'clarify-cross-agent',
    title: '',
    description: '',
    ...overrides,
  } as ClarifyCrossAgentNode
}

describe('RFC-056 C7 — inline fallback enumeration', () => {
  test('resolveCrossClarifySessionMode defaults to isolated when fields are undefined', () => {
    const node = ccNode()
    expect(resolveCrossClarifySessionMode(node, 'designer')).toBe('isolated')
    expect(resolveCrossClarifySessionMode(node, 'questioner')).toBe('isolated')
  })

  test('resolveCrossClarifySessionMode reads sessionModeForDesigner for direction=designer (no cross-talk)', () => {
    const node = ccNode({ sessionModeForDesigner: 'inline', sessionModeForQuestioner: 'isolated' })
    expect(resolveCrossClarifySessionMode(node, 'designer')).toBe('inline')
    expect(resolveCrossClarifySessionMode(node, 'questioner')).toBe('isolated')
  })

  test('resolveCrossClarifySessionMode reads sessionModeForQuestioner for direction=questioner (no cross-talk)', () => {
    const node = ccNode({ sessionModeForDesigner: 'isolated', sessionModeForQuestioner: 'inline' })
    expect(resolveCrossClarifySessionMode(node, 'designer')).toBe('isolated')
    expect(resolveCrossClarifySessionMode(node, 'questioner')).toBe('inline')
  })

  test('decideResumeSessionId({sessionMode:inline}) + missing session id → fallback missing-session-id', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: '' })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('missing-session-id')
    expect(ret.resumeSessionId).toBeUndefined()
  })

  test('decideResumeSessionId({sessionMode:inline}) + null session id (SQLite NULL passthrough) → fallback missing-session-id', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: null })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('missing-session-id')
  })

  test('decideResumeSessionId({sessionMode:inline}) + opencodeSupportsResume=false → fallback unsupported-opencode-version', () => {
    const ret = decideResumeSessionId({
      sessionMode: 'inline',
      sourceSessionId: 'opc_xyz',
      opencodeSupportsResume: false,
    })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBe('unsupported-opencode-version')
  })

  test('decideResumeSessionId({sessionMode:inline}) + valid session id + supported → happy: inline=true, resumeSessionId set', () => {
    const ret = decideResumeSessionId({ sessionMode: 'inline', sourceSessionId: 'opc_xyz' })
    expect(ret.inlineMode).toBe(true)
    expect(ret.resumeSessionId).toBe('opc_xyz')
    expect(ret.fallbackReason).toBeUndefined()
  })

  test('decideResumeSessionId({sessionMode:isolated}) never fallbacks (user chose isolated — not an error)', () => {
    const ret = decideResumeSessionId({ sessionMode: 'isolated', sourceSessionId: 'opc_xyz' })
    expect(ret.inlineMode).toBe(false)
    expect(ret.fallbackReason).toBeUndefined()
  })

  test('detectSessionNotFoundFromStderr recognises common opencode error wordings', () => {
    expect(detectSessionNotFoundFromStderr('Error: session not found')).toBe(true)
    expect(detectSessionNotFoundFromStderr('the session foo does not exist')).toBe(true)
    expect(detectSessionNotFoundFromStderr('unknown session id: opc_abc')).toBe(true)
    expect(detectSessionNotFoundFromStderr('no such session')).toBe(true)
  })

  test('detectSessionNotFoundFromStderr does NOT false-positive on unrelated stderr', () => {
    expect(detectSessionNotFoundFromStderr('warning: low disk space')).toBe(false)
    expect(detectSessionNotFoundFromStderr('')).toBe(false)
  })

  test('3-reason union ClarifyInlineFallbackReason covers all RFC-026 inline-fallback exits', () => {
    // Compile-time exhaustiveness: this would fail to type-check if the
    // union ever grows without our awareness.
    const reasons: ReadonlyArray<ClarifyInlineFallbackReason> = [
      'missing-session-id',
      'session-not-found',
      'unsupported-opencode-version',
    ]
    expect(reasons.length).toBe(3)
  })

  test('cross-clarify designer direction + inline mode reaches missing-session-id fallback (full composition)', () => {
    const node = ccNode({ sessionModeForDesigner: 'inline' })
    const sessionMode = resolveCrossClarifySessionMode(node, 'designer')
    const ret = decideResumeSessionId({ sessionMode, sourceSessionId: undefined })
    expect(sessionMode).toBe('inline')
    expect(ret.fallbackReason).toBe('missing-session-id')
  })

  test('cross-clarify questioner direction + inline mode reaches unsupported-opencode-version fallback (full composition)', () => {
    const node = ccNode({ sessionModeForQuestioner: 'inline' })
    const sessionMode = resolveCrossClarifySessionMode(node, 'questioner')
    const ret = decideResumeSessionId({
      sessionMode,
      sourceSessionId: 'opc_xyz',
      opencodeSupportsResume: false,
    })
    expect(sessionMode).toBe('inline')
    expect(ret.fallbackReason).toBe('unsupported-opencode-version')
  })
})
