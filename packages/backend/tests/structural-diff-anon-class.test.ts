// RFC-086 — anonymous classes become first-class symbols (not phantom "classes"
// named after the enclosing method). Source incident: task
// 01KTDNGTHM975PF4WTG1Q3PV3Q — `new java.util.TimerTask(){ run(){} }` inside
// GameFrame.setupGameTimer() previously surfaced only as a `run` method whose
// qualifiedName re-parented onto the method, drawing a bogus class card titled
// `GameFrame.setupGameTimer`. Now the anonymous class is captured with its base
// type name (`TimerTask`), `anonymous: true`, and a "created by" edge from the
// enclosing method.

import { describe, expect, test } from 'bun:test'
import { analyzeFile } from '../src/services/structuralDiff/baseline'
import { computeAnonCreationEdges } from '../src/services/structuralDiff/classGraph'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const JAVA = `class GameFrame {
  private void setupGameTimer() {
    new java.util.Timer("T", true).scheduleAtFixedRate(new java.util.TimerTask() {
      @Override
      public void run() { tick(); }
    }, 0, 16);
  }
}
`

async function symbolsOf(file: FileStructuralDiff): Promise<SymbolNode[]> {
  return file.changes.map((c) => c.after).filter((s): s is SymbolNode => s !== undefined)
}

describe('RFC-086 — Java anonymous class extraction', () => {
  test('anonymous TimerTask is captured with base type name + anonymous flag', async () => {
    const file = await analyzeFile({ filePath: 'GameFrame.java', oldText: '', newText: JAVA })
    expect(file.status).toBe('ok')
    const syms = await symbolsOf(file)

    const anon = syms.find((s) => s.anonymous === true)
    expect(anon).toBeDefined()
    expect(anon?.kind).toBe('class')
    expect(anon?.name).toBe('TimerTask')
    // synthetic, unique qualifiedName under the enclosing METHOD (not a class)
    expect(anon?.qualifiedName).toMatch(/^GameFrame\.setupGameTimer\.\$anon\d+$/)

    // the override re-parents onto the anonymous class, NOT onto the method
    const run = syms.find((s) => s.name === 'run' && s.kind === 'method')
    expect(run?.qualifiedName).toBe(`${anon?.qualifiedName}.run`)
    expect(run?.parentId).toBe(anon?.id)

    // and there is NO class symbol named after the method
    expect(
      syms.some((s) => s.kind === 'class' && s.qualifiedName === 'GameFrame.setupGameTimer'),
    ).toBe(false)
  })

  test('a normal `new Foo()` (no class body) is NOT captured as anonymous', async () => {
    const file = await analyzeFile({
      filePath: 'A.java',
      oldText: '',
      newText: `class A { void m() { Foo f = new Foo(); f.go(); } }\n`,
    })
    const syms = await symbolsOf(file)
    expect(syms.some((s) => s.anonymous === true)).toBe(false)
  })

  test('creation edge: enclosing method → anonymous class', async () => {
    const file = await analyzeFile({ filePath: 'GameFrame.java', oldText: '', newText: JAVA })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    const setup = syms.find(
      (s) => s.qualifiedName === 'GameFrame.setupGameTimer' && s.kind === 'method',
    )

    const edges = computeAnonCreationEdges([file])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({
      from: 'GameFrame.java::GameFrame',
      to: `GameFrame.java::${anon?.qualifiedName}`,
      kind: 'references',
      fromMembers: [setup?.id ?? '?'],
    })
  })
})

describe('RFC-086 — TS/JS anonymous class expression', () => {
  test('anonymous class expression captured with extends base type + creation edge', async () => {
    const TS = `class Widget {
  build() {
    return register(class extends BasePanel { render() {} });
  }
}
`
    const file = await analyzeFile({ filePath: 'Widget.ts', oldText: '', newText: TS })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    expect(anon?.kind).toBe('class')
    expect(anon?.name).toBe('BasePanel')
    expect(anon?.qualifiedName).toMatch(/^Widget\.build\.\$anon\d+$/)

    const render = syms.find((s) => s.name === 'render' && s.kind === 'method')
    expect(render?.parentId).toBe(anon?.id)

    const build = syms.find((s) => s.qualifiedName === 'Widget.build')
    const edges = computeAnonCreationEdges([file])
    expect(edges).toContainEqual({
      from: 'Widget.ts::Widget',
      to: `Widget.ts::${anon?.qualifiedName}`,
      kind: 'references',
      fromMembers: [build?.id ?? '?'],
    })
  })

  test('anonymous class with no extends → empty base name (UI shows «anonymous»)', async () => {
    const file = await analyzeFile({
      filePath: 'a.js',
      oldText: '',
      newText: `function make() { return emit(class { go() {} }); }\n`,
    })
    const syms = await symbolsOf(file)
    const anon = syms.find((s) => s.anonymous === true)
    expect(anon).toBeDefined()
    expect(anon?.name).toBe('')
  })
})
