// Unified inbox drawer open-state. Hoisted out of <RootComponent>'s local
// useState so call sites outside the root subtree (e.g. the Homepage's
// "Open Inbox" section link) can pop the drawer without prop-drilling.
//
// Same module-emitter + useSyncExternalStore pattern as stores/auth.ts —
// no global state library needed for a single boolean.

import { useSyncExternalStore } from 'react'

type Listener = () => void

let open = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

export function getInboxOpen(): boolean {
  return open
}

export function setInboxOpen(next: boolean): void {
  if (open === next) return
  open = next
  emit()
}

export function toggleInboxOpen(): void {
  setInboxOpen(!open)
}

export function subscribeInbox(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useInboxOpen(): boolean {
  return useSyncExternalStore(subscribeInbox, getInboxOpen, () => false)
}
