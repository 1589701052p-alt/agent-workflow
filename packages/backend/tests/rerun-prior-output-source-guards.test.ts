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
    // Isolate the block from the ownership-signal declaration to the dispatch site.
    const start = SCHEDULER_SRC.indexOf('const crossClarifyOwnsPriorOutput')
    expect(start).toBeGreaterThan(-1)
    const region = SCHEDULER_SRC.slice(start, start + 1600)
    // Codex impl gate P2: the cross-clarify skip MUST key on actual prior-output
    // ownership (crossClarifyContext.priorOutputBlock), NOT the generation-only
    // isCrossClarifyTriggeredRerun proxy.
    expect(region).toContain('crossClarifyContext?.priorOutputBlock')
    expect(region).toContain('!crossClarifyOwnsPriorOutput')
    expect(region).not.toContain('!isCrossClarifyTriggeredRerun')
    expect(region).toContain('!resumeDecision.inlineMode')
    expect(region).toContain('!effectiveHasClarifyChannel')
    expect(region).toContain('freshestPriorRunWithOutput')
  })

  test('priorDoneGenerationsForRun stays done-only (must NOT be widened)', () => {
    const start = SCHEDULER_SRC.indexOf('async function priorDoneGenerationsForRun')
    expect(start).toBeGreaterThan(-1)
    const region = SCHEDULER_SRC.slice(start, start + 700)
    expect(region).toContain("eq(nodeRuns.status, 'done')")
  })
})
