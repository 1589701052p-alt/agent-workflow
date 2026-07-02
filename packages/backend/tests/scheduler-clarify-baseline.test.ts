// RFC-058 PR-A baseline (T5): source-text lock of scheduler clarify-injection routing.
//
// The per-role service-call baselines (buildClarifyPromptContext / buildExternalFeedbackContext /
// buildQuestionerCrossClarifyContext) were retired with those injectors (RFC-132 PR-C unified them
// into buildClarifyQueueContext, PR-E1 deleted the dead injectors). The surviving lock is the
// scheduler source-grep guard below: it fails red if the dispatch routing drifts back to a per-role
// consumerKind fork or re-introduces the removed history cutoff.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

describe('RFC-058 baseline T5 — scheduler dispatch gate grep guards', () => {
  test('source grep: scheduler routes clarify injection through the unified buildClarifyQueueContext (RFC-132 PR-C)', async () => {
    const fs = await import('node:fs/promises')
    const txt = await fs.readFile(
      resolve(import.meta.dir, '..', '..', '..', 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    // RFC-132 (PR-C): the per-role buildPromptContext consumerKind dispatch (+ the questioner SELECT
    // fork) is replaced by the single flat injector — selectAgentQueue queries self/questioner/designer
    // in one shot.
    expect(txt).toContain('await buildClarifyQueueContext(')
    expect(txt).not.toContain('await buildPromptContext(')
    expect(txt).not.toContain("consumerKind: 'cross-questioner'")
    expect(txt).not.toContain('isQuestionerCrossClarifyRerun')
    // RFC-070: `historyCutoffClarifyIteration` deleted; row-state aging
    // replaces iteration cutoff.
    expect(txt).not.toContain('historyCutoffClarifyIteration')
  })
})
