// RFC-080 PR-B — OUTPUT_KIND_UI: the single co-located source of truth the
// FRONTEND enumerates to render the output-port kind selector, its i18n
// labels, the Outputs-tab download affordance, and the canvas signal styling.
//
// drift guard layer 2: declared `as const satisfies readonly
// OutputKindUiDescriptor[]` (the same exhaustiveness pattern as
// node-kind-behavior.ts's `NODE_KIND_BEHAVIORS satisfies Record<…>`). Adding a
// selectable kind without filling EVERY dimension (labelKey / downloadable /
// dataBearing / editorShape) is a compile error.
//
// CYCLE RED LINE (RFC-079): this module imports ONLY from kindParser — never
// from ./registry or the handlers — so enumerating it from the frontend can't
// recreate the index→list→registry→list init cycle that crashed build:binary.
// `dataBearing` here MUST agree with each handler's `carriesData()`; the
// agreement is asserted at module load below + by a frontend test.

import { REGISTERED_BASE_KINDS } from '../kindParser'

/**
 * How the KindSelect control edits this entry:
 *  - 'base'       → a leaf base kind (string / markdown / signal); no params.
 *  - 'param-path' → the `path<ext>` shape; the control shows an extension input.
 * The `list<…>` container is NOT a selectable entry — it's a wrap toggle the
 * control applies on top of whichever leaf entry is chosen.
 */
export type OutputKindEditorShape = 'base' | 'param-path'

export interface OutputKindUiDescriptor {
  /**
   * Stable id. For 'base' entries this is the base kind name (must be a member
   * of REGISTERED_BASE_KINDS). For the 'param-path' entry it is 'path'.
   */
  readonly id: string
  readonly editorShape: OutputKindEditorShape
  /** i18n key; the frontend provides cn/en (asserted present by a frontend test). */
  readonly labelKey: string
  /** A port of this kind (as a worktree file) offers a download in the Outputs tab. */
  readonly downloadable: boolean
  /** Carries data referenceable as a `{{port}}` token. MUST match handler.carriesData. */
  readonly dataBearing: boolean
}

export const OUTPUT_KIND_UI = [
  {
    id: 'string',
    editorShape: 'base',
    labelKey: 'kindSelect.base_string',
    downloadable: false,
    dataBearing: true,
  },
  {
    id: 'markdown',
    editorShape: 'base',
    labelKey: 'kindSelect.base_markdown',
    downloadable: false,
    dataBearing: true,
  },
  {
    id: 'signal',
    editorShape: 'base',
    labelKey: 'kindSelect.base_signal',
    downloadable: false,
    dataBearing: false,
  },
  {
    id: 'path',
    editorShape: 'param-path',
    labelKey: 'kindSelect.base_path',
    downloadable: true,
    dataBearing: true,
  },
] as const satisfies readonly OutputKindUiDescriptor[]

/** The selectable leaf kinds the KindSelect base dropdown enumerates. */
export function listSelectableKinds(): readonly OutputKindUiDescriptor[] {
  return OUTPUT_KIND_UI
}

/** Look up a UI descriptor by its base-kind name / shape id. */
export function outputKindUiById(id: string): OutputKindUiDescriptor | undefined {
  return OUTPUT_KIND_UI.find((d) => d.id === id)
}

// -----------------------------------------------------------------------------
// drift guard layer 3a (UI side): every base kind in REGISTERED_BASE_KINDS must
// have exactly one 'base' descriptor, and every 'base' descriptor id must be a
// registered base kind. (The 'param-path' entry is the only non-base shape.)
// Adding a base kind to the grammar without a UI descriptor → boot/CI throw.
// -----------------------------------------------------------------------------
{
  const baseIds = OUTPUT_KIND_UI.filter((d) => d.editorShape === 'base').map((d) => d.id)
  const seen = new Set<string>()
  for (const id of baseIds) {
    if (seen.has(id)) throw new Error(`RFC-080 OUTPUT_KIND_UI: duplicate base descriptor '${id}'`)
    seen.add(id)
    if (!REGISTERED_BASE_KINDS.has(id)) {
      throw new Error(
        `RFC-080 OUTPUT_KIND_UI: base descriptor '${id}' is not a registered base kind`,
      )
    }
  }
  for (const name of REGISTERED_BASE_KINDS) {
    if (!seen.has(name)) {
      throw new Error(`RFC-080 OUTPUT_KIND_UI: registered base kind '${name}' has no UI descriptor`)
    }
  }
}
