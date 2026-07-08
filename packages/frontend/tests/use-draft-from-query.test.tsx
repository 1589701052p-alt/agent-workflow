// RFC-151 PR-4 — useDraftFromQuery hydrate-once contract.
//
// The detail pages' draft must seed exactly once from the fetched entity:
// React Query hands back cached data first and refetches in the background,
// so re-seeding on every data change would clobber in-progress edits. Locks:
//   1. seeds via map(data) when data first arrives; loaded flips true.
//   2. NEVER re-seeds — later data changes (background refetch) leave both
//      the pristine draft and user edits alone.
//   3. `ready` gate defers the seed until a second source settles (skills'
//      meta + content pairing) — map runs only once both are in.
//
// The stale-race sibling contract (mutations must eagerly setQueryData in
// onSuccess) is documented on the hook and exercised by the page tests /
// memory-edit-dialog tests.

import { describe, expect, test } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { useDraftFromQuery } from '../src/hooks/useDraftFromQuery'

interface Entity {
  name: string
  description: string
}

interface HandleBox {
  current: ReturnType<typeof useDraftFromQuery<Entity, { description: string }>> | null
}

function Probe(props: {
  box: HandleBox
  data: Entity | undefined
  ready?: boolean
  map?: (e: Entity) => { description: string }
}) {
  const map = props.map ?? ((e: Entity) => ({ description: e.description }))
  const opts = props.ready === undefined ? undefined : { ready: props.ready }
  props.box.current = useDraftFromQuery(props.data, map, opts)
  return null
}

afterEach(cleanup)

describe('useDraftFromQuery', () => {
  test('seeds once when data arrives; loaded flips true', () => {
    const box: HandleBox = { current: null }
    const { rerender } = render(<Probe box={box} data={undefined} />)
    expect(box.current!.draft).toBeUndefined()
    expect(box.current!.loaded).toBe(false)

    rerender(<Probe box={box} data={{ name: 'a', description: 'from server' }} />)
    expect(box.current!.loaded).toBe(true)
    expect(box.current!.draft).toEqual({ description: 'from server' })
  })

  test('does NOT re-seed on later data changes (background refetch protection)', () => {
    const box: HandleBox = { current: null }
    const { rerender } = render(
      <Probe box={box} data={{ name: 'a', description: 'first fetch' }} />,
    )
    expect(box.current!.draft).toEqual({ description: 'first fetch' })

    // User edits the draft…
    act(() => box.current!.setDraft({ description: 'user edit' }))
    // …then the background refetch settles with different server data.
    rerender(<Probe box={box} data={{ name: 'a', description: 'refetched' }} />)
    expect(box.current!.draft).toEqual({ description: 'user edit' })
    expect(box.current!.loaded).toBe(true)
  })

  test('ready gate defers the seed until the second source settles', () => {
    const box: HandleBox = { current: null }
    const secondSource: { value?: string } = {}
    const map = (e: Entity) => ({
      description: `${e.description}+${secondSource.value ?? 'MISSING'}`,
    })

    const { rerender } = render(
      <Probe box={box} data={{ name: 'a', description: 'meta' }} ready={false} map={map} />,
    )
    // First source is in, but ready=false → still unseeded.
    expect(box.current!.loaded).toBe(false)
    expect(box.current!.draft).toBeUndefined()

    secondSource.value = 'content'
    rerender(<Probe box={box} data={{ name: 'a', description: 'meta' }} ready={true} map={map} />)
    // Seeded exactly when both sources were available — map saw the second one.
    expect(box.current!.loaded).toBe(true)
    expect(box.current!.draft).toEqual({ description: 'meta+content' })
  })
})
