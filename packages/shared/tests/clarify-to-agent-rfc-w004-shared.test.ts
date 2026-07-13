// RFC-W004 - shared layer: ClarifyToAgentNode schema + NodeKind union +
// NODE_KIND_BEHAVIORS row + port constants.
//
// LOCKS: clarify-to-agent is additive on top of RFC-056 (same 1-in/2-out leaf
// shape, same non-process retry-cascade behavior). If any of these go red the
// surface contracts the runner / validator / canvas all depend on have
// drifted - investigate before relaxing. The declaredPorts shape (owner-kind
// port wiring incl. agent-single's new __clarify_request__ inbound) is
// cross-locked against the SYSTEM_CHANNEL_PORTS registry in
// packages/backend/tests/rfc147-system-channel-ports.test.ts.

import { describe, expect, test } from 'bun:test'

import {
  ClarifyToAgentNodeSchema,
  ClarifyToAgentSessionModeSchema,
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  NodeKindSchema,
  TO_AGENT_CLARIFY_INPUT_PORT_NAME,
  TO_AGENT_CLARIFY_REQUEST_PORT,
  TO_AGENT_OUT_TO_ANSWERER_PORT,
  TO_AGENT_OUT_TO_QUESTIONER_PORT,
} from '@agent-workflow/shared'

describe('RFC-W004 NodeKind union', () => {
  test("NODE_KIND contains 'clarify-to-agent'", () => {
    expect(NODE_KIND).toContain('clarify-to-agent')
    expect(NodeKindSchema.safeParse('clarify-to-agent').success).toBe(true)
  })

  test("'clarify-to-agent' is NOT a wrapper kind (it's a leaf)", () => {
    // Cross-check against the wrapper flag - to-agent must not be mistaken
    // for a container by isWrapperKind (which would break canvas containment
    // + scheduler scope recursion). isWrapperKind lives in schemas/workflow.
    const { isWrapperKind } = require('@agent-workflow/shared')
    expect(isWrapperKind('clarify-to-agent')).toBe(false)
  })
})

describe('RFC-W004 NODE_KIND_BEHAVIORS row (mirrors cross-clarify)', () => {
  test('clarify-to-agent is non-process, no retry placeholder, settles without a row', () => {
    const b = NODE_KIND_BEHAVIORS['clarify-to-agent']
    expect(b).toEqual({
      retryCascade: 'skip',
      isProcess: false,
      isAgent: false,
      settlesWithoutRow: true,
    })
  })

  test('clarify-to-agent behavior equals clarify-cross-agent (sibling leaf)', () => {
    // The two channel leaves share the cross-cutting behavior; the distinct
    // runtime semantics live in services/*Clarify.ts, not this table.
    expect(NODE_KIND_BEHAVIORS['clarify-to-agent']).toEqual(
      NODE_KIND_BEHAVIORS['clarify-cross-agent'],
    )
  })
})

describe('RFC-W004 port constants', () => {
  test('hard-coded port names match the contract (do not rename)', () => {
    expect(TO_AGENT_CLARIFY_INPUT_PORT_NAME).toBe('questions')
    expect(TO_AGENT_OUT_TO_ANSWERER_PORT).toBe('to_answerer')
    expect(TO_AGENT_OUT_TO_QUESTIONER_PORT).toBe('to_questioner')
    expect(TO_AGENT_CLARIFY_REQUEST_PORT).toBe('__clarify_request__')
  })

  test('to_questioner reuses the shared name (return channel is identical to cross-clarify)', () => {
    // The answer flows back to B via to_questioner -> __clarify_response__,
    // the SAME pair cross-clarify uses - no new return port. This asserts the
    // shared name so a future rename of one side stays symmetric.
    expect(TO_AGENT_OUT_TO_QUESTIONER_PORT).toBe('to_questioner')
  })
})

describe('RFC-W004 ClarifyToAgentNode schema', () => {
  test('parses a minimal node (only id + kind required, rest defaults)', () => {
    const res = ClarifyToAgentNodeSchema.safeParse({ id: 'n1', kind: 'clarify-to-agent' })
    expect(res.success).toBe(true)
    if (res.success) {
      expect(res.data.id).toBe('n1')
      expect(res.data.title).toBe('')
      expect(res.data.description).toBe('')
      expect(res.data.sessionModeForAnswerer).toBeUndefined()
    }
  })

  test('rejects wrong kind literal', () => {
    const res = ClarifyToAgentNodeSchema.safeParse({ id: 'n1', kind: 'clarify' })
    expect(res.success).toBe(false)
  })

  test('sessionModeForAnswerer accepts isolated / inline, rejects others', () => {
    expect(ClarifyToAgentSessionModeSchema.safeParse('isolated').success).toBe(true)
    expect(ClarifyToAgentSessionModeSchema.safeParse('inline').success).toBe(true)
    expect(ClarifyToAgentSessionModeSchema.safeParse('ephemeral').success).toBe(false)

    const withInline = ClarifyToAgentNodeSchema.safeParse({
      id: 'n1',
      kind: 'clarify-to-agent',
      sessionModeForAnswerer: 'inline',
    })
    expect(withInline.success).toBe(true)
    if (withInline.success) {
      expect(withInline.data.sessionModeForAnswerer).toBe('inline')
    }
  })

  test('passthrough preserves unknown fields (forward-compat for additive fields)', () => {
    // Mirrors RFC-056 cross-clarify + RFC-023 clarify: .passthrough() keeps
    // future-added fields (e.g. a clarifyMode / mandatory toggle) round-tripping
    // through PUT without a schema bump.
    const res = ClarifyToAgentNodeSchema.safeParse({
      id: 'n1',
      kind: 'clarify-to-agent',
      futureField: { any: 'value' },
    })
    expect(res.success).toBe(true)
  })
})
