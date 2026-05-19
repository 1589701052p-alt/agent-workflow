// RFC-044 — ConfigSchema additions for distiller source-context budget.
//
// Locks the new memoryDistillSourceContext field (optional) + its byte caps
// against the existing DEFAULT_CONFIG / ConfigPatchSchema contract surface.

import { describe, expect, test } from 'bun:test'

import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_SOURCE_CONTEXT_BUDGET,
} from '../src/schemas/config.js'

describe('RFC-044 ConfigSchema additions', () => {
  test('accepts a valid memoryDistillSourceContext object', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 8192, reviewBodyMaxBytes: 4096 },
    })
    expect(parsed.memoryDistillSourceContext).toEqual({
      clarifyTranscriptMaxBytes: 8192,
      reviewBodyMaxBytes: 4096,
    })
  })

  test('omitted field stays undefined (backward-compatible default)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.memoryDistillSourceContext).toBeUndefined()
  })

  test('zero is allowed (disables block)', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 0, reviewBodyMaxBytes: 0 },
    })
    expect(parsed.memoryDistillSourceContext?.clarifyTranscriptMaxBytes).toBe(0)
    expect(parsed.memoryDistillSourceContext?.reviewBodyMaxBytes).toBe(0)
  })

  test('upper bound 65536 accepted; 65537 rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 65536,
          reviewBodyMaxBytes: 65536,
        },
      }),
    ).not.toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 65537,
          reviewBodyMaxBytes: 65536,
        },
      }),
    ).toThrow()
  })

  test('negative byte budget rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: -1,
          reviewBodyMaxBytes: 0,
        },
      }),
    ).toThrow()
  })

  test('non-integer rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        memoryDistillSourceContext: {
          clarifyTranscriptMaxBytes: 100.5,
          reviewBodyMaxBytes: 1000,
        },
      }),
    ).toThrow()
  })

  test('ConfigPatchSchema accepts the new field as a partial', () => {
    const parsed = ConfigPatchSchema.parse({
      memoryDistillSourceContext: { clarifyTranscriptMaxBytes: 1024, reviewBodyMaxBytes: 1024 },
    })
    expect(parsed.memoryDistillSourceContext?.clarifyTranscriptMaxBytes).toBe(1024)
  })

  test('DEFAULT_SOURCE_CONTEXT_BUDGET is the single source of truth (16384 / 16384)', () => {
    expect(DEFAULT_SOURCE_CONTEXT_BUDGET).toEqual({
      clarifyTranscriptMaxBytes: 16384,
      reviewBodyMaxBytes: 16384,
    })
  })
})
