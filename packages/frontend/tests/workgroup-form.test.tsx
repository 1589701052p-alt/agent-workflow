// RFC-164 PR-1 — workgroup form validation matrix + editor behavior.
//
// Locks:
//   1. buildCreate/UpdateWorkgroupPayload validation matrix — lw-without-
//      leader, duplicate displayName, human row without user, displayName
//      token rules (@ / whitespace / comma), maxRounds bounds, dangling
//      agent names being LEGAL (launch-time validation owns existence).
//   2. free_collab renders the three collaboration switches disabled+on
//      WITHOUT mutating stored values (flipping back to leader_worker
//      restores them) — mirrors shared resolveWorkgroupSwitches semantics.
//   3. Member editor: add/remove rows, leader radio only on agent rows in
//      leader_worker mode, human user pick prefills the alias.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Workgroup } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { WorkgroupForm } from '../src/components/workgroup/WorkgroupForm'
import {
  buildCreateWorkgroupPayload,
  buildUpdateWorkgroupPayload,
  deriveMemberAlias,
  emptyAgentRow,
  emptyHumanRow,
  newWorkgroupForm,
  workgroupLeaderDisplayName,
  workgroupToForm,
  type WorkgroupFormState,
} from '../src/lib/workgroup-form'
import '../src/i18n'

// ---------------------------------------------------------------------------
// Pure validation matrix
// ---------------------------------------------------------------------------

function validLwForm(): WorkgroupFormState {
  const form = newWorkgroupForm()
  const row = form.members[0]!
  row.agentName = 'coder'
  row.displayName = 'Coder'
  form.name = 'review-squad'
  form.leaderKey = row.key
  return form
}

describe('workgroup payload builders — validation matrix', () => {
  test('a valid leader_worker form builds a create payload', () => {
    const built = buildCreateWorkgroupPayload(validLwForm())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.name).toBe('review-squad')
    expect(built.payload.mode).toBe('leader_worker')
    expect(built.payload.leaderDisplayName).toBe('Coder')
    expect(built.payload.members).toEqual([
      { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: '' },
    ])
    expect(built.payload.maxRounds).toBe(20)
  })

  test('leader_worker without a leader is rejected', () => {
    const form = validLwForm()
    form.leaderKey = null
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors.leader).toBe('workgroups.errors.leaderRequired')
  })

  test('a leader key pointing at a human row is rejected', () => {
    const form = validLwForm()
    const human = emptyHumanRow()
    human.userId = 'u1'
    human.displayName = 'Alice'
    form.members.push(human)
    form.leaderKey = human.key
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors.leader).toBe('workgroups.errors.leaderMustBeAgent')
  })

  test('duplicate displayNames flag BOTH rows', () => {
    const form = validLwForm()
    const dup = emptyAgentRow()
    dup.agentName = 'auditor'
    dup.displayName = 'Coder'
    form.members.push(dup)
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors['member-0-displayName']).toBe('workgroups.errors.displayNameDuplicate')
    expect(built.errors['member-1-displayName']).toBe('workgroups.errors.displayNameDuplicate')
  })

  test('a human row without a picked user is rejected', () => {
    const form = validLwForm()
    const human = emptyHumanRow()
    human.displayName = 'Alice'
    form.members.push(human)
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors['member-1-userId']).toBe('workgroups.errors.userRequired')
  })

  test.each([
    ['with @', 'Co@der'],
    ['with whitespace', 'Co der'],
    ['with comma', 'Co,der'],
  ])('displayName %s is rejected', (_label, displayName) => {
    const form = validLwForm()
    form.members[0]!.displayName = displayName
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors['member-0-displayName']).toBe('workgroups.errors.displayNameInvalid')
  })

  test('empty / whitespace-only displayName is rejected as required', () => {
    const form = validLwForm()
    form.members[0]!.displayName = '   '
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors['member-0-displayName']).toBe('workgroups.errors.displayNameRequired')
  })

  test('an agent row with an empty agentName is rejected — but a DANGLING name is legal', () => {
    const form = validLwForm()
    form.members[0]!.agentName = ''
    const invalid = buildCreateWorkgroupPayload(form)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.errors['member-0-agentName']).toBe('workgroups.errors.agentNameRequired')
    }
    // Dangling reference: any non-empty token passes (existence is
    // launch-validated, same contract as workflow agentName).
    form.members[0]!.agentName = 'does-not-exist-yet'
    expect(buildCreateWorkgroupPayload(form).ok).toBe(true)
  })

  test('zero members is rejected', () => {
    const form = validLwForm()
    form.members = []
    form.leaderKey = null
    form.mode = 'free_collab'
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors.members).toBe('workgroups.errors.membersRequired')
  })

  test('create requires a valid resource name; update never checks it', () => {
    const form = validLwForm()
    form.name = ''
    const create = buildCreateWorkgroupPayload(form)
    expect(create.ok).toBe(false)
    if (!create.ok) expect(create.errors.name).toBe('workgroups.errors.nameRequired')
    form.name = 'Bad Name!'
    const invalid = buildCreateWorkgroupPayload(form)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.errors.name).toBe('workgroups.errors.nameInvalid')
    // Update ignores the (locked) name field entirely and carries no name key.
    const update = buildUpdateWorkgroupPayload(form)
    expect(update.ok).toBe(true)
    if (update.ok) expect('name' in update.payload).toBe(false)
  })

  test.each([[0], [501], [2.5]])('maxRounds=%p is rejected', (maxRounds) => {
    const form = validLwForm()
    form.maxRounds = maxRounds
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.errors.maxRounds).toBe('workgroups.errors.maxRoundsInvalid')
  })

  test('cleared maxRounds falls back to the default 20', () => {
    const form = validLwForm()
    form.maxRounds = undefined
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.maxRounds).toBe(20)
  })

  test('free_collab needs no leader and omits leaderDisplayName', () => {
    const form = validLwForm()
    form.mode = 'free_collab'
    form.leaderKey = null
    const built = buildCreateWorkgroupPayload(form)
    expect(built.ok).toBe(true)
    if (built.ok) expect(built.payload.leaderDisplayName).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Row seeding / helpers
// ---------------------------------------------------------------------------

const STORED: Workgroup = {
  id: 'wg_1',
  name: 'review-squad',
  description: 'audits PRs',
  instructions: 'be nice',
  mode: 'leader_worker',
  leaderMemberId: 'mem_1',
  switches: { shareOutputs: true, directMessages: true, blackboard: false },
  maxRounds: 33,
  completionGate: true,
  members: [
    {
      id: 'mem_2',
      memberType: 'human',
      agentName: null,
      userId: 'u1',
      displayName: 'Alice',
      roleDesc: 'reviews',
      sortOrder: 1,
    },
    {
      id: 'mem_1',
      memberType: 'agent',
      agentName: 'coder',
      userId: null,
      displayName: 'Coder',
      roleDesc: 'writes code',
      sortOrder: 0,
    },
  ],
  ownerUserId: 'u1',
  visibility: 'public',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 2,
}

describe('workgroupToForm / helpers', () => {
  test('stored row → form → update payload round-trips (members sorted by sortOrder)', () => {
    const form = workgroupToForm(STORED)
    expect(form.members.map((m) => m.displayName)).toEqual(['Coder', 'Alice'])
    expect(form.leaderKey).toBe('mem_1')
    const built = buildUpdateWorkgroupPayload(form)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.payload.leaderDisplayName).toBe('Coder')
    expect(built.payload.maxRounds).toBe(33)
    expect(built.payload.members).toEqual([
      { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
      { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
    ])
  })

  test('workgroupLeaderDisplayName resolves the leader; free_collab reads null', () => {
    expect(workgroupLeaderDisplayName(STORED)).toBe('Coder')
    expect(workgroupLeaderDisplayName({ ...STORED, mode: 'free_collab' })).toBeNull()
    expect(workgroupLeaderDisplayName({ ...STORED, leaderMemberId: null })).toBeNull()
  })

  test('deriveMemberAlias strips mention-breaking chars, falls back to username', () => {
    expect(deriveMemberAlias({ displayName: 'Alice Wang', username: 'alice' })).toBe('AliceWang')
    expect(deriveMemberAlias({ displayName: '@,  ', username: 'alice' })).toBe('alice')
  })
})

// ---------------------------------------------------------------------------
// Component behavior (WorkgroupForm + member editor)
// ---------------------------------------------------------------------------

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/agents')) return json([{ name: 'coder' }, { name: 'auditor' }])
    if (url.includes('/api/users/search')) {
      return json([
        { id: 'u1', username: 'alice', displayName: 'Alice Wang', role: 'user', status: 'active' },
        { id: 'u2', username: 'bob', displayName: 'Bob', role: 'user', status: 'active' },
      ])
    }
    return json([])
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/** Stateful harness mirroring the pages' live-validation wiring. */
function Harness({ initial }: { initial?: WorkgroupFormState }) {
  const [form, setForm] = useState<WorkgroupFormState>(initial ?? newWorkgroupForm())
  const built = buildCreateWorkgroupPayload(form)
  return <WorkgroupForm value={form} onChange={setForm} errors={built.ok ? {} : built.errors} />
}

function mountForm(initial?: WorkgroupFormState) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  )
}

function switchInput(label: RegExp): HTMLInputElement {
  return screen.getByRole('checkbox', { name: label }) as HTMLInputElement
}

describe('WorkgroupForm — free_collab switch gating', () => {
  test('fc disables the three switches, shows them on, and restores on switch-back', () => {
    mountForm()
    // leader_worker defaults: shareOutputs on, the other two off + editable.
    expect(switchInput(/Share outputs/).checked).toBe(true)
    expect(switchInput(/Direct messages/).checked).toBe(false)
    expect(switchInput(/Direct messages/).disabled).toBe(false)

    // Flip blackboard on so switch-back has a non-default value to restore.
    fireEvent.click(switchInput(/Public blackboard/))
    expect(switchInput(/Public blackboard/).checked).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Free collaboration' }))
    for (const label of [/Share outputs/, /Direct messages/, /Public blackboard/]) {
      expect(switchInput(label).checked).toBe(true)
      expect(switchInput(label).disabled).toBe(true)
    }
    expect(screen.getByTestId('workgroup-fc-switches-notice')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: 'Leader-Worker' }))
    expect(switchInput(/Share outputs/).checked).toBe(true)
    expect(switchInput(/Direct messages/).checked).toBe(false)
    expect(switchInput(/Public blackboard/).checked).toBe(true)
    expect(switchInput(/Direct messages/).disabled).toBe(false)
    expect(screen.queryByTestId('workgroup-fc-switches-notice')).toBeNull()
  })

  test('completion gate switch stays editable in fc mode', () => {
    const form = newWorkgroupForm()
    form.mode = 'free_collab'
    form.leaderKey = null
    mountForm(form)
    const gate = switchInput(/Completion gate/)
    expect(gate.disabled).toBe(false)
    fireEvent.click(gate)
    expect(switchInput(/Completion gate/).checked).toBe(true)
  })
})

describe('WorkgroupForm — member editor', () => {
  test('add / remove rows through the two footer buttons', () => {
    mountForm()
    expect(screen.getByTestId('workgroup-member-0')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-member-1')).toBeNull()

    fireEvent.click(screen.getByTestId('workgroup-add-human-member'))
    expect(screen.getByTestId('workgroup-member-1')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workgroup-add-agent-member'))
    expect(screen.getByTestId('workgroup-member-2')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workgroup-member-remove-1'))
    expect(screen.queryByTestId('workgroup-member-2')).toBeNull()
    // The former row 2 (an agent row) slid into index 1.
    expect(screen.getByTestId('workgroup-member-agent-1')).toBeTruthy()
  })

  test('leader radio renders only on agent rows and only in leader_worker mode', () => {
    mountForm()
    fireEvent.click(screen.getByTestId('workgroup-add-human-member'))
    expect(screen.getByTestId('workgroup-member-leader-0')).toBeTruthy()
    expect(screen.queryByTestId('workgroup-member-leader-1')).toBeNull()

    fireEvent.click(screen.getByTestId('workgroup-member-leader-0'))
    expect((screen.getByTestId('workgroup-member-leader-0') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Free collaboration' }))
    expect(screen.queryByTestId('workgroup-member-leader-0')).toBeNull()
  })

  test('picking a platform user prefills the alias (whitespace stripped, editable)', async () => {
    mountForm()
    fireEvent.click(screen.getByTestId('workgroup-add-human-member'))
    // Wait for the users query to hydrate the Select's options.
    fireEvent.click(screen.getByTestId('workgroup-member-user-1'))
    const option = await screen.findByRole('option', { name: /Alice Wang/ })
    fireEvent.mouseDown(option)
    expect((screen.getByTestId('workgroup-member-displayname-1') as HTMLInputElement).value).toBe(
      'AliceWang',
    )
  })

  test('duplicate displayNames surface a per-row inline error', async () => {
    mountForm()
    fireEvent.change(screen.getByTestId('workgroup-member-agent-0'), {
      target: { value: 'coder' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-0'), {
      target: { value: 'Coder' },
    })
    fireEvent.click(screen.getByTestId('workgroup-add-agent-member'))
    fireEvent.change(screen.getByTestId('workgroup-member-agent-1'), {
      target: { value: 'auditor' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-1'), {
      target: { value: 'Coder' },
    })
    await waitFor(() => {
      expect(
        screen.getAllByText('Display names must be unique within the group.').length,
      ).toBeGreaterThanOrEqual(2)
    })
  })

  test('type flip away from agent clears the leader flag', () => {
    mountForm()
    fireEvent.click(screen.getByTestId('workgroup-member-leader-0'))
    expect((screen.getByTestId('workgroup-member-leader-0') as HTMLInputElement).checked).toBe(true)
    // Flip row 0 to human via the type <Select>.
    fireEvent.click(screen.getByTestId('workgroup-member-type-0'))
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Human' }))
    // Radio is gone (human rows can't lead) and the leader error resurfaces.
    expect(screen.queryByTestId('workgroup-member-leader-0')).toBeNull()
    expect(screen.getByText('Leader-Worker mode requires one agent member as leader.')).toBeTruthy()
  })
})
