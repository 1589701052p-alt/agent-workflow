// RFC-035 PR2 — source-level guard: the four retrofit components MUST
// use the shared `.tabs / .tabs__tab` chain with a `.tabs--<modifier>`,
// not the legacy bespoke class names. CSS for the legacy classes
// (.inspector__tabs, .agent-import__tabs, .repo-source-tabs__bar) is
// preserved as a visual fallback during the cleanup window.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const CASES: Array<{ file: string; modifier: string }> = [
  { file: 'components/NodeDetailDrawer.tsx', modifier: 'tabs--inspector' },
  { file: 'components/canvas/NodeInspector.tsx', modifier: 'tabs--inspector' },
  { file: 'components/AgentImportDialog.tsx', modifier: 'tabs--inline' },
  // RFC-066 PR-C: the path/url segmented tabs moved into `RepoSourceRow.tsx`
  // when the multi-repo container was carved out. RepoSourceTabs.tsx now
  // just delegates to RepoSourceRow inside the legacy `.repo-source-tabs`
  // wrapper, so the segment markup grep guard moved with the file.
  { file: 'components/launch/RepoSourceRow.tsx', modifier: 'tabs--segment' },
]

describe('RFC-035 .tabs retrofit grep guard', () => {
  for (const c of CASES) {
    test(`${c.file} uses .tabs.${c.modifier}`, () => {
      const body = readFileSync(path.resolve(SRC, c.file), 'utf8')
      expect(body.includes(c.modifier), `${c.file} missing ${c.modifier}`).toBe(true)
    })
  }

  test('the legacy class names are no longer in JSX className strings (CSS may still keep them)', () => {
    const bodies: Record<string, string> = {}
    for (const c of CASES) bodies[c.file] = readFileSync(path.resolve(SRC, c.file), 'utf8')
    // `Record<string,string>` index access reads as possibly-undefined
    // under strict TS even though we just populated the map above; `!` is
    // the minimal nudge to satisfy the compiler without changing runtime
    // behaviour.
    expect(bodies['components/NodeDetailDrawer.tsx']!.includes('inspector__tabs"')).toBe(false)
    expect(bodies['components/canvas/NodeInspector.tsx']!.includes('inspector__tabs"')).toBe(false)
    // AgentImportDialog: only the tabs block was retrofitted; other
    // namespaced .agent-import__* class names survive (cleanup PR will
    // remove them once the <Dialog> retrofit lands in PR3).
    expect(bodies['components/AgentImportDialog.tsx']!.includes('agent-import__tabs')).toBe(false)
    expect(bodies['components/AgentImportDialog.tsx']!.includes('agent-import__tab"')).toBe(false)
    // RepoSourceTabs (now a thin wrapper) + RepoSourceRow (the body, post
    // RFC-066 PR-C extraction): outer wrapper class .repo-source-tabs
    // still exists so legacy CSS rules keep working; the bar + tab class
    // names are gone from BOTH files.
    expect(bodies['components/launch/RepoSourceRow.tsx']!.includes('repo-source-tabs__bar')).toBe(
      false,
    )
    expect(bodies['components/launch/RepoSourceRow.tsx']!.includes('repo-source-tabs__tab')).toBe(
      false,
    )
  })
})
