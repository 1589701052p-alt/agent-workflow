// Generic JSON-WebSocket subscription hook.
//
// RFC-152 (D5) — sockets are SHARED per path: a module-level connection
// manager keeps one physical WebSocket per path with a refcount of hook
// mounts. Every listener on that path receives every JSON message, so two
// hooks subscribing to the same `/ws/tasks/{id}` (e.g. useTaskSync +
// useClarifyWs on a clarify detail page, or reviews.detail's task sync) ride
// ONE connection instead of two. The last unmount closes the socket.
//
// Reconnects with exponential-backoff up to 30s while at least one
// subscriber is mounted. Token + baseUrl are read from the auth store on
// each (re)connect so re-login refreshes the connection. Messages are routed
// to the listeners after JSON-parse; non-JSON frames are silently dropped.

import { useEffect, useRef } from 'react'
import { getBaseUrl, getToken } from '@/stores/auth'

type Listener = (msg: unknown) => void

export interface UseWebSocketOptions {
  /** Path on the daemon, e.g. `/ws/workflows` or `/ws/tasks/01XYZ`. */
  path: string
  /** Receives every JSON message. */
  onMessage: Listener
  /** When false the connection is torn down (useful when no taskId yet). */
  enabled?: boolean
}

const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

// -----------------------------------------------------------------------------
// Shared connection manager (module scope). One entry per live path.
// -----------------------------------------------------------------------------

interface SharedConn {
  path: string
  listeners: Set<Listener>
  socket: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  backoff: number
  /** Flipped when the last subscriber releases — no further reconnects. */
  stopped: boolean
}

const sharedConns = new Map<string, SharedConn>()

/**
 * Register `listener` on the shared connection for `path`, creating the
 * connection when it's the first subscriber. Returns a release fn; the last
 * release tears the socket down (timers cancelled, no reconnect).
 */
function acquireSharedConn(path: string, listener: Listener): () => void {
  let conn = sharedConns.get(path)
  if (conn === undefined) {
    conn = {
      path,
      listeners: new Set(),
      socket: null,
      reconnectTimer: null,
      backoff: BASE_BACKOFF_MS,
      stopped: false,
    }
    sharedConns.set(path, conn)
    connect(conn)
  }
  conn.listeners.add(listener)
  const acquired = conn
  let released = false
  return () => {
    if (released) return
    released = true
    acquired.listeners.delete(listener)
    if (acquired.listeners.size > 0) return
    acquired.stopped = true
    sharedConns.delete(path)
    if (acquired.reconnectTimer !== null) clearTimeout(acquired.reconnectTimer)
    closeSocket(acquired.socket)
    acquired.socket = null
  }
}

function connect(conn: SharedConn): void {
  if (conn.stopped) return
  const token = getToken()
  if (token === null) {
    // No token → don't churn; we'll retry once the user logs in.
    conn.reconnectTimer = setTimeout(() => connect(conn), 2000)
    return
  }
  const url = wsUrl(conn.path, token)
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    scheduleReconnect(conn)
    return
  }
  conn.socket = ws
  ws.addEventListener('message', (e) => {
    let msg: unknown
    try {
      msg = JSON.parse(String(e.data))
    } catch {
      return /* ignore non-JSON frames */
    }
    // Snapshot so a listener that (un)subscribes mid-dispatch doesn't mutate
    // the live set; swallow listener throws so one bad subscriber can't
    // starve its siblings on the shared socket (the pre-share hook swallowed
    // its own listener's throw the same way).
    for (const l of [...conn.listeners]) {
      try {
        l(msg)
      } catch {
        /* ignore listener errors */
      }
    }
  })
  ws.addEventListener('open', () => {
    conn.backoff = BASE_BACKOFF_MS
  })
  ws.addEventListener('close', () => {
    if (conn.socket === ws) conn.socket = null
    scheduleReconnect(conn)
  })
  ws.addEventListener('error', () => {
    // The close handler will fire next and reschedule.
  })
}

function scheduleReconnect(conn: SharedConn): void {
  if (conn.stopped) return
  const wait = Math.min(conn.backoff, MAX_BACKOFF_MS)
  conn.backoff = Math.min(conn.backoff * 2, MAX_BACKOFF_MS)
  conn.reconnectTimer = setTimeout(() => connect(conn), wait)
}

export function useWebSocket({ path, onMessage, enabled = true }: UseWebSocketOptions): void {
  // Latest-listener ref so we don't resubscribe every render when the caller
  // passes an inline arrow function.
  const listenerRef = useRef<Listener>(onMessage)
  useEffect(() => {
    listenerRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    if (!enabled) return
    return acquireSharedConn(path, (msg) => listenerRef.current(msg))
  }, [path, enabled])
}

// `readyState === 0` is CONNECTING per the WebSocket spec; hard-coded to
// keep us off `WebSocket.CONNECTING`, which is undefined in vitest's jsdom
// mock WebSocket and used to crash every ws hook test with "Cannot read
// properties of undefined (reading 'CONNECTING')".
const WS_CONNECTING = 0

function closeSocket(ws: WebSocket | null): void {
  if (ws === null) return
  // Closing a CONNECTING socket triggers a browser warning ("WebSocket is
  // closed before the connection is established"). React StrictMode's
  // double-invoke of effects in dev hits this on every mount. Defer the
  // close until the handshake finishes so the warning stays silent; the
  // conn's `stopped` flag keeps the eventual close handler from reconnecting.
  if (ws.readyState === WS_CONNECTING) {
    ws.addEventListener('open', () => ws.close(), { once: true })
  } else {
    ws.close()
  }
}

function wsUrl(path: string, token: string): string {
  const base = getBaseUrl()
  const u = new URL(path, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('token', token)
  return u.toString()
}
