// RFC-028 T9 — pure-form helpers. Locks the ergonomic-vs-wire bridge:
// command/env/headers UI shapes vs CreateMcp payload shape.

import { describe, expect, test } from 'vitest'
import {
  buildCreatePayload,
  EMPTY_LOCAL_FORM,
  kvToLines,
  parseKvLines,
  tokenizeCommand,
  type McpFormState,
} from '../src/lib/mcp-form'

describe('tokenizeCommand', () => {
  test('splits on whitespace, trims, collapses runs', () => {
    expect(tokenizeCommand('uvx postgres-mcp')).toEqual(['uvx', 'postgres-mcp'])
    expect(tokenizeCommand('   bash -lc   "echo hi"   ')).toEqual(['bash', '-lc', '"echo', 'hi"'])
  })
  test('empty input → []', () => {
    expect(tokenizeCommand('')).toEqual([])
    expect(tokenizeCommand('   ')).toEqual([])
  })
})

describe('parseKvLines / kvToLines', () => {
  test('parses KEY=VALUE lines, drops empties + malformed', () => {
    expect(parseKvLines('A=1\nB=2\n\n# comment\nC=3=extra')).toEqual({
      A: '1',
      B: '2',
      C: '3=extra',
    })
  })
  test('empty input → undefined', () => {
    expect(parseKvLines('')).toBeUndefined()
    expect(parseKvLines('\n\n')).toBeUndefined()
  })
  test('kvToLines is the inverse on sorted keys', () => {
    expect(kvToLines({ B: '2', A: '1' })).toBe('A=1\nB=2')
    expect(kvToLines(undefined)).toBe('')
  })
})

describe('buildCreatePayload (local)', () => {
  const base: McpFormState = {
    ...EMPTY_LOCAL_FORM,
    name: 'postgres-prod',
    description: 'prod',
    command: 'uvx postgres-mcp',
  }

  test('happy path: command only', () => {
    const r = buildCreatePayload(base)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.payload.type).toBe('local')
      if (r.payload.type === 'local') {
        expect(r.payload.config.command).toEqual(['uvx', 'postgres-mcp'])
        expect(r.payload.config.env).toBeUndefined()
      }
    }
  })

  test('happy path: command + env + timeoutMs', () => {
    const r = buildCreatePayload({
      ...base,
      envText: 'PG_URL=postgresql://localhost/x\nLOG=info',
      timeoutMsText: '5000',
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.payload.type === 'local') {
      expect(r.payload.config.env).toEqual({ PG_URL: 'postgresql://localhost/x', LOG: 'info' })
      expect(r.payload.config.timeoutMs).toBe(5000)
    }
  })

  test('missing name → form error', () => {
    const r = buildCreatePayload({ ...base, name: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.name).toBe('mcps.errors.nameRequired')
  })

  test('empty command (after tokenize) → form error', () => {
    const r = buildCreatePayload({ ...base, command: '   ' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.command).toBe('mcps.errors.commandRequired')
  })

  test('non-numeric timeoutMs → form error', () => {
    const r = buildCreatePayload({ ...base, timeoutMsText: 'abc' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.timeoutMs).toBe('mcps.errors.timeoutInvalid')
  })

  test('zero / negative timeoutMs → form error', () => {
    expect(buildCreatePayload({ ...base, timeoutMsText: '0' }).ok).toBe(false)
    expect(buildCreatePayload({ ...base, timeoutMsText: '-1' }).ok).toBe(false)
  })

  test('LOCK: payload never contains `cwd` field (opencode does not accept it)', () => {
    const r = buildCreatePayload({
      ...base,
      envText: 'A=1',
      timeoutMsText: '1000',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const serialised = JSON.stringify(r.payload)
      expect(serialised).not.toContain('"cwd"')
    }
  })
})

describe('buildCreatePayload (remote)', () => {
  const base: McpFormState = {
    ...EMPTY_LOCAL_FORM,
    name: 'sentry',
    type: 'remote',
    url: 'https://sentry.io/mcp',
  }

  test('happy path: url + headers', () => {
    const r = buildCreatePayload({
      ...base,
      headersText: 'Authorization=Bearer xyz',
    })
    expect(r.ok).toBe(true)
    if (r.ok && r.payload.type === 'remote') {
      expect(r.payload.config.url).toBe('https://sentry.io/mcp')
      expect(r.payload.config.headers).toEqual({ Authorization: 'Bearer xyz' })
      expect(r.payload.config.oauth).toBeUndefined()
    }
  })

  test('oauthMode=disabled emits literal false', () => {
    const r = buildCreatePayload({ ...base, oauthMode: 'disabled' })
    expect(r.ok).toBe(true)
    if (r.ok && r.payload.type === 'remote') {
      expect(r.payload.config.oauth).toBe(false)
    }
  })

  test('non-http(s) url → form error', () => {
    expect(buildCreatePayload({ ...base, url: 'ftp://x' }).ok).toBe(false)
    expect(buildCreatePayload({ ...base, url: '' }).ok).toBe(false)
  })
})
