// RFC-060 PR-A — parametric 'signal' base kind handler.
//
// `signal` is a control-flow-only output port: it carries NO data. The
// wrapper-fanout's auto-minted `__done__` port uses this kind, and any
// agent can declare a signal output to represent "I finished, downstream
// may start".
//
// Wire form: rawContent should be the empty string. If the agent writes
// anything, we drop it on the floor with a warning at PR-B-era runner /
// envelope hooks (PR-A just records `signal-non-empty` as a subReason
// that the runner can map into a warning log; we do NOT fail the run for
// this).
//
// Prompt template `{{<signal_port>}}` references are forbidden — but that
// check lives in the prompt template validator (PR-B T3), not here.
//
// PR-A scope: handler registered into PARAMETRIC_HANDLERS; AgentOutputKind
// schema does NOT yet whitelist 'signal' as a base name (PR-B adds it).
// In PR-A the only way to reach this handler is via direct test or via
// the wrapper-fanout `__done__` auto-mint path (also PR-D).

import type { ParsedKind } from '../kindParser'
import type { ParametricOutputKindHandler } from './registry'

const handler: ParametricOutputKindHandler = {
  displayName: 'signal',
  subReasons: new Set<string>(['signal-non-empty']),

  matches: (p: ParsedKind) => p.kind === 'base' && p.name === 'signal',

  buildPromptGuidance({ ports }) {
    if (ports.length === 0) return null
    const list = ports.map((p) => `\`${p}\``).join(', ')
    return (
      '\n' +
      `The following ports above are signal-only (${list}) — they carry NO data. ` +
      'Leave their `<port>` tag content empty. The framework treats these as ' +
      'control-flow markers: downstream nodes wait for you to finish, then read ' +
      'their data inputs from elsewhere.\n'
    )
  },

  validate(rawContent) {
    // Always "ok" — signal ports never fail the run. If the agent wrote
    // non-empty content, the body is normalized to empty string and a
    // soft subReason is attached for telemetry (consumer chooses whether
    // to log a warning).
    if (rawContent.trim().length === 0) {
      return { ok: true, body: '' }
    }
    // Non-empty content: still valid (ok: true), body forced to empty.
    // Callers that want to log the warning can detect this by comparing
    // rawContent vs result.body. PR-B may upgrade this to a structured
    // warning channel; PR-A keeps it as a soft passthrough.
    return { ok: true, body: '' }
  },

  buildRepairBlock: () => null,
}

export default handler
