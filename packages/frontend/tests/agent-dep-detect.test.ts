// RFC-038 T1 — locks the pure detectAgentDeps contract: contains scan, four
// inventory groups, self/existing/empty/dedup filters, case sensitivity.

import { describe, expect, test } from 'vitest'
import { detectAgentDeps, totalCandidates, type DetectExisting } from '../src/lib/agent-dep-detect'

const emptyExisting: DetectExisting = {
  dependsOn: [],
  skills: [],
  mcp: [],
  plugins: [],
}

describe('detectAgentDeps', () => {
  test('empty body → all groups empty', () => {
    const r = detectAgentDeps(
      '',
      { agents: [{ name: 'foo' }], skills: [{ name: 'bar' }] },
      emptyExisting,
      '',
    )
    expect(totalCandidates(r)).toBe(0)
  })

  test('agent name in body → agents group hits, others stay empty', () => {
    const r = detectAgentDeps(
      'call git-diff-snapshot first',
      { agents: [{ name: 'git-diff-snapshot' }], skills: [{ name: 'unused-skill' }] },
      emptyExisting,
      'self-agent',
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual(['git-diff-snapshot'])
    expect(r.skills.candidates).toEqual([])
  })

  test('hit already in existing.dependsOn → excluded', () => {
    const r = detectAgentDeps(
      'call git-diff-snapshot',
      { agents: [{ name: 'git-diff-snapshot' }] },
      { ...emptyExisting, dependsOn: ['git-diff-snapshot'] },
      '',
    )
    expect(r.agents.candidates).toEqual([])
  })

  test('selfName excluded from agents group', () => {
    const r = detectAgentDeps(
      'self-agent does the work',
      { agents: [{ name: 'self-agent' }, { name: 'other' }] },
      emptyExisting,
      'self-agent',
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual([])
  })

  test('multi-group hits: skills + mcps + plugins', () => {
    const r = detectAgentDeps(
      'use playwright-runner skill, code-review-mcp tool, schema-validator plugin',
      {
        agents: [],
        skills: [{ name: 'playwright-runner' }],
        mcps: [{ name: 'code-review-mcp' }],
        plugins: [{ name: 'schema-validator' }],
      },
      emptyExisting,
      '',
    )
    expect(r.skills.candidates.map((c) => c.name)).toEqual(['playwright-runner'])
    expect(r.mcps.candidates.map((c) => c.name)).toEqual(['code-review-mcp'])
    expect(r.plugins.candidates.map((c) => c.name)).toEqual(['schema-validator'])
  })

  test('preserves inventory ordering for candidates', () => {
    const r = detectAgentDeps(
      'mentions c, then b, then a — but order should follow inventory',
      { agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
      emptyExisting,
      '',
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual(['a', 'b', 'c'])
  })

  test('inventory dupes → kept once, first occurrence', () => {
    const r = detectAgentDeps(
      'foo here',
      {
        agents: [
          { name: 'foo', description: 'first' },
          { name: 'foo', description: 'second' },
        ],
      },
      emptyExisting,
      '',
    )
    expect(r.agents.candidates).toHaveLength(1)
    expect(r.agents.candidates[0]?.description).toBe('first')
  })

  test('empty inventory name string → not matched (no includes("") degenerate hit)', () => {
    const r = detectAgentDeps(
      'any body',
      { agents: [{ name: '' }, { name: 'real' }] },
      emptyExisting,
      '',
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual([])
  })

  test('inventory.skills undefined (query failed) → skills group empty, others work', () => {
    const r = detectAgentDeps(
      'hit-agent here',
      { agents: [{ name: 'hit-agent' }], skills: undefined },
      emptyExisting,
      '',
    )
    expect(r.agents.candidates.map((c) => c.name)).toEqual(['hit-agent'])
    expect(r.skills.candidates).toEqual([])
  })

  test('case sensitive: body "Foo" vs inventory "foo" → no match', () => {
    const r = detectAgentDeps('Foo appears here', { agents: [{ name: 'foo' }] }, emptyExisting, '')
    expect(r.agents.candidates).toEqual([])
  })

  test('substring containment still matches: body "digit-validator-extra" hits "digit-validator"', () => {
    const r = detectAgentDeps(
      'see digit-validator-extra docs',
      { plugins: [{ name: 'digit-validator' }] },
      emptyExisting,
      '',
    )
    expect(r.plugins.candidates.map((c) => c.name)).toEqual(['digit-validator'])
  })

  test('selfName empty string + inventory empty-name → no degenerate matches', () => {
    const r = detectAgentDeps('any', { agents: [{ name: '' }, { name: 'x' }] }, emptyExisting, '')
    expect(r.agents.candidates.map((c) => c.name)).toEqual([])
  })
})
