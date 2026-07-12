// RFC-164 PR-4 — the three workgroup room WS frames must invalidate the room
// query through useTaskSync's rules table (one physical per-task connection;
// the payloads are id-only so the rule is "re-fetch the room aggregate").
//
// Same source-level idiom as usetasksync-clarify-directive-refresh.test.ts:
// jsdom can't drive the WS hook end-to-end, so we lock the rule entries in
// the source plus the shared schema's acceptance of the three frames (a
// backend rename of a frame type would break the parse HERE before it
// silently stopped matching the rules table).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { TaskWsMessageSchema } from '@agent-workflow/shared'
import { workgroupRoomKey } from '../src/lib/workgroup-room'

const HOOK = resolve(import.meta.dirname, '..', 'src', 'hooks', 'useTaskSync.ts')
const norm = (s: string) => s.replace(/\s+/g, ' ')
const src = () => norm(readFileSync(HOOK, 'utf8'))

describe('useTaskSync — wg.* room frame rules', () => {
  test.each(['wg.message.created', 'wg.assignment.updated', 'wg.gate.updated'] as const)(
    "'%s' rule invalidates workgroupRoomKey(taskId)",
    (frame) => {
      const s = src()
      const idx = s.indexOf(`'${frame}':`)
      expect(idx).toBeGreaterThan(-1)
      expect(s.slice(idx, idx + 120)).toContain('workgroupRoomKey(taskId)')
    },
  )

  test('the hook imports the room key from lib/workgroup-room (single source with the query)', () => {
    expect(src()).toContain("import { workgroupRoomKey } from '@/lib/workgroup-room'")
    expect(workgroupRoomKey('t1')).toEqual(['workgroup-room', 't1'])
  })
})

describe('shared TaskWsMessageSchema accepts the three wg.* frames', () => {
  test('wg.message.created', () => {
    const r = TaskWsMessageSchema.safeParse({
      id: -1,
      type: 'wg.message.created',
      messageId: '01ABC',
      kind: 'dispatch',
    })
    expect(r.success).toBe(true)
  })

  test('wg.assignment.updated', () => {
    const r = TaskWsMessageSchema.safeParse({
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId: '01DEF',
      status: 'running',
    })
    expect(r.success).toBe(true)
  })

  test('wg.gate.updated', () => {
    const r = TaskWsMessageSchema.safeParse({
      id: -1,
      type: 'wg.gate.updated',
      awaitingConfirmation: true,
    })
    expect(r.success).toBe(true)
  })
})
