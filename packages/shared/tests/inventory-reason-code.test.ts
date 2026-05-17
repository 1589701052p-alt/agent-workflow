// RFC-029-T1: inventoryReasonCode — central reason classifier.

import { describe, expect, test } from 'bun:test'
import { inventoryReasonCode } from '../src/inventory'

describe('inventoryReasonCode', () => {
  test('non-agent kind short-circuits regardless of error', () => {
    expect(
      inventoryReasonCode(new Error('any'), {
        runDirExists: true,
        pureMode: false,
        nodeKind: 'wrapper',
      }),
    ).toBe('non-agent-kind')
    expect(
      inventoryReasonCode(null, { runDirExists: false, pureMode: true, nodeKind: 'review' }),
    ).toBe('non-agent-kind')
  })

  test('pure mode preempts other errors when nodeKind=agent', () => {
    expect(
      inventoryReasonCode(new Error('ENOENT'), {
        runDirExists: true,
        pureMode: true,
        nodeKind: 'agent',
      }),
    ).toBe('opencode-pure-mode')
  })

  test('runDir missing → plugin-load-failed', () => {
    expect(
      inventoryReasonCode(null, { runDirExists: false, pureMode: false, nodeKind: 'agent' }),
    ).toBe('plugin-load-failed')
  })

  test('SyntaxError → parse-failed', () => {
    expect(
      inventoryReasonCode(new SyntaxError('Unexpected token'), {
        runDirExists: true,
        pureMode: false,
        nodeKind: 'agent',
      }),
    ).toBe('parse-failed')
  })

  test('error mentioning dump-plugin → dump-plugin-internal-error', () => {
    expect(
      inventoryReasonCode(new Error('dump-plugin crashed'), {
        runDirExists: true,
        pureMode: false,
        nodeKind: 'agent',
      }),
    ).toBe('dump-plugin-internal-error')
  })

  test('ENOENT-style → file-missing', () => {
    expect(
      inventoryReasonCode(new Error('ENOENT: no such file'), {
        runDirExists: true,
        pureMode: false,
        nodeKind: 'agent',
      }),
    ).toBe('file-missing')
  })

  test('unknown / generic error → file-missing (conservative default)', () => {
    expect(
      inventoryReasonCode(new Error('something weird'), {
        runDirExists: true,
        pureMode: false,
        nodeKind: 'agent',
      }),
    ).toBe('file-missing')
  })

  test('null error + agent + runDir exists → file-missing', () => {
    expect(
      inventoryReasonCode(null, { runDirExists: true, pureMode: false, nodeKind: 'agent' }),
    ).toBe('file-missing')
  })
})
