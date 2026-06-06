// RFC-087 — the graph prefers the backend's structurally-derived visibility over
// the signature/convention heuristic, so Rust/C++/JS `#private` members (which the
// heuristic mis-reads as public) group + gate correctly. Locks the audit finding
// that the private-not-externally-used gate (commit bbebb8f) silently failed for
// Rust/C++/JS.
import { describe, expect, test } from 'vitest'
import { buildStructureGraph, memberVisibility } from '../src/lib/structureGraph'
import type { StructuralDiff, SymbolNode } from '@agent-workflow/shared'

function diffWithMember(sym: SymbolNode): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'b',
    engine: 'baseline',
    status: 'ok',
    files: [
      {
        filePath: sym.filePath,
        lang: sym.lang,
        status: 'ok',
        changes: [{ changeType: 'added', kind: sym.kind, after: sym }],
        edges: [],
        impact: [],
      },
    ],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
  } as unknown as StructuralDiff
}

describe('RFC-087 memberVisibility', () => {
  test('# name is hard-private regardless of lang', () => {
    expect(memberVisibility(undefined, '#secret', 'javascript')).toBe('private')
    expect(memberVisibility('foo()', '#priv', 'typescript')).toBe('private')
  })
  test('rust members get no usable signal from the heuristic (why backend visibility matters)', () => {
    // `pub`/no-`pub` is invisible to the keyword regex, so the heuristic defaults
    // a private Rust fn to public — exactly the bug the backend field fixes.
    expect(memberVisibility('fn priv_m(&self)', 'priv_m', 'rust')).toBe('public')
  })
})

describe('RFC-087 buildStructureGraph prefers sym.visibility', () => {
  test('backend visibility wins over the heuristic', () => {
    const sym: SymbolNode = {
      id: 's.rs#S.priv_m:method:2',
      kind: 'method',
      name: 'priv_m',
      qualifiedName: 'S.priv_m',
      signature: 'fn priv_m(&self)', // heuristic would say "public" for rust
      lang: 'rust',
      filePath: 's.rs',
      range: { startLine: 2, endLine: 2 },
      confidence: 'extracted',
      visibility: 'private', // backend structural truth
    }
    const graph = buildStructureGraph(diffWithMember(sym))
    const member = graph.cards.flatMap((c) => c.members).find((m) => m.id === sym.id)
    expect(member?.visibility).toBe('private')
  })
})
