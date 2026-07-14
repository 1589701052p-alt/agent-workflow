// RFC-W004 - shared layer: to-agent edge builders + finders + session-mode
// resolver + isClarifyChannelEdge coverage.
//
// LOCKS: the to-agent reverse-drag auto-edges mirror RFC-056 cross-clarify's
// pair (B.__clarify__ -> questions / to_questioner -> B.__clarify_response__);
// the manual to_answerer edge targets A.__clarify_request__. If any of these
// go red the canvas drag helper + scheduler finder contracts have drifted -
// investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  buildToAgentAnswererEdge,
  buildToAgentAutoEdges,
  findToAgentNodeForQuestioner,
  isClarifyChannelEdge,
  resolveToAgentSessionMode,
  type ClarifyToAgentNode,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

const Q = 'agent_b'
const T = 'to_agent_1'
const A = 'agent_a'

describe('RFC-W004 buildToAgentAutoEdges - reverse-drag auto pair', () => {
  test('returns exactly 2 edges mirroring cross-clarify (B asks, answer returns to B)', () => {
    const edges = buildToAgentAutoEdges(Q, T)
    expect(edges).toHaveLength(2)

    // 1. B.__clarify__ -> to_agent.questions  (B's question outlet)
    expect(edges[0]).toEqual({
      id: `e_${Q}_${T}_clarify`,
      source: { nodeId: Q, portName: '__clarify__' },
      target: { nodeId: T, portName: 'questions' },
    })

    // 2. to_agent.to_questioner -> B.__clarify_response__  (answer returns to B)
    expect(edges[1]).toEqual({
      id: `e_${Q}_${T}_to_questioner`,
      source: { nodeId: T, portName: 'to_questioner' },
      target: { nodeId: Q, portName: '__clarify_response__' },
    })
  })

  test('edge ids are deterministic from node ids (stable across re-drags)', () => {
    const e1 = buildToAgentAutoEdges(Q, T)
    const e2 = buildToAgentAutoEdges(Q, T)
    expect(e1).toEqual(e2)
  })

  test('to_answerer is NOT in the auto pair (it is a manual edge - see buildToAgentAnswererEdge)', () => {
    const edges = buildToAgentAutoEdges(Q, T)
    expect(edges.some((e) => e.source.portName === 'to_answerer')).toBe(false)
    expect(edges.some((e) => e.target.portName === '__clarify_request__')).toBe(false)
  })
})

describe('RFC-W004 buildToAgentAnswererEdge - manual edge to answerer A', () => {
  test('returns a single edge to_agent.to_answerer -> A.__clarify_request__', () => {
    const edge = buildToAgentAnswererEdge(T, A)
    expect(edge).toEqual({
      id: `e_${T}_${A}_to_answerer`,
      source: { nodeId: T, portName: 'to_answerer' },
      target: { nodeId: A, portName: '__clarify_request__' },
    })
  })
})

describe('RFC-W004 findToAgentNodeForQuestioner', () => {
  const defn = (toAgentKind: string): WorkflowDefinition =>
    ({
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: Q, kind: 'agent-single', agentName: 'b', promptTemplate: '' },
        { id: T, kind: toAgentKind },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: Q, portName: '__clarify__' },
          target: { nodeId: T, portName: 'questions' },
        },
      ],
    }) as unknown as WorkflowDefinition

  test("returns the to-agent node id when B's __clarify__ feeds a clarify-to-agent node", () => {
    expect(findToAgentNodeForQuestioner(defn('clarify-to-agent'), Q)).toBe(T)
  })

  test('returns undefined when B feeds a clarify-cross-agent node (NOT to-agent)', () => {
    // The finder is kind-specific: a cross-clarify channel must not be
    // mistaken for a to-agent channel (the two have different runtimes).
    expect(findToAgentNodeForQuestioner(defn('clarify-cross-agent'), Q)).toBeUndefined()
  })

  test('returns undefined when B has no __clarify__ -> questions edge at all', () => {
    const empty: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: Q, kind: 'agent-single', agentName: 'b', promptTemplate: '' },
        { id: T, kind: 'clarify-to-agent' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    expect(findToAgentNodeForQuestioner(empty, Q)).toBeUndefined()
  })
})

describe('RFC-W004 resolveToAgentSessionMode', () => {
  const mk = (over: Partial<ClarifyToAgentNode> = {}): ClarifyToAgentNode =>
    ({ id: 'n', kind: 'clarify-to-agent', ...over }) as ClarifyToAgentNode

  test("defaults to 'isolated' when sessionModeForAnswerer is absent", () => {
    expect(resolveToAgentSessionMode(mk())).toBe('isolated')
    expect(resolveToAgentSessionMode(mk({ sessionModeForAnswerer: undefined }))).toBe('isolated')
  })

  test("honors an explicit 'inline' setting", () => {
    expect(resolveToAgentSessionMode(mk({ sessionModeForAnswerer: 'inline' }))).toBe('inline')
  })

  test("honors an explicit 'isolated' setting", () => {
    expect(resolveToAgentSessionMode(mk({ sessionModeForAnswerer: 'isolated' }))).toBe('isolated')
  })
})

describe('RFC-W004 isClarifyChannelEdge - to-agent edges recognized (registry-driven)', () => {
  // isClarifyChannelEdge is a thin alias over isSystemChannelEdge, which reads
  // the SYSTEM_CHANNEL_PORTS registry. RFC-W004 added to_answerer +
  // __clarify_request__ to that registry, so all three to-agent edge kinds are
  // now classified as channel edges (cycle-break / cascade-delete exemption).
  test('to-agent auto pair edges are channel edges', () => {
    const [askEdge, answerEdge] = buildToAgentAutoEdges(Q, T)
    expect(isClarifyChannelEdge(askEdge as never)).toBe(true)
    expect(isClarifyChannelEdge(answerEdge as never)).toBe(true)
  })

  test('to_answerer manual edge is a channel edge', () => {
    const edge = buildToAgentAnswererEdge(T, A)
    expect(isClarifyChannelEdge(edge as never)).toBe(true)
  })

  test('a plain data edge is NOT a channel edge', () => {
    expect(
      isClarifyChannelEdge({
        source: { nodeId: 'x', portName: 'out' },
        target: { nodeId: 'y', portName: 'in' },
      } as never),
    ).toBe(false)
  })
})
