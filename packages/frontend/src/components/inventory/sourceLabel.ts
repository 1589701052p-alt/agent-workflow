// RFC-029: shared source-string → i18n key resolver. Pulled out so all
// four tables share a single translation contract.

import type { TFunction } from 'i18next'

const KNOWN = new Set(['inline', 'project', 'global', 'native', 'unknown'])

export function sourceLabel(source: string, t: TFunction): string {
  if (KNOWN.has(source)) {
    return t(`nodeDrawer.inventory.source.${source}`)
  }
  // Verbatim fallback keeps forward-compat with future opencode source kinds.
  return source
}
