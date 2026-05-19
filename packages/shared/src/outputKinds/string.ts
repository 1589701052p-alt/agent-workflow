// RFC-049 — `string` kind handler. Contract: no validation, no prompt guidance,
// no repair block. The legacy passthrough kind for free-form text ports.

import type { OutputKindHandler } from './types'

const handler: OutputKindHandler<'string'> = {
  kind: 'string',
  subReasons: new Set<string>(),
  buildPromptGuidance: () => null,
  validate: (rawContent) => ({ ok: true, body: rawContent }),
  buildRepairBlock: () => null,
}

export default handler
