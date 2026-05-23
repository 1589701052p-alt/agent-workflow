// RFC-061 PR-A T2 — shared event taxonomy tests.
//
// LOCKS:
//   - 25 EventKinds form a closed enum (adding a value requires three
//     coordinated changes: events.ts EVENT_KINDS, EVENT_PAYLOAD_SCHEMAS,
//     and the migration CHECK constraint)
//   - Every EventKind has a matching payload Zod schema entry
//   - encodeEventPayload validates round-trip equality
//   - decodeEvent validates schema mismatches loudly
//   - sameScope respects the '' sentinel for shardKey
//   - eventScope throws on partial-scope events (impossible state)

import { describe, expect, test } from 'bun:test'

import {
  decodeEvent,
  encodeEventPayload,
  EventKindSchema,
  EVENT_KINDS,
  EVENT_PAYLOAD_SCHEMAS,
  eventScope,
  hasFullScope,
  RawEventSchema,
  sameScope,
  sameScopePrefix,
  ScopeSchema,
  SIGNAL_KINDS,
  SignalKindSchema,
  type Event,
  type RawEvent,
  type Scope,
} from '../src/events'

const FULL_SCOPE: Scope = { nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 }

const baseRow = (overrides: Partial<RawEvent>): RawEvent => ({
  id: 'evt_1',
  taskId: 'task_1',
  ts: 1000,
  kind: 'task-started',
  nodeId: null,
  loopIter: null,
  shardKey: null,
  iter: null,
  attemptId: null,
  parentEventId: null,
  actor: 'system',
  resolutionId: null,
  payload: '{}',
  ...overrides,
})

/* ============================================================
 *  Closed-enum cardinality
 * ============================================================ */

describe('EventKind closed enum', () => {
  test('contains exactly 25 kinds', () => {
    expect(EVENT_KINDS.length).toBe(25)
  })

  test('EventKindSchema accepts every member of EVENT_KINDS', () => {
    for (const kind of EVENT_KINDS) {
      expect(EventKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  test('EventKindSchema rejects bogus kind', () => {
    expect(EventKindSchema.safeParse('task-frobnicated').success).toBe(false)
  })

  test('EVENT_PAYLOAD_SCHEMAS has one entry per EventKind', () => {
    const keys = Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()
    const expected = [...EVENT_KINDS].sort()
    expect(keys).toEqual(expected)
  })
})

describe('SignalKind closed enum', () => {
  test('contains exactly 6 kinds', () => {
    expect(SIGNAL_KINDS.length).toBe(6)
  })

  test('SignalKindSchema accepts every member', () => {
    for (const k of SIGNAL_KINDS) {
      expect(SignalKindSchema.safeParse(k).success).toBe(true)
    }
  })

  test('SignalKindSchema rejects bogus signalKind', () => {
    expect(SignalKindSchema.safeParse('not-a-signal').success).toBe(false)
  })
})

/* ============================================================
 *  Per-kind payload Zod schemas — happy + reject for each
 * ============================================================ */

describe('EVENT_PAYLOAD_SCHEMAS — happy paths', () => {
  test('task-created accepts a valid workflowId', () => {
    const ok = EVENT_PAYLOAD_SCHEMAS['task-created'].safeParse({ workflowId: 'wf_1' })
    expect(ok.success).toBe(true)
  })

  test('task-failed accepts reason + optional failedNodeId', () => {
    expect(EVENT_PAYLOAD_SCHEMAS['task-failed'].safeParse({ reason: 'boom' }).success).toBe(true)
    expect(
      EVENT_PAYLOAD_SCHEMAS['task-failed'].safeParse({
        reason: 'boom',
        failedNodeId: 'n1',
      }).success,
    ).toBe(true)
  })

  test('attempt-output-captured requires portName + content', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['attempt-output-captured'].safeParse({
        portName: 'out',
        content: 'hello',
      }).success,
    ).toBe(true)
  })

  test('suspension-created accepts arbitrary body via z.unknown', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['suspension-created'].safeParse({
        suspensionId: 'sus_1',
        signalKind: 'self-clarify',
        awaitsActor: 'user:alice',
        body: { questions: ['q1?'] },
      }).success,
    ).toBe(true)
  })

  test('suspension-resolved accepts arbitrary decision', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['suspension-resolved'].safeParse({
        suspensionId: 'sus_1',
        signalKind: 'review',
        decision: { kind: 'iterate', comment: 'try again' },
      }).success,
    ).toBe(true)
  })

  test('logical-run-iter-bumped pins triggerKind to a closed set', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['logical-run-iter-bumped'].safeParse({
        triggerEventId: 'evt_x',
        triggerKind: 'suspension-resolved',
      }).success,
    ).toBe(true)
    expect(
      EVENT_PAYLOAD_SCHEMAS['logical-run-iter-bumped'].safeParse({
        triggerEventId: 'evt_x',
        triggerKind: 'made-up',
      }).success,
    ).toBe(false)
  })

  test('task-resumed-after-daemon-restart requires non-negative count', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['task-resumed-after-daemon-restart'].safeParse({
        crashedAttemptCount: 0,
      }).success,
    ).toBe(true)
    expect(
      EVENT_PAYLOAD_SCHEMAS['task-resumed-after-daemon-restart'].safeParse({
        crashedAttemptCount: -1,
      }).success,
    ).toBe(false)
  })

  test('attempt-finished-timeout requires positive timeoutMs', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['attempt-finished-timeout'].safeParse({ timeoutMs: 5000 }).success,
    ).toBe(true)
    expect(
      EVENT_PAYLOAD_SCHEMAS['attempt-finished-timeout'].safeParse({ timeoutMs: 0 }).success,
    ).toBe(false)
  })

  test('task-started uses NoPayload (rejects extra keys)', () => {
    expect(EVENT_PAYLOAD_SCHEMAS['task-started'].safeParse({}).success).toBe(true)
    expect(EVENT_PAYLOAD_SCHEMAS['task-started'].safeParse({ extra: 1 }).success).toBe(false)
  })

  test('attempt-finished-success uses NoPayload (rejects extra keys)', () => {
    expect(EVENT_PAYLOAD_SCHEMAS['attempt-finished-success'].safeParse({}).success).toBe(true)
    expect(EVENT_PAYLOAD_SCHEMAS['attempt-finished-success'].safeParse({ extra: 1 }).success).toBe(
      false,
    )
  })

  test('invariant-alert-detected accepts a rule + opaque detail', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['invariant-alert-detected'].safeParse({
        rule: 'R1',
        detail: { taskId: 't1', count: 3 },
      }).success,
    ).toBe(true)
  })

  test('suspension-created requires its signalKind member to be closed-set', () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS['suspension-created'].safeParse({
        suspensionId: 'sus_1',
        signalKind: 'not-a-real-signal',
        awaitsActor: 'user:alice',
        body: {},
      }).success,
    ).toBe(false)
  })
})

describe('EVENT_PAYLOAD_SCHEMAS — reject paths', () => {
  test('task-created without workflowId fails', () => {
    const r = EVENT_PAYLOAD_SCHEMAS['task-created'].safeParse({})
    expect(r.success).toBe(false)
  })

  test('attempt-output-captured without portName fails', () => {
    const r = EVENT_PAYLOAD_SCHEMAS['attempt-output-captured'].safeParse({
      content: 'no-port',
    })
    expect(r.success).toBe(false)
  })

  test('task-failed without reason fails', () => {
    const r = EVENT_PAYLOAD_SCHEMAS['task-failed'].safeParse({})
    expect(r.success).toBe(false)
  })
})

/* ============================================================
 *  encode / decode round trip
 * ============================================================ */

describe('encodeEventPayload + decodeEvent round trip', () => {
  test('round-trips a task-created payload', () => {
    const payload = { workflowId: 'wf_abc' }
    const encoded = encodeEventPayload('task-created', payload)
    expect(typeof encoded).toBe('string')
    expect(JSON.parse(encoded)).toEqual(payload)
  })

  test('decodeEvent reconstructs typed event', () => {
    const raw = baseRow({
      kind: 'task-created',
      payload: JSON.stringify({ workflowId: 'wf_xyz' }),
    })
    const decoded = decodeEvent(raw)
    if (decoded.kind !== 'task-created') {
      throw new Error('discriminator failed')
    }
    // TypeScript narrows payload to { workflowId: string } at this point
    expect(decoded.payload.workflowId).toBe('wf_xyz')
  })

  test('decodeEvent throws on malformed payload', () => {
    const raw = baseRow({
      kind: 'task-failed',
      payload: '{}', // missing required `reason`
    })
    expect(() => decodeEvent(raw)).toThrow()
  })

  test('decodeEvent throws on unknown kind', () => {
    const raw = baseRow({
      // @ts-expect-error — intentionally bogus to test runtime rejection
      kind: 'task-frobnicated',
    })
    expect(() => decodeEvent(raw)).toThrow()
  })

  test('decodeEvent for attempt-output-captured exposes portName + content', () => {
    const raw = baseRow({
      kind: 'attempt-output-captured',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: 'att_1',
      payload: JSON.stringify({ portName: 'out', content: 'hello' }),
    })
    const decoded = decodeEvent(raw)
    if (decoded.kind !== 'attempt-output-captured') throw new Error('kind narrow failed')
    expect(decoded.payload.portName).toBe('out')
    expect(decoded.payload.content).toBe('hello')
  })

  test('encodeEventPayload rejects an invalid payload at compile time + runtime', () => {
    // Runtime rejection: bypass TS via cast
    expect(() => encodeEventPayload('task-created', {} as never)).toThrow()
  })
})

/* ============================================================
 *  Scope helpers
 * ============================================================ */

describe('Scope helpers', () => {
  test('sameScope returns true on exact match including empty shardKey', () => {
    const evt = {
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    } as const
    expect(sameScope(evt, FULL_SCOPE)).toBe(true)
  })

  test('sameScope treats null shardKey on event as the "" sentinel', () => {
    const evt = {
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: null,
      iter: 0,
    } as const
    expect(sameScope(evt, FULL_SCOPE)).toBe(true)
  })

  test('sameScope returns false when iter differs', () => {
    const evt = {
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 1,
    } as const
    expect(sameScope(evt, FULL_SCOPE)).toBe(false)
  })

  test('sameScopePrefix ignores iter when matching', () => {
    const evt = {
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
    } as const
    expect(sameScopePrefix(evt, FULL_SCOPE)).toBe(true)
  })

  test('hasFullScope returns false on task-level event', () => {
    const evt = {
      nodeId: null,
      loopIter: null,
      shardKey: null,
      iter: null,
    } as const
    expect(hasFullScope(evt)).toBe(false)
  })

  test('hasFullScope returns true on attempt-level event', () => {
    const evt = {
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    } as const
    expect(hasFullScope(evt)).toBe(true)
  })

  test('eventScope returns null on fully-null task-level event', () => {
    const evt = {
      kind: 'task-started',
      nodeId: null,
      loopIter: null,
      shardKey: null,
      iter: null,
    } as const
    expect(eventScope(evt as never)).toBe(null)
  })

  test('eventScope throws on partial-scope event (impossible state)', () => {
    const evt = {
      kind: 'attempt-started' as const,
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: null, // partial!
    }
    expect(() => eventScope(evt as never)).toThrow(/partial scope/)
  })

  test('ScopeSchema rejects negative iter', () => {
    expect(
      ScopeSchema.safeParse({ nodeId: 'n', loopIter: 0, shardKey: '', iter: -1 }).success,
    ).toBe(false)
  })
})

/* ============================================================
 *  RawEventSchema row validation
 * ============================================================ */

describe('RawEventSchema row validation', () => {
  test('accepts a minimal task-started row', () => {
    const r = RawEventSchema.safeParse(baseRow({}))
    expect(r.success).toBe(true)
  })

  test('rejects empty taskId', () => {
    const r = RawEventSchema.safeParse(baseRow({ taskId: '' }))
    expect(r.success).toBe(false)
  })

  test('rejects empty actor', () => {
    const r = RawEventSchema.safeParse(baseRow({ actor: '' }))
    expect(r.success).toBe(false)
  })

  test('accepts null in every nullable column', () => {
    const r = RawEventSchema.safeParse(baseRow({}))
    expect(r.success).toBe(true)
  })

  test('compile-time discriminated event type narrows by kind', () => {
    const e: Event = {
      id: 'evt_1',
      taskId: 'task_1',
      ts: 1,
      kind: 'task-created',
      nodeId: null,
      loopIter: null,
      shardKey: null,
      iter: null,
      attemptId: null,
      parentEventId: null,
      actor: 'system',
      resolutionId: null,
      payload: { workflowId: 'wf_1' },
    }
    if (e.kind === 'task-created') {
      // The compiler must know payload has `workflowId` here
      expect(e.payload.workflowId).toBe('wf_1')
    }
  })
})
