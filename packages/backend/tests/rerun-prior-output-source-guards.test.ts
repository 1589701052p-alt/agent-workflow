// RFC-119 — source-text regression guards for the scheduler wiring.
//
// The scheduler injection point lives inside a multi-thousand-line function that
// is impractical to drive end-to-end here, so these textual locks back-stop the
// behavioral tests:
//   - the generalized prior-output computation keeps ALL THREE skip gates
//     (cross-clarify ownership / inline-resume / mandatory ask-back). Deleting
//     any one silently regresses double-injection or stale-context injection.
//   - priorDoneGenerationsForRun stays `done`-only. RFC-119 deliberately did NOT
//     relax it (that would let review-supersede canceled rows inflate the clarify
//     generation count); the broad lookup is the SEPARATE freshestPriorRunWithOutput.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCHEDULER_SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
  'utf8',
)

describe('RFC-119 — scheduler source guards', () => {
  test('the broad selector exists and is exported', () => {
    expect(SCHEDULER_SRC).toContain('export async function freshestPriorRunWithOutput')
    expect(SCHEDULER_SRC).toContain('export async function composePriorOutputBlock')
  })

  test('generalized priorOutputUpdate computation keeps all three skip gates', () => {
    // RFC-132 (PR-C): the cross-clarify-specific prior-output block (crossClarifyContext.
    // priorOutputBlock) was removed — a designer responding to feedback now surfaces its working
    // draft through THIS single generalized path. The three skip gates are now: a pure-override
    // DESIGNER handoff (suppressPriorOutput — RFC-120 §18: process the reassigned question, don't
    // rewrite your own artifact), inline session resume, and mandatory ask-back. Isolate the block
    // from the priorOutputUpdate declaration to the dispatch site.
    const start = SCHEDULER_SRC.indexOf('let priorOutputUpdate:')
    expect(start).toBeGreaterThan(-1)
    const region = SCHEDULER_SRC.slice(start, start + 900)
    expect(region).toContain('!suppressPriorOutput')
    expect(region).toContain('!resumeDecision.inlineMode')
    expect(region).toContain('!effectiveHasClarifyChannel')
    expect(region).toContain('freshestPriorRunWithOutput')
    // The generation-only isCrossClarifyTriggeredRerun proxy stays GONE (Codex impl gate P2), and
    // the removed cross-clarify ownership signal must not linger either.
    expect(region).not.toContain('!isCrossClarifyTriggeredRerun')
    expect(region).not.toContain('crossClarifyOwnsPriorOutput')
  })

  test('priorDoneGenerationsForRun stays done-only (must NOT be widened)', () => {
    const start = SCHEDULER_SRC.indexOf('async function priorDoneGenerationsForRun')
    expect(start).toBeGreaterThan(-1)
    const region = SCHEDULER_SRC.slice(start, start + 700)
    expect(region).toContain("eq(nodeRuns.status, 'done')")
  })
})
