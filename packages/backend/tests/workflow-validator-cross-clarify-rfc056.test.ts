// RFC-056 — clarify-cross-agent validator rules + topology cycle whitelist.
//
// LOCKS: 7 rules per RFC-056 proposal §2.1.15 (3 fail + 4 warning) + topology
// cycle exemption (cross-clarify feedback edges form intentional cycles).
// If any of these go red the editor / runtime will accept misconfigurations
// that crash submit / cascade — investigate before relaxing.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    readonly: false,
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
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

/** Build the auto-edges that reverse-drag would mint (questioner → cross
 *  via __clarify__, cross → questioner via __clarify_response__). */
function buildAutoEdges(questionerId: string, crossId: string): WorkflowEdge[] {
  const base = `e_${questionerId}_${crossId}`
  return [
    {
      id: `${base}_clarify`,
      source: { nodeId: questionerId, portName: '__clarify__' },
      target: { nodeId: crossId, portName: 'questions' },
    },
    {
      id: `${base}_to_questioner`,
      source: { nodeId: crossId, portName: 'to_questioner' },
      target: { nodeId: questionerId, portName: '__clarify_response__' },
    },
  ]
}

/** Build the manual to_designer edge into designer.__external_feedback__. */
function buildManualToDesigner(crossId: string, designerId: string): WorkflowEdge {
  return {
    id: `e_${crossId}_${designerId}_to_designer`,
    source: { nodeId: crossId, portName: 'to_designer' },
    target: { nodeId: designerId, portName: '__external_feedback__' },
  }
}

const designer = agent('designer', ['design'])
const questioner = agent('questioner', ['main'])

describe('RFC-056 cross-clarify validator rules', () => {
  test('happy path: designer → questioner → cross + manual to_designer = no errors, no cross-warnings', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        // designer → questioner (regular data flow into questioner input)
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        // questioner ↔ cross (auto-edges)
        ...buildAutoEdges('q1', 'cc1'),
        // cross → designer (manual)
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('cross-clarify-input-source-missing')
    expect(codes).not.toContain('cross-clarify-target-not-agent-single')
    expect(codes).not.toContain('cross-clarify-has-downstream')
    expect(codes).not.toContain('cross-clarify-manual-edge-missing')
    expect(codes).not.toContain('cross-clarify-target-not-ancestor')
    expect(codes).not.toContain('cross-clarify-auto-edge-deleted')
    expect(codes).not.toContain('cross-clarify-self-review-warning')
    expect(res.ok).toBe(true)
  })

  test('cross-clarify-input-source-missing (fail): no inbound on questions', () => {
    const def = makeDef({
      nodes: [{ id: 'cc1', kind: 'clarify-cross-agent' }],
      edges: [],
    })
    const res = validateWorkflowDef(def, { agents: [], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('cross-clarify-input-source-missing')
    expect(res.ok).toBe(false)
  })

  // RFC-060 PR-E: agent-multi removed; the prior "cross-clarify on agent-multi
  // questioner is rejected" case is now unreachable. The wrapper-git case
  // below still exercises the cross-clarify-target-not-agent-single rule.

  test('cross-clarify-target-not-agent-single (fail): inbound source is wrapper-git', () => {
    const def = makeDef({
      nodes: [
        { id: 'g1', kind: 'wrapper-git', nodeIds: ['x'] },
        { id: 'x', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_g1_cc1',
          source: { nodeId: 'g1', portName: 'git_diff' },
          target: { nodeId: 'cc1', portName: 'questions' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('cross-clarify-target-not-agent-single')
  })

  test('cross-clarify-has-downstream (fail): outgoing edge from non-legal port', () => {
    const def = makeDef({
      nodes: [
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
      ],
      edges: [
        ...buildAutoEdges('q1', 'cc1'),
        // illegal outgoing port name
        {
          id: 'e_cc1_phantom',
          source: { nodeId: 'cc1', portName: 'out_to_downstream' },
          target: { nodeId: 'd1', portName: '__external_feedback__' },
        },
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('cross-clarify-has-downstream')
  })

  test('cross-clarify-manual-edge-missing (warning): to_designer port unwired', () => {
    const def = makeDef({
      nodes: [
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: buildAutoEdges('q1', 'cc1'),
    })
    const res = validateWorkflowDef(def, { agents: [questioner], skills: [] })
    const warningIssue = res.issues.find((i) => i.code === 'cross-clarify-manual-edge-missing')
    expect(warningIssue).toBeDefined()
    expect(warningIssue?.severity).toBe('warning')
    // task can still launch (warnings only)
    expect(res.ok).toBe(true)
  })

  test('cross-clarify-target-not-ancestor (warning): to_designer points to a non-ancestor sibling', () => {
    // questioner has no upstream; manual edge points to a sibling node not in
    // questioner's reachable upstream → ancestor warning fires.
    const def = makeDef({
      nodes: [
        { id: 'sibling', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [...buildAutoEdges('q1', 'cc1'), buildManualToDesigner('cc1', 'sibling')],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const warningIssue = res.issues.find((i) => i.code === 'cross-clarify-target-not-ancestor')
    expect(warningIssue).toBeDefined()
    expect(warningIssue?.severity).toBe('warning')
  })

  test('cross-clarify-auto-edge-deleted (warning): to_questioner edge removed by user', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        // only the inbound questions edge — user manually deleted to_questioner
        {
          id: 'e_q1_cc1',
          source: { nodeId: 'q1', portName: '__clarify__' },
          target: { nodeId: 'cc1', portName: 'questions' },
        },
        // designer → questioner so ancestor warning doesn't also fire
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const warningIssue = res.issues.find((i) => i.code === 'cross-clarify-auto-edge-deleted')
    expect(warningIssue).toBeDefined()
    expect(warningIssue?.severity).toBe('warning')
  })

  test('cross-clarify-self-review-warning (warning): designer and questioner use the same agent.md', () => {
    const samesame = agent('reviewer', ['main'])
    const def = makeDef({
      nodes: [
        // both use 'reviewer.md' — anti-pattern
        { id: 'd1', kind: 'agent-single', agentName: 'reviewer' },
        { id: 'q1', kind: 'agent-single', agentName: 'reviewer' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'main' },
          target: { nodeId: 'q1', portName: 'main' },
        },
        ...buildAutoEdges('q1', 'cc1'),
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [samesame], skills: [] })
    const warningIssue = res.issues.find((i) => i.code === 'cross-clarify-self-review-warning')
    expect(warningIssue).toBeDefined()
    expect(warningIssue?.severity).toBe('warning')
    expect(res.ok).toBe(true)
  })

  // RFC-056 post-RFC patch — mirrors RFC-023 'clarify-no-iteration-cap'. The
  // inspector's wrapper-loop status chip ([[cross-clarify-no-iteration-cap]])
  // is backed by the same rule on both clarify kinds. If you tighten/loosen
  // this rule, also update the same-node clarify branch so the parity holds.
  test('cross-clarify-no-iteration-cap (warning): cross-clarify not inside a wrapper-loop', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        ...buildAutoEdges('q1', 'cc1'),
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const warningIssue = res.issues.find((i) => i.code === 'cross-clarify-no-iteration-cap')
    expect(warningIssue).toBeDefined()
    expect(warningIssue?.severity).toBe('warning')
    // warnings only — task can still launch.
    expect(res.ok).toBe(true)
  })

  test('cross-clarify-no-iteration-cap NOT emitted when cross-clarify is wrapped by a wrapper-loop', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
        {
          id: 'loop1',
          kind: 'wrapper-loop',
          nodeIds: ['cc1'],
          maxIterations: 3,
          exitCondition: { kind: 'port-empty' },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        ...buildAutoEdges('q1', 'cc1'),
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('cross-clarify-no-iteration-cap')
  })

  test('topology cycle exemption: feedback loop via cross-clarify does NOT trigger topology-cycle', () => {
    // The feedback edges (cross → designer + designer → ... → questioner → cross)
    // form a cycle. The validator must NOT flag it as a topology error since the
    // cycle is intentional and goes through a cross-clarify node.
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        ...buildAutoEdges('q1', 'cc1'),
        buildManualToDesigner('cc1', 'd1'), // closes the cycle to designer
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).not.toContain('topology-cycle')
  })
})
