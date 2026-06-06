// RFC-085 T2 — pure cross-file resolution helpers (no parser).

import { describe, expect, test } from 'bun:test'
import {
  scanClassDecls,
  buildClassIndex,
  inferLocalTypes,
} from '../src/services/structuralDiff/callGraph/classIndex'

describe('scanClassDecls + buildClassIndex', () => {
  test('finds class/interface/struct/etc declaration names → file index', () => {
    const a = scanClassDecls('a.ts', 'export class Foo {}\ninterface Bar {}')
    expect(a.sort()).toEqual(['Bar', 'Foo'])
    const idx = buildClassIndex([
      { file: 'a.ts', names: scanClassDecls('a.ts', 'class Foo {}') },
      { file: 'b.go', names: scanClassDecls('b.go', 'type T struct{}\nstruct Baz {}') },
    ])
    expect(idx.get('Foo')).toEqual(['a.ts'])
    expect(idx.get('Baz')).toEqual(['b.go'])
  })
})

describe('inferLocalTypes', () => {
  test('Type-first / annotation / new — Capitalised types only', () => {
    const t = inferLocalTypes(
      'OrderService svc;\n const repo: PaymentRepo = x;\n let m = new Mailer();\n int n;',
    )
    expect(t.get('svc')).toBe('OrderService') // Java-style `Type name`
    expect(t.get('repo')).toBe('PaymentRepo') // TS-style `name: Type`
    expect(t.get('m')).toBe('Mailer') // `name = new Type`
    expect(t.has('n')).toBe(false) // lowercase type ignored
  })

  test('generics stripped to the base type', () => {
    const t = inferLocalTypes('List<String> items;\n Map<K,V> table = new HashMap<>();')
    expect(t.get('items')).toBe('List')
    expect(t.get('table')).toBe('HashMap')
  })
})
