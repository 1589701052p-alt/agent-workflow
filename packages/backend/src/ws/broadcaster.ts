// Process-local pub/sub for WebSocket fan-out. Services call
// `broadcast(channel, message)`; the WS server adapter subscribes a callback
// per connected client. Synchronous + best-effort: a slow consumer doesn't
// block other consumers. A single daemon process means no cross-process
// bus is needed.

import { createLogger } from '@/util/log'

const log = createLogger('ws.broadcaster')

export type ChannelKey = string

type Listener<M> = (msg: M) => void

class TypedBroadcaster<M> {
  private subs = new Map<ChannelKey, Set<Listener<M>>>()

  subscribe(channel: ChannelKey, listener: Listener<M>): () => void {
    let set = this.subs.get(channel)
    if (set === undefined) {
      set = new Set()
      this.subs.set(channel, set)
    }
    set.add(listener)
    return () => {
      const s = this.subs.get(channel)
      if (s === undefined) return
      s.delete(listener)
      if (s.size === 0) this.subs.delete(channel)
    }
  }

  broadcast(channel: ChannelKey, msg: M): void {
    const set = this.subs.get(channel)
    if (set === undefined) return
    for (const listener of set) {
      try {
        listener(msg)
      } catch (err) {
        log.warn('listener threw', {
          channel,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** Test helper. */
  subscriberCount(channel: ChannelKey): number {
    return this.subs.get(channel)?.size ?? 0
  }

  /** Test helper. */
  reset(): void {
    this.subs.clear()
  }
}

// One broadcaster per logical channel namespace; each has its own message
// type. Each channel name is stored as a string with the path prefix baked
// in to avoid taskId/workflowId collisions.

export const TASK_CHANNEL = (taskId: string): ChannelKey => `task:${taskId}`
export const TASKS_LIST_CHANNEL: ChannelKey = 'tasks-list'
export const WORKFLOWS_CHANNEL: ChannelKey = 'workflows'
/** RFC-033: per-batch progress channel for `/repos` batch import. */
export const REPO_IMPORT_CHANNEL = (batchId: string): ChannelKey => `repo-import:${batchId}`

import type {
  RepoImportWsMessage,
  TaskWsMessage,
  TasksListWsMessage,
  WorkflowsWsMessage,
} from '@agent-workflow/shared'

export const taskBroadcaster = new TypedBroadcaster<TaskWsMessage>()
export const tasksListBroadcaster = new TypedBroadcaster<TasksListWsMessage>()
export const workflowsBroadcaster = new TypedBroadcaster<WorkflowsWsMessage>()
export const repoImportsBroadcaster = new TypedBroadcaster<RepoImportWsMessage>()

/** Reset all broadcasters — only used in tests between cases. */
export function resetBroadcastersForTests(): void {
  taskBroadcaster.reset()
  tasksListBroadcaster.reset()
  workflowsBroadcaster.reset()
  repoImportsBroadcaster.reset()
}
