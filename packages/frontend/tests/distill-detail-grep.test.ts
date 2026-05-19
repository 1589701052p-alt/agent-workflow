// RFC-043 T7 — source-code level invariants for the distill job
// detail surface. Cheap regression guard against future refactors that
// silently break the contract.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf-8')
}

describe('RFC-043 grep guards', () => {
  test('MemoryDistillJobsTable still wires whole-row click to /memory/distill-jobs/$jobId', () => {
    const src = read('src/components/memory/MemoryDistillJobsTable.tsx')
    expect(src).toContain('/memory/distill-jobs/$jobId')
    expect(src).toContain('onClick')
    expect(src).toContain('e.stopPropagation()')
  })

  test('distill-job-detail components only reuse ConversationFlow via ConversationSection', () => {
    // RFC-027's ConversationFlow is the canonical session renderer.
    // We must NOT have a parallel hand-rolled renderer inside the
    // distill-job-detail folder — if a future PR adds one, this test
    // surfaces the divergence.
    const files = [
      'src/components/memory/distill-job-detail/DetailHeader.tsx',
      'src/components/memory/distill-job-detail/SourceEventsList.tsx',
      'src/components/memory/distill-job-detail/ScopeAndDedupSnapshot.tsx',
      'src/components/memory/distill-job-detail/CandidatesList.tsx',
      'src/components/memory/distill-job-detail/FailureDiagnostics.tsx',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, `${f} must not import ConversationFlow directly`).not.toContain(
        'ConversationFlow',
      )
    }
    const conv = read('src/components/memory/distill-job-detail/ConversationSection.tsx')
    expect(conv).toContain("from '@/components/node-session/ConversationFlow'")
  })
})
