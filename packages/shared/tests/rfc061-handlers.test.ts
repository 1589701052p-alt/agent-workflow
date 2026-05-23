// RFC-061 PR-A T2 — handler registry shape tests.
//
// LOCKS:
//   - NODE_KIND_HANDLERS / SIGNAL_KIND_HANDLERS are exported as registry
//     objects so backend can wire concrete handlers in PR-B
//   - The PR-A registry is intentionally empty; the registry TYPES are
//     keyed by the closed NodeKind / SignalKind unions, so PR-B
//     populating them keeps exhaustiveness alive at compile time
//   - DispatchResult / NodeDecision are tagged unions ready for switch()

import { describe, expect, test } from 'bun:test'

import {
  NODE_KIND_HANDLERS,
  SIGNAL_KIND_HANDLERS,
  type ActorRef,
  type DispatchResult,
  type NodeDecision,
  type NodeKindHandler,
  type ResolveEffect,
  type SignalKindHandler,
} from '../src/handlers'
import { NodeKindSchema } from '../src/schemas/workflow'
import { SignalKindSchema, SIGNAL_KINDS } from '../src/events'

describe('Handler registry shape', () => {
  test('NODE_KIND_HANDLERS exists as an object', () => {
    expect(typeof NODE_KIND_HANDLERS).toBe('object')
    expect(NODE_KIND_HANDLERS).not.toBeNull()
  })

  test('SIGNAL_KIND_HANDLERS exists as an object', () => {
    expect(typeof SIGNAL_KIND_HANDLERS).toBe('object')
    expect(SIGNAL_KIND_HANDLERS).not.toBeNull()
  })

  test('PR-A registries are intentionally empty (handlers land in PR-B)', () => {
    expect(Object.keys(NODE_KIND_HANDLERS).length).toBe(0)
    expect(Object.keys(SIGNAL_KIND_HANDLERS).length).toBe(0)
  })
})

describe('NodeKind union (consumed by NodeKindHandler<K>)', () => {
  test('NodeKindSchema accepts the 9 RFC-060-completed kinds', () => {
    const expectedKinds = [
      'agent-single',
      'input',
      'output',
      'wrapper-git',
      'wrapper-loop',
      'wrapper-fanout',
      'review',
      'clarify',
      'clarify-cross-agent',
    ]
    for (const k of expectedKinds) {
      expect(NodeKindSchema.safeParse(k).success).toBe(true)
    }
  })

  test('NodeKindSchema rejects agent-multi (deleted in RFC-060 PR-E)', () => {
    expect(NodeKindSchema.safeParse('agent-multi').success).toBe(false)
  })
})

describe('SignalKind union', () => {
  test('SignalKindSchema covers the 6 closed kinds', () => {
    for (const k of SIGNAL_KINDS) {
      expect(SignalKindSchema.safeParse(k).success).toBe(true)
    }
  })

  test('await-external-data is reserved for future use (v1 no implementation)', () => {
    expect(SignalKindSchema.safeParse('await-external-data').success).toBe(true)
  })
})

describe('DispatchResult tagged union', () => {
  test('spawn-attempt has prompt + optional preSnapshot', () => {
    const r: DispatchResult = { kind: 'spawn-attempt', prompt: 'do thing' }
    expect(r.kind).toBe('spawn-attempt')
  })

  test('virtual-done carries outputs by port name', () => {
    const r: DispatchResult = {
      kind: 'virtual-done',
      outputs: { out: 'hello' },
    }
    if (r.kind !== 'virtual-done') throw new Error('narrow failed')
    expect(r.outputs.out).toBe('hello')
  })

  test('enter-inner-scope carries scope', () => {
    const r: DispatchResult = {
      kind: 'enter-inner-scope',
      innerScope: { nodeId: 'inner_n', loopIter: 0, shardKey: '', iter: 0 },
    }
    if (r.kind !== 'enter-inner-scope') throw new Error('narrow failed')
    expect(r.innerScope.nodeId).toBe('inner_n')
  })

  test('enter-inner-scope-multi carries an array of inner scopes', () => {
    const r: DispatchResult = {
      kind: 'enter-inner-scope-multi',
      innerScopes: [
        { nodeId: 'fan_inner', loopIter: 0, shardKey: 'a', iter: 0 },
        { nodeId: 'fan_inner', loopIter: 0, shardKey: 'b', iter: 0 },
      ],
    }
    if (r.kind !== 'enter-inner-scope-multi') throw new Error('narrow failed')
    expect(r.innerScopes.length).toBe(2)
  })

  test('noop carries a reason string', () => {
    const r: DispatchResult = { kind: 'noop', reason: 'upstream not ready' }
    if (r.kind !== 'noop') throw new Error('narrow failed')
    expect(r.reason).toBe('upstream not ready')
  })
})

describe('NodeDecision tagged union', () => {
  test('done carries outputs', () => {
    const d: NodeDecision = { kind: 'done', outputs: { out: 'ok' } }
    if (d.kind !== 'done') throw new Error('narrow failed')
    expect(d.outputs.out).toBe('ok')
  })

  test('fail carries errorMessage', () => {
    const d: NodeDecision = { kind: 'fail', errorMessage: 'envelope missing' }
    if (d.kind !== 'fail') throw new Error('narrow failed')
    expect(d.errorMessage).toContain('envelope')
  })

  test('suspend carries signalKind + payload + awaitsActor', () => {
    const d: NodeDecision = {
      kind: 'suspend',
      signalKind: 'self-clarify',
      payload: { questions: ['why?'] },
      awaitsActor: 'user:alice',
    }
    if (d.kind !== 'suspend') throw new Error('narrow failed')
    expect(d.signalKind).toBe('self-clarify')
    expect(d.awaitsActor).toBe('user:alice')
  })

  test('request-retry-auto + request-retry-human distinguish budget pathways', () => {
    const a: NodeDecision = { kind: 'request-retry-auto', reason: 'transient crash' }
    const b: NodeDecision = { kind: 'request-retry-human', reason: 'budget exhausted' }
    expect(a.kind).toBe('request-retry-auto')
    expect(b.kind).toBe('request-retry-human')
  })
})

describe('ActorRef template literal union', () => {
  test('accepts system / user / agent / opencode forms', () => {
    const refs: ActorRef[] = ['system', 'user:alice', 'agent:designer_1', 'opencode:sess_xyz']
    expect(refs.length).toBe(4)
  })
})

describe('ResolveEffect / depends-on-payload', () => {
  test('values are well-defined', () => {
    const a: ResolveEffect = 'bump-iter'
    const b: ResolveEffect = 'no-bump'
    expect(a).toBe('bump-iter')
    expect(b).toBe('no-bump')
  })
})

/* ============================================================
 *  Compile-time shape checks (no runtime assertion needed) — these
 *  test bodies primarily document the contract; if a future refactor
 *  drops a required interface field, the test file fails to compile.
 * ============================================================ */
describe('NodeKindHandler<K> interface required methods', () => {
  test('stub conforming object compiles', () => {
    const stub: NodeKindHandler<'agent-single'> = {
      kind: 'agent-single',
      async dispatch() {
        return { kind: 'spawn-attempt', prompt: 'go' }
      },
      async onAttemptFinished() {
        return { kind: 'done', outputs: {} }
      },
    }
    expect(stub.kind).toBe('agent-single')
  })

  test('readyCondition + buildPromptFromEvents + onInnerScopeCompleted are optional', () => {
    const stub: NodeKindHandler<'input'> = {
      kind: 'input',
      async dispatch() {
        return { kind: 'virtual-done', outputs: {} }
      },
      async onAttemptFinished() {
        return { kind: 'done', outputs: {} }
      },
    }
    expect(stub.readyCondition).toBeUndefined()
    expect(stub.buildPromptFromEvents).toBeUndefined()
    expect(stub.onInnerScopeCompleted).toBeUndefined()
  })
})

describe('SignalKindHandler<K> interface required methods', () => {
  test('stub conforming object compiles', () => {
    const stub: SignalKindHandler<'self-clarify'> = {
      kind: 'self-clarify',
      async onSuspend() {
        return []
      },
      validateResolution() {
        return { valid: true }
      },
      async applyResolution() {
        return []
      },
      effectOnLogicalRun() {
        return 'bump-iter'
      },
      renderPromptSection() {
        return ''
      },
    }
    expect(stub.kind).toBe('self-clarify')
  })

  test('autoResolve is optional', () => {
    const stub: SignalKindHandler<'review'> = {
      kind: 'review',
      async onSuspend() {
        return []
      },
      validateResolution() {
        return { valid: true }
      },
      async applyResolution() {
        return []
      },
      effectOnLogicalRun() {
        return 'depends-on-payload'
      },
      renderPromptSection() {
        return ''
      },
    }
    expect(stub.autoResolve).toBeUndefined()
  })
})
