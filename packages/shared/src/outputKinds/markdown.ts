// RFC-049 — `markdown` kind handler. Same contract as `string` for now:
// passthrough, no validation, no prompt guidance, no repair block. Reserved
// in case future tooling wants to surface markdown-specific guidance (e.g.
// linting hints) without conflating with the plain-text kind.

import type { OutputKindHandler } from './types'

const handler: OutputKindHandler<'markdown'> = {
  kind: 'markdown',
  subReasons: new Set<string>(),
  buildPromptGuidance: () => null,
  validate: (rawContent) => ({ ok: true, body: rawContent }),
  buildRepairBlock: () => null,
}

export default handler
