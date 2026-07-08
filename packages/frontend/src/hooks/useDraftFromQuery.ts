// RFC-151 PR-4 — hydrate-once draft seeding for detail/edit pages.
//
// The resource detail pages keep a locally-editable draft that must seed
// exactly once from the fetched entity: React Query serves cached data first
// and refetches in the background, so a naive `useEffect(..., [data])` would
// clobber in-progress edits whenever the background refetch settles. Each
// page used to hand-roll the same `loaded` boolean + guard effect; this hook
// is that idiom, single-sourced.
//
// ## Stale-race contract (RFC-151 D3 — the hook does NOT manage caches)
//
// Because the draft seeds from whatever the query returns FIRST (usually the
// cache), any mutation that saves this draft MUST eagerly write its server
// response back into the query cache in `onSuccess` (`qc.setQueryData(...)`)
// — otherwise re-opening the page right after a save re-seeds from the stale
// cached row until the background refetch lands. The four resource detail
// pages already do this; the canonical worked example (incl. sibling list
// caches) is MemoryEditDialog's onSuccess eager-write block
// (src/components/memory/MemoryEditDialog.tsx:107-139). Keeping the eager
// write at the call site is deliberate: the hook cannot know which sibling
// caches hold copies, and hiding it here would obscure who owns cache
// consistency.
//
// ## Sister form
//
// `useMemoryFormState` (MemoryFormFields.tsx) covers the *dialog* variant of
// the same problem with a lazy useState initializer instead: its seed is a
// prop that is synchronously available at mount (the dialog remounts per
// entity), not an async query — so it needs no `loaded` gate and is NOT
// migrated onto this hook.
//
// `ready` gates multi-source pages: skills.detail seeds one draft from two
// queries (meta + content), passing `ready: content.data !== undefined` while
// `map` closes over the second source.

import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export interface UseDraftFromQueryResult<D> {
  /** undefined until the first successful seed. */
  draft: D | undefined
  setDraft: Dispatch<SetStateAction<D | undefined>>
  /** True once the draft seeded — gate Save buttons on it. */
  loaded: boolean
}

export function useDraftFromQuery<T, D>(
  data: T | undefined,
  map: (t: T) => D,
  opts?: { ready?: boolean },
): UseDraftFromQueryResult<D> {
  const [draft, setDraft] = useState<D | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const ready = opts?.ready ?? true

  useEffect(() => {
    if (!loaded && ready && data !== undefined) {
      setDraft(map(data))
      setLoaded(true)
    }
  }, [loaded, ready, data, map])

  return { draft, setDraft, loaded }
}
