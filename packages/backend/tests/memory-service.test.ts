// RFC-041 — memory service unit tests (PR1 scope).
//
// Covers: createManualCandidate / listMemories / getMemoryById /
// promoteCandidate (3 action branches + scope-mismatch + missing-target +
// non-candidate guard) / archiveMemory / unarchiveMemory / deleteMemory /
// WS publication shape.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  archiveMemory,
  createManualCandidate,
  deleteMemory,
  getMemoryById,
  listMemories,
  promoteCandidate,
  unarchiveMemory,
} from '../src/services/memory'
import { MEMORY_CHANNEL, memoryBroadcaster, resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { MemoryWsMessage } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function captureBroadcasts(): { msgs: MemoryWsMessage[]; stop: () => void } {
  const msgs: MemoryWsMessage[] = []
  const stop = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (m) => {
    msgs.push(m)
  })
  return { msgs, stop }
}

describe('memory service — PR1 CRUD + supersede chain', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('createManualCandidate persists candidate + emits ws', async () => {
    const cap = captureBroadcasts()
    const m = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: '  trim me  ',
      bodyMd: 'body',
    })
    cap.stop()
    expect(m.status).toBe('candidate')
    expect(m.scopeType).toBe('global')
    expect(m.scopeId).toBeNull()
    expect(m.title).toBe('trim me') // schema trims
    expect(m.sourceKind).toBe('manual')
    expect(cap.msgs).toHaveLength(1)
    expect(cap.msgs[0]!.type).toBe('memory.candidate.created')
  })

  test('createManualCandidate: non-global without scopeId rejected by zod', async () => {
    await expect(
      createManualCandidate(db, {
        scopeType: 'agent',
        scopeId: null as unknown as string,
        title: 't',
        bodyMd: 'b',
      }),
    ).rejects.toThrow()
  })

  test('listMemories filters by status and scope', async () => {
    await createManualCandidate(db, { scopeType: 'agent', scopeId: 'a1', title: 'A1', bodyMd: 'b' })
    await createManualCandidate(db, { scopeType: 'agent', scopeId: 'a2', title: 'A2', bodyMd: 'b' })
    await createManualCandidate(db, { scopeType: 'global', scopeId: null, title: 'G', bodyMd: 'b' })
    const all = await listMemories(db, {})
    expect(all.length).toBe(3)
    const onlyA1 = await listMemories(db, { scopeType: 'agent', scopeId: 'a1' })
    expect(onlyA1.length).toBe(1)
    expect(onlyA1[0]!.title).toBe('A1')
    const onlyGlobal = await listMemories(db, { scopeType: 'global' })
    expect(onlyGlobal.length).toBe(1)
  })

  test('listMemories filters by search (title or body)', async () => {
    await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'unique-needle',
      bodyMd: 'b',
    })
    await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'other',
      bodyMd: 'body has needle inside',
    })
    await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'unrelated',
      bodyMd: 'body-x',
    })
    const r = await listMemories(db, { search: 'needle' })
    expect(r.length).toBe(2)
  })

  test('listMemories filters by tag (client-side filter)', async () => {
    const a = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'a',
      bodyMd: 'b',
      tags: ['react'],
    })
    await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 'b',
      bodyMd: 'b',
      tags: ['vue'],
    })
    const r = await listMemories(db, { tag: 'react' })
    expect(r.length).toBe(1)
    expect(r[0]!.id).toBe(a.id)
  })

  test('promoteCandidate(approve) marks approved + records admin user + emits ws', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    const cap = captureBroadcasts()
    const promoted = await promoteCandidate(db, cand.id, { action: 'approve' }, 'u_admin')
    cap.stop()
    expect(promoted.status).toBe('approved')
    expect(promoted.approvedByUserId).toBe('u_admin')
    expect(promoted.approvedAt).not.toBeNull()
    expect(promoted.version).toBe(1)
    expect(promoted.supersedesId).toBeNull()
    expect(cap.msgs.some((m) => m.type === 'memory.candidate.promoted')).toBe(true)
  })

  test('promoteCandidate(approve_and_supersede) creates supersede chain', async () => {
    const old = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a1',
      title: 'old',
      bodyMd: 'b',
    })
    await promoteCandidate(db, old.id, { action: 'approve' }, 'u_admin')
    const newer = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a1',
      title: 'new',
      bodyMd: 'b',
    })
    const cap = captureBroadcasts()
    const promoted = await promoteCandidate(
      db,
      newer.id,
      { action: 'approve_and_supersede', supersedeIds: [old.id] },
      'u_admin',
    )
    cap.stop()
    expect(promoted.supersedesId).toBe(old.id)
    expect(promoted.version).toBe(2)
    // The old row should now be 'superseded'
    const oldRefetched = await getMemoryById(db, old.id)
    expect(oldRefetched?.memory.status).toBe('superseded')
    expect(oldRefetched?.memory.supersededById).toBe(promoted.id)
    expect(cap.msgs.some((m) => m.type === 'memory.superseded')).toBe(true)
  })

  test('promoteCandidate(approve_and_supersede) rejects scope mismatch', async () => {
    const target = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a1',
      title: 't',
      bodyMd: 'b',
    })
    await promoteCandidate(db, target.id, { action: 'approve' }, 'u_admin')
    const cross = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a2', // different scope_id
      title: 't2',
      bodyMd: 'b',
    })
    await expect(
      promoteCandidate(
        db,
        cross.id,
        { action: 'approve_and_supersede', supersedeIds: [target.id] },
        'u_admin',
      ),
    ).rejects.toThrow(/scope mismatch/)
  })

  test('promoteCandidate(approve_and_supersede) rejects non-approved target', async () => {
    const targetCand = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a1',
      title: 't',
      bodyMd: 'b',
    })
    // target still 'candidate' — must not be supersedable
    const newer = await createManualCandidate(db, {
      scopeType: 'agent',
      scopeId: 'a1',
      title: 't2',
      bodyMd: 'b',
    })
    await expect(
      promoteCandidate(
        db,
        newer.id,
        { action: 'approve_and_supersede', supersedeIds: [targetCand.id] },
        'u_admin',
      ),
    ).rejects.toThrow(/not 'approved'/)
  })

  test('promoteCandidate(approve_and_supersede) rejects missing target id', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    await expect(
      promoteCandidate(
        db,
        cand.id,
        { action: 'approve_and_supersede', supersedeIds: ['m_does_not_exist'] },
        'u_admin',
      ),
    ).rejects.toThrow(/supersede target\(s\) not found/)
  })

  test('promoteCandidate(reject) marks rejected without setting approvedAt', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    const r = await promoteCandidate(db, cand.id, { action: 'reject' }, 'u_admin')
    expect(r.status).toBe('rejected')
    expect(r.approvedByUserId).toBeNull()
    expect(r.approvedAt).toBeNull()
  })

  test('promoteCandidate rejects already-promoted candidate', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    await promoteCandidate(db, cand.id, { action: 'approve' }, 'u_admin')
    await expect(promoteCandidate(db, cand.id, { action: 'approve' }, 'u_admin')).rejects.toThrow(
      /not 'candidate'/,
    )
  })

  test('promoteCandidate 404 on unknown id', async () => {
    await expect(promoteCandidate(db, 'm_nope', { action: 'approve' }, 'u_admin')).rejects.toThrow(
      /not found/,
    )
  })

  test('archive → unarchive round-trip emits ws each step', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    await promoteCandidate(db, cand.id, { action: 'approve' }, 'u_admin')
    const cap = captureBroadcasts()
    const arc = await archiveMemory(db, cand.id)
    expect(arc.status).toBe('archived')
    const unarc = await unarchiveMemory(db, cand.id)
    expect(unarc.status).toBe('approved')
    cap.stop()
    expect(cap.msgs.filter((m) => m.type === 'memory.archived').length).toBe(1)
    expect(cap.msgs.filter((m) => m.type === 'memory.unarchived').length).toBe(1)
  })

  test('archive rejects non-approved', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    await expect(archiveMemory(db, cand.id)).rejects.toThrow(/expected one of approved/)
  })

  test('deleteMemory drops the row + emits ws', async () => {
    const cand = await createManualCandidate(db, {
      scopeType: 'global',
      scopeId: null,
      title: 't',
      bodyMd: 'b',
    })
    const cap = captureBroadcasts()
    await deleteMemory(db, cand.id)
    cap.stop()
    expect(await getMemoryById(db, cand.id)).toBeNull()
    expect(cap.msgs.find((m) => m.type === 'memory.deleted')).toBeTruthy()
  })

  test('getMemoryById walks the supersede chain (oldest last)', async () => {
    const v1 = await createManualCandidate(db, {
      scopeType: 'workflow',
      scopeId: 'wf1',
      title: 'v1',
      bodyMd: 'b',
    })
    await promoteCandidate(db, v1.id, { action: 'approve' }, 'u_admin')
    const v2 = await createManualCandidate(db, {
      scopeType: 'workflow',
      scopeId: 'wf1',
      title: 'v2',
      bodyMd: 'b',
    })
    await promoteCandidate(
      db,
      v2.id,
      { action: 'approve_and_supersede', supersedeIds: [v1.id] },
      'u_admin',
    )
    const v3 = await createManualCandidate(db, {
      scopeType: 'workflow',
      scopeId: 'wf1',
      title: 'v3',
      bodyMd: 'b',
    })
    await promoteCandidate(
      db,
      v3.id,
      { action: 'approve_and_supersede', supersedeIds: [v2.id] },
      'u_admin',
    )
    const head = await getMemoryById(db, v3.id)
    expect(head?.memory.id).toBe(v3.id)
    expect(head?.memory.version).toBe(3)
    expect(head?.ancestors.map((a) => a.id)).toEqual([v2.id, v1.id])
  })
})
