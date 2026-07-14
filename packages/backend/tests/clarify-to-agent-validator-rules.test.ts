// RFC-W004 T6 - clarify-to-agent validator rules + topology cycle whitelist.
//
// LOCKS (design/RFC-W004-clarify-to-agent/design.md §5 + §3.4):
//   7 per-node §4e rules (3 fail + 4 warning) +
//   2 multiplicity rules (multiple-questioners fail, multiple-answerers fail) +
//   1 multi-source ALLOWANCE lock (multiple to-agent -> same A is multi-source
//     aggregation per §3.4 / proposal S7 - NOT an error; this OVERRIDES proposal
//     A9 "A targeted by >=2 to-agent -> fail" per CLAUDE.md design.md-wins) +
//   2 system-port integrity extensions (to_answerer / __clarify_request__) +
//   1 topology-cycle exemption (to-agent feedback cycle must NOT trip cycle).
//
// If any of these go red the editor will accept misconfigurations that crash
// the to-agent runtime - investigate before relaxing.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes: [], edges: [], ...parts }
}

/** Build the auto-edges that reverse-drag mints (B.__clarify__ -> ta.questions,
 *  ta.to_questioner -> B.__clarify_response__). The manual to_answerer edge is
 *  built separately - it is NOT auto-minted. */
function buildAutoEdges(questionerId: string, toAgentId: string): WorkflowEdge[] {
  const base = `e_${questionerId}_${toAgentId}`
  return [
    {
      id: `${base}_clarify`,
      source: { nodeId: questionerId, portName: '__clarify__' },
      target: { nodeId: toAgentId, portName: 'questions' },
    },
    {
      id: `${base}_to_questioner`,
      source: { nodeId: toAgentId, portName: 'to_questioner' },
      target: { nodeId: questionerId, portName: '__clarify_response__' },
    },
  ]
}

/** Build the MANUAL to_answerer edge into A.__clarify_request__. */
function buildManualToAnswerer(toAgentId: string, answererId: string): WorkflowEdge {
  return {
    id: `e_${toAgentId}_${answererId}_to_answerer`,
    source: { nodeId: toAgentId, portName: 'to_answerer' },
    target: { nodeId: answererId, portName: '__clarify_request__' },
  }
}

const answerer = agent('answerer', ['result'])
const questioner = agent('questioner', ['main'])

/** Happy-path wiring: A.result -> B.main (A upstream of B) + B reverse-asks A
 *  via to-agent (auto-edges + manual to_answerer). Standalone (not in a loop) so
 *  clarify-to-agent-no-iteration-cap WILL fire (a warning, non-blocking). */
function happyWiring() {
  return makeDef({
    nodes: [
      { id: 'A', kind: 'agent-single', agentName: 'answerer' },
      { id: 'B', kind: 'agent-single', agentName: 'questioner' },
      { id: 'ta1', kind: 'clarify-to-agent' },
    ],
    edges: [
      {
        id: 'e_A_B',
        source: { nodeId: 'A', portName: 'result' },
        target: { nodeId: 'B', portName: 'main' },
      },
      ...buildAutoEdges('B', 'ta1'),
      buildManualToAnswerer('ta1', 'A'),
    ],
  })
}

describe('RFC-W004 T6 - clarify-to-agent validator rules', () => {
  test('happy path: A->B + B reverse-asks A via to-agent = no fail / no avoidable warning', () => {
    const res = validateWorkflowDef(happyWiring(), { agents: [answerer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('clarify-to-agent-input-source-missing')
    expect(codes).not.toContain('clarify-to-agent-target-not-agent-single')
    expect(codes).not.toContain('clarify-to-agent-has-downstream')
    expect(codes).not.toContain('clarify-to-agent-answerer-edge-missing')
    expect(codes).not.toContain('clarify-to-agent-answerer-not-ancestor')
    expect(codes).not.toContain('clarify-to-agent-answerer-self')
    expect(codes).not.toContain('clarify-to-agent-multiple-questioners')
    expect(codes).not.toContain('clarify-to-agent-multiple-answerers')
    // Standalone node -> the iteration-cap warning is expected (non-blocking).
    expect(codes).toContain('clarify-to-agent-no-iteration-cap')
    expect(res.ok).toBe(true)
  })

  test('clarify-to-agent-input-source-missing (fail): no inbound on questions', () => {
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_A_B',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        // NO B.__clarify__ -> ta1.questions edge
        {
          id: 'e_ta1_toQ',
          source: { nodeId: 'ta1', portName: 'to_questioner' },
          target: { nodeId: 'B', portName: '__clarify_response__' },
        },
        buildManualToAnswerer('ta1', 'A'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-input-source-missing')
    expect(res.ok).toBe(false)
  })

  test('clarify-to-agent-target-not-agent-single (fail): questions source is non-agent', () => {
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
        { id: 'in1', kind: 'input', inputKey: 'spec' },
      ],
      edges: [
        {
          id: 'e_A_B',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        // input node -> ta1.questions (source not agent-single)
        {
          id: 'e_in1_ta1',
          source: { nodeId: 'in1', portName: 'spec' },
          target: { nodeId: 'ta1', portName: 'questions' },
        },
        {
          id: 'e_ta1_toQ',
          source: { nodeId: 'ta1', portName: 'to_questioner' },
          target: { nodeId: 'B', portName: '__clarify_response__' },
        },
        buildManualToAnswerer('ta1', 'A'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-target-not-agent-single')
    expect(res.ok).toBe(false)
  })

  test('clarify-to-agent-has-downstream (fail): outgoing edge from a non-system port', () => {
    const def = happyWiring()
    def.edges.push({
      id: 'e_ta1_stray',
      source: { nodeId: 'ta1', portName: 'questions' },
      target: { nodeId: 'A', portName: 'main' },
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-has-downstream')
    expect(res.ok).toBe(false)
  })

  test('clarify-to-agent-answerer-edge-missing (warning): no to_answerer edge', () => {
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_A_B',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        ...buildAutoEdges('B', 'ta1'),
        // NO to_answerer -> A.__clarify_request__ edge
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-answerer-edge-missing')
    expect(res.ok).toBe(true) // warning, non-blocking
  })

  test('clarify-to-agent-answerer-not-ancestor (warning): A not upstream of B', () => {
    // B -> A data flow (A is DOWNSTREAM of B), so A is NOT an ancestor of B.
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_B_A',
          source: { nodeId: 'B', portName: 'main' },
          target: { nodeId: 'A', portName: 'result' },
        },
        ...buildAutoEdges('B', 'ta1'),
        buildManualToAnswerer('ta1', 'A'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-answerer-not-ancestor')
  })

  test('clarify-to-agent-answerer-self (warning): A === B same agent definition', () => {
    const def = makeDef({
      nodes: [
        { id: 'X', kind: 'agent-single', agentName: 'answerer' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        // X reverse-asks itself: X.__clarify__ -> ta1, ta1.to_answerer -> X.__clarify_request__
        ...buildAutoEdges('X', 'ta1'),
        buildManualToAnswerer('ta1', 'X'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-answerer-self')
  })

  test('clarify-to-agent-multiple-questioners (fail): 2 B sources on questions', () => {
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'B2', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_A_B1',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B1', portName: 'main' },
        },
        {
          id: 'e_A_B2',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B2', portName: 'main' },
        },
        // B1.__clarify__ -> ta1.questions
        {
          id: 'e_B1_ta1',
          source: { nodeId: 'B1', portName: '__clarify__' },
          target: { nodeId: 'ta1', portName: 'questions' },
        },
        // B2.__clarify__ -> ta1.questions (2nd source)
        {
          id: 'e_B2_ta1',
          source: { nodeId: 'B2', portName: '__clarify__' },
          target: { nodeId: 'ta1', portName: 'questions' },
        },
        {
          id: 'e_ta1_toQ',
          source: { nodeId: 'ta1', portName: 'to_questioner' },
          target: { nodeId: 'B1', portName: '__clarify_response__' },
        },
        buildManualToAnswerer('ta1', 'A'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-multiple-questioners')
    expect(res.ok).toBe(false)
  })

  test('clarify-to-agent-multiple-answerers (fail): 1 to_answerer -> 2 different A', () => {
    const def = makeDef({
      nodes: [
        { id: 'A1', kind: 'agent-single', agentName: 'answerer' },
        { id: 'A2', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_A1_B',
          source: { nodeId: 'A1', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        {
          id: 'e_A2_B',
          source: { nodeId: 'A2', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        ...buildAutoEdges('B', 'ta1'),
        // ta1.to_answerer -> A1 AND -> A2 (2 answerers on one to-agent)
        buildManualToAnswerer('ta1', 'A1'),
        buildManualToAnswerer('ta1', 'A2'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('clarify-to-agent-multiple-answerers')
    expect(res.ok).toBe(false)
  })

  test('MULTI-SOURCE ALLOWED (design §3.4 / S7): 2 to-agent nodes -> same A = NO multiple-on-answerer error', () => {
    // B1 + B2 each reverse-ask the SAME answerer A via their OWN to-agent nodes.
    // This is multi-source aggregation (A reruns once with both questions) and
    // must NOT be flagged. Proposal A9 ("A targeted by >=2 to-agent -> fail") is
    // overridden by design §3.4 + §5 multiplicity correction (design.md wins).
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'B2', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
        { id: 'ta2', kind: 'clarify-to-agent' },
      ],
      edges: [
        {
          id: 'e_A_B1',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B1', portName: 'main' },
        },
        {
          id: 'e_A_B2',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B2', portName: 'main' },
        },
        ...buildAutoEdges('B1', 'ta1'),
        ...buildAutoEdges('B2', 'ta2'),
        // BOTH to-agent nodes point to_answerer -> A.__clarify_request__ (same A).
        buildManualToAnswerer('ta1', 'A'),
        buildManualToAnswerer('ta2', 'A'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    // No multiplicity error fires: each to-agent's own to_answerer set is size 1.
    expect(codes).not.toContain('clarify-to-agent-multiple-answerers')
    expect(codes).not.toContain('clarify-to-agent-multiple-questioners')
    // The retired A9 rule must NOT exist (no such code anywhere in issues).
    expect(codes).not.toContain('clarify-to-agent-multiple-on-answerer')
    // No system-port error: A's __clarify_request__ accepts multiple to_answerer
    // sources (each is a canonical to-agent to_answerer edge).
    expect(codes).not.toContain('system-port-illegal-source')
    expect(codes).not.toContain('system-port-illegal-target')
    expect(res.ok).toBe(true)
  })

  test('system-port-illegal-target: to_answerer -> non-__clarify_request__ target', () => {
    const def = happyWiring()
    // Replace the canonical to_answerer->A.__clarify_request__ with a stray
    // to_answerer->A.main (wrong target port).
    def.edges = def.edges.filter((e) => e.id !== 'e_ta1_A_to_answerer')
    def.edges.push({
      id: 'e_ta1_stray_to_answerer',
      source: { nodeId: 'ta1', portName: 'to_answerer' },
      target: { nodeId: 'A', portName: 'main' },
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('system-port-illegal-target')
  })

  test('system-port-illegal-source: __clarify_request__ fed by non-to_answerer source', () => {
    const def = happyWiring()
    def.edges = def.edges.filter((e) => e.id !== 'e_ta1_A_to_answerer')
    // A plain data edge onto __clarify_request__ (wrong source port).
    def.edges.push({
      id: 'e_B_A_request_stray',
      source: { nodeId: 'B', portName: 'main' },
      target: { nodeId: 'A', portName: '__clarify_request__' },
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('system-port-illegal-source')
  })

  test('system-port-illegal-target: __clarify_request__ on a non-agent node', () => {
    // to_answerer -> review.__clarify_request__ : __clarify_request__ is an agent
    // system port; wiring it onto a non-agent (clarify-cross-agent) node must
    // fail system-port-illegal-target (rule (a) extension for __clarify_request__).
    const def = makeDef({
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'answerer' },
        { id: 'B', kind: 'agent-single', agentName: 'questioner' },
        { id: 'ta1', kind: 'clarify-to-agent' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_A_B',
          source: { nodeId: 'A', portName: 'result' },
          target: { nodeId: 'B', portName: 'main' },
        },
        ...buildAutoEdges('B', 'ta1'),
        // to_answerer onto a non-agent node's __clarify_request__ (illegal target).
        {
          id: 'e_ta1_cc1_request',
          source: { nodeId: 'ta1', portName: 'to_answerer' },
          target: { nodeId: 'cc1', portName: '__clarify_request__' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).toContain('system-port-illegal-target')
  })

  test('topology-cycle EXEMPTION: B->to-agent->B feedback cycle is NOT a topology-cycle', () => {
    // The to-agent feedback loop (B.__clarify__ -> ta, ta.to_questioner ->
    // B.__clarify_response__, ta.to_answerer -> A.__clarify_request__) forms an
    // intentional cycle by design - it must NOT trip topology-cycle.
    const res = validateWorkflowDef(happyWiring(), { agents: [answerer, questioner], skills: [] })
    expect(res.issues.map((i) => i.code)).not.toContain('topology-cycle')
  })
})
