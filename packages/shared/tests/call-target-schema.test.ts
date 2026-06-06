// RFC-085 — callTargetSchema contract: the three resolution variants round-trip,
// optional ref/ownerClass behave, bad enums reject.

import { describe, expect, test } from 'bun:test'
import { callTargetSchema } from '../src/schemas/structuralDiff'

describe('callTargetSchema', () => {
  test('round-trips resolved / external / unresolved', () => {
    const resolved = {
      ref: 'a.ts#X.y',
      label: 'y()',
      kind: 'method' as const,
      order: 0,
      resolution: 'resolved' as const,
      ownerClass: 'a.ts::X',
    }
    const external = {
      label: 'z.w()',
      kind: 'method' as const,
      order: 1,
      resolution: 'external' as const,
      ownerClass: 'b.ts::Z',
    }
    const unresolved = {
      label: 'q.r()',
      kind: 'method' as const,
      order: 2,
      resolution: 'unresolved' as const,
    }
    for (const v of [resolved, external, unresolved]) {
      expect(callTargetSchema.parse(v)).toEqual(v)
    }
  })

  test('constructor kind is accepted', () => {
    const ctor = {
      ref: 'a.ts#T.constructor',
      label: 'new T()',
      kind: 'constructor' as const,
      order: 0,
      resolution: 'resolved' as const,
      ownerClass: 'a.ts::T',
    }
    expect(callTargetSchema.parse(ctor).kind).toBe('constructor')
  })

  test('rejects an unknown resolution + a negative order', () => {
    expect(() =>
      callTargetSchema.parse({ label: 'x', kind: 'method', order: 0, resolution: 'bogus' }),
    ).toThrow()
    expect(() =>
      callTargetSchema.parse({ label: 'x', kind: 'method', order: -1, resolution: 'resolved' }),
    ).toThrow()
  })
})
