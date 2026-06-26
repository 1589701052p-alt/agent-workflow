// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.

import type { NormalizedEvent, RuntimeDriver } from '../types'
import { parseEvent } from './events'

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
}
