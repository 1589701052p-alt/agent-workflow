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

describe('RFC-087 private-gate end-to-end (bbebb8f fix now works for Rust via structural visibility)', () => {
  // The audit found the "private not used from outside" gate (commit bbebb8f)
  // silently failed for Rust/C++/JS because the heuristic mis-read their private
  // members as public. With backend `visibility`, a structurally-private downstream
  // member must be DROPPED from a references edge's memberLinks.
  function member(
    file: string,
    qn: string,
    line: number,
    visibility?: SymbolNode['visibility'],
  ): SymbolNode {
    const leaf = qn.slice(qn.lastIndexOf('.') + 1)
    return {
      id: `${file}#${qn}:method:${line}`,
      kind: 'method',
      name: leaf,
      qualifiedName: qn,
      signature: `fn ${leaf}(&self)`,
      lang: 'rust',
      filePath: file,
      range: { startLine: line, endLine: line },
      confidence: 'extracted',
      visibility,
    }
  }
  function container(file: string, name: string): SymbolNode {
    return {
      id: `${file}#${name}:struct:1`,
      kind: 'struct',
      name,
      qualifiedName: name,
      lang: 'rust',
      filePath: file,
      range: { startLine: 1, endLine: 9 },
      confidence: 'extracted',
    }
  }

  test('a structurally-private downstream member is excluded from the references edge memberLinks', () => {
    const pub = member('a.rs', 'D.pub_m', 5, 'public')
    const priv = member('a.rs', 'D.priv_m', 6, 'private')
    const diff = {
      scope: 'task',
      taskId: 't',
      fromRef: 'a',
      toRef: 'b',
      engine: 'baseline',
      status: 'ok',
      files: [
        {
          filePath: 'a.rs',
          lang: 'rust',
          status: 'ok',
          edges: [],
          impact: [],
          changes: [
            { changeType: 'modified', kind: 'struct', after: container('a.rs', 'C') },
            { changeType: 'modified', kind: 'struct', after: container('a.rs', 'D') },
            { changeType: 'added', kind: 'method', after: pub },
            { changeType: 'added', kind: 'method', after: priv },
          ],
        },
      ],
      dependencyChanges: [],
      impact: [],
      classEdges: [
        { from: 'a.rs::C', to: 'a.rs::D', kind: 'references', toMembers: [pub.id, priv.id] },
      ],
    } as unknown as StructuralDiff

    const graph = buildStructureGraph(diff)
    const edge = graph.edges.find((e) => e.source === 'a.rs::C' && e.target === 'a.rs::D')
    const targets = (edge?.memberLinks ?? []).map((l) => l.target)
    expect(targets).toContain(pub.id) // public stays
    expect(targets).not.toContain(priv.id) // private dropped (the gate works)
  })
})
