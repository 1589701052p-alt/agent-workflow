// RFC-060 PR-A — parametric 'markdown' base kind handler. Passthrough.
// Sibling to outputKinds/markdown.ts under the new parametric registry.

import type { ParsedKind } from '../kindParser'
import type { ParametricOutputKindHandler } from './registry'

const handler: ParametricOutputKindHandler = {
  displayName: 'markdown',
  subReasons: new Set<string>(),
  matches: (p: ParsedKind) => p.kind === 'base' && p.name === 'markdown',
  baseNames: ['markdown'],
  carriesData: () => true,
  bulletSuffix: () => null,
  examplePlaceholder: () => '...',
  // RFC-080: a base 'markdown' port is a single reviewable document body.
  isReviewableBody: () => true,
  buildPromptGuidance: () => null,
  validate: (rawContent) => ({ ok: true, body: rawContent }),
  buildRepairBlock: () => null,
}

export default handler
