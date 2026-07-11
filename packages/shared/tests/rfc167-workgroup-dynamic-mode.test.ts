// RFC-167 PR-1 — dynamic_workflow as the THIRD workgroup mode. Locks:
//  1. WORKGROUP_MODES lists the three modes; the schema accepts dynamic_workflow.
//  2. validateGroupShape rejects HUMAN members in dynamic_workflow mode (the
//     members are the agent-only orchestratable pool) — but an empty/agent-only
//     pool SAVES fine.
//  3. workgroupLaunchReadiness: dynamic needs ≥1 agent member (no-agent-member)
//     and NEVER requires a leader (leader-missing is leader_worker-only).
//  4. resolveWorkgroupSwitches leaves dynamic switches as stored (N/A, ignored).

import { describe, expect, test } from 'bun:test'
import {
  CreateWorkgroupSchema,
  WORKGROUP_MODES,
  resolveWorkgroupSwitches,
  workgroupLaunchReadiness,
} from '../src'

describe('WORKGROUP_MODES — RFC-167 third mode', () => {
  test('lists leader_worker / free_collab / dynamic_workflow', () => {
    expect(WORKGROUP_MODES).toEqual(['leader_worker', 'free_collab', 'dynamic_workflow'])
  })

  test('CreateWorkgroupSchema accepts dynamic_workflow with agent members', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'dynamic_workflow',
      members: [{ memberType: 'agent', agentName: 'coder', displayName: 'coder' }],
    })
    expect(parsed.success).toBe(true)
  })

  test('empty pool saves fine (quick create)', () => {
    expect(
      CreateWorkgroupSchema.safeParse({ name: 'empty', mode: 'dynamic_workflow', members: [] })
        .success,
    ).toBe(true)
  })
})

describe('validateGroupShape — dynamic_workflow rejects human members', () => {
  test('a human member in dynamic mode fails to parse', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'dynamic_workflow',
      members: [
        { memberType: 'agent', agentName: 'coder', displayName: 'coder' },
        { memberType: 'human', userId: 'u1', displayName: 'pm' },
      ],
    })
    expect(parsed.success).toBe(false)
  })

  test('the SAME human member is fine in leader_worker mode', () => {
    const parsed = CreateWorkgroupSchema.safeParse({
      name: 'squad',
      mode: 'leader_worker',
      members: [
        { memberType: 'agent', agentName: 'coder', displayName: 'coder' },
        { memberType: 'human', userId: 'u1', displayName: 'pm' },
      ],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('workgroupLaunchReadiness — dynamic_workflow', () => {
  test('agent members present → ready (no leader needed)', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [{ id: 'm1', memberType: 'agent' }],
    })
    expect(r.ready).toBe(true)
    expect(r.reasons).toEqual([])
  })

  test('empty pool → no-agent-member', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [],
    })
    expect(r.ready).toBe(false)
    expect(r.reasons).toEqual(['no-agent-member'])
  })

  test('dynamic never reports leader-missing', () => {
    const r = workgroupLaunchReadiness({
      mode: 'dynamic_workflow',
      leaderMemberId: null,
      members: [{ id: 'm1', memberType: 'agent' }],
    })
    expect(r.reasons).not.toContain('leader-missing')
  })
})

describe('resolveWorkgroupSwitches — dynamic leaves stored switches (N/A)', () => {
  test('dynamic mode returns stored switches unchanged (ignored by the engine)', () => {
    const stored = { shareOutputs: false, directMessages: false, blackboard: false }
    expect(resolveWorkgroupSwitches('dynamic_workflow', stored)).toEqual(stored)
  })
})
