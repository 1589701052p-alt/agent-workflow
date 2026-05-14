// WebSocket server adapter for Bun.serve().
//
// Bun's WebSocket API splits work between `fetch` (does `server.upgrade()`)
// and `websocket` handlers (open/message/close). This module exposes
// `buildWebSocketAdapter(deps)` which returns both, so the daemon entry point
// stays a thin shim around `Bun.serve({ fetch, websocket })`.
//
// Channels:
//   /ws/tasks/{taskId}    — single-task detail; `?since=N` replays events
//   /ws/tasks             — task list
//   /ws/workflows         — workflow list + editor multi-tab sync
//
// Token auth: `?token=` matches AppDeps.token exactly (constant-time).
//
// On open, the server emits a `hello` control frame so the client knows the
// subscription is live.

import type {
  TaskWsMessage,
  TasksListWsMessage,
  WorkflowsWsMessage,
  WsControlMessage,
} from '@agent-workflow/shared'
import type { ServerWebSocket } from 'bun'
import { and, eq, gt, asc } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { createLogger } from '@/util/log'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  WORKFLOWS_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
  workflowsBroadcaster,
} from './broadcaster'

const log = createLogger('ws.server')

interface ConnectionData {
  channel:
    | { kind: 'task'; taskId: string; since?: number }
    | { kind: 'tasks-list' }
    | { kind: 'workflows' }
  unsubscribe: () => void
}

export interface WebSocketAdapterDeps {
  token: string
  db: DbClient
}

export interface WebSocketAdapter {
  /**
   * Try to upgrade a WebSocket request. Returns true if handled (caller
   * should return without producing a Response), false if the request isn't
   * a WS endpoint at all, or a Response to send back when the upgrade is
   * refused (bad token, unknown channel, etc.).
   */
  tryUpgrade(req: Request, server: { upgrade: BunUpgradeFn }): true | false | Response

  /**
   * Bun.serve `websocket` handler tree. Pass directly to Bun.serve().
   */
  handlers: {
    open(ws: ServerWebSocket<ConnectionData>): void | Promise<void>
    close(ws: ServerWebSocket<ConnectionData>): void
    message(ws: ServerWebSocket<ConnectionData>, msg: string | Buffer): void
  }
}

type BunUpgradeFn = (req: Request, opts: { data: ConnectionData }) => boolean

const WS_PATH_RE = {
  task: /^\/ws\/tasks\/([^/?#]+)$/,
  list: /^\/ws\/tasks$/,
  flows: /^\/ws\/workflows$/,
}

export function buildWebSocketAdapter(deps: WebSocketAdapterDeps): WebSocketAdapter {
  function parseChannel(url: URL): ConnectionData['channel'] | null {
    const m = WS_PATH_RE.task.exec(url.pathname)
    if (m !== null) {
      const ch: ConnectionData['channel'] = {
        kind: 'task',
        taskId: decodeURIComponent(m[1] ?? ''),
      }
      const since = url.searchParams.get('since')
      if (since !== null && since !== '' && Number.isInteger(Number(since))) {
        ch.since = Number(since)
      }
      return ch
    }
    if (WS_PATH_RE.list.test(url.pathname)) return { kind: 'tasks-list' }
    if (WS_PATH_RE.flows.test(url.pathname)) return { kind: 'workflows' }
    return null
  }

  function tryUpgrade(req: Request, server: { upgrade: BunUpgradeFn }): true | false | Response {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/ws/')) return false
    const channel = parseChannel(url)
    if (channel === null) {
      return new Response(
        JSON.stringify({ error: { code: 'ws-unknown-channel', message: 'unknown ws channel' } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const queryToken = url.searchParams.get('token')
    if (queryToken === null || !timingSafeEquals(queryToken, deps.token)) {
      return new Response(
        JSON.stringify({ error: { code: 'auth-required', message: 'invalid or missing token' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const data: ConnectionData = {
      channel,
      unsubscribe: () => {
        /* set on open */
      },
    }
    const ok = server.upgrade(req, { data })
    if (!ok) {
      return new Response('upgrade-failed', { status: 426 })
    }
    return true
  }

  async function handleOpen(ws: ServerWebSocket<ConnectionData>): Promise<void> {
    const ch = ws.data.channel
    log.debug('open', { channel: ch })
    let hello: WsControlMessage

    switch (ch.kind) {
      case 'task': {
        const channelKey = TASK_CHANNEL(ch.taskId)
        ws.data.unsubscribe = taskBroadcaster.subscribe(channelKey, (msg: TaskWsMessage) => {
          safeSend(ws, msg)
        })
        hello = { type: 'hello', channel: `tasks/${ch.taskId}` }
        if (ch.since !== undefined) hello.since = ch.since
        safeSend(ws, hello)
        if (ch.since !== undefined) {
          await replayTaskEvents(deps.db, ch.taskId, ch.since, ws)
        }
        return
      }
      case 'tasks-list': {
        ws.data.unsubscribe = tasksListBroadcaster.subscribe(
          TASKS_LIST_CHANNEL,
          (msg: TasksListWsMessage) => safeSend(ws, msg),
        )
        safeSend(ws, { type: 'hello', channel: 'tasks' } satisfies WsControlMessage)
        return
      }
      case 'workflows': {
        ws.data.unsubscribe = workflowsBroadcaster.subscribe(
          WORKFLOWS_CHANNEL,
          (msg: WorkflowsWsMessage) => safeSend(ws, msg),
        )
        safeSend(ws, { type: 'hello', channel: 'workflows' } satisfies WsControlMessage)
        return
      }
    }
  }

  function handleClose(ws: ServerWebSocket<ConnectionData>): void {
    try {
      ws.data.unsubscribe()
    } catch (err) {
      log.warn('unsubscribe threw', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function handleMessage(_ws: ServerWebSocket<ConnectionData>, _msg: string | Buffer): void {
    // v1: clients are read-only on these channels. Ignore inbound frames.
  }

  return {
    tryUpgrade,
    handlers: {
      open: handleOpen,
      close: handleClose,
      message: handleMessage,
    },
  }
}

async function replayTaskEvents(
  db: DbClient,
  taskId: string,
  since: number,
  ws: ServerWebSocket<ConnectionData>,
): Promise<void> {
  // node_run_events is per-node-run; join via nodeRuns.taskId.
  const rows = await db
    .select({
      id: nodeRunEvents.id,
      nodeRunId: nodeRunEvents.nodeRunId,
      ts: nodeRunEvents.ts,
      kind: nodeRunEvents.kind,
      payload: nodeRunEvents.payload,
    })
    .from(nodeRunEvents)
    .innerJoin(nodeRuns, eq(nodeRunEvents.nodeRunId, nodeRuns.id))
    .where(and(eq(nodeRuns.taskId, taskId), gt(nodeRunEvents.id, since)))
    .orderBy(asc(nodeRunEvents.id))

  for (const r of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = r.payload
    }
    const msg: TaskWsMessage = {
      id: r.id,
      type: 'node.event',
      nodeRunId: r.nodeRunId,
      ts: r.ts,
      kind: r.kind,
      payload,
    }
    safeSend(ws, msg)
  }
}

function safeSend(
  ws: ServerWebSocket<ConnectionData>,
  msg: TaskWsMessage | TasksListWsMessage | WorkflowsWsMessage | WsControlMessage,
): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch (err) {
    log.warn('send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
