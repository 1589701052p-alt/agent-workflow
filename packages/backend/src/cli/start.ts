// `agent-workflow start` — daemon foreground entry.
// P-1-01 scaffold: acquires single-instance lock, starts a minimal HTTP server,
// handles graceful shutdown. Token middleware (P-1-02), config (P-1-03), real
// routes (P-1-08+), DB migration (P-0-05 wired here later), and 30s graceful
// shutdown of subprocesses (P-4-06) all build on top.

import { type Lock, acquireLock, DaemonLockHeldError } from '@/util/lock'
import { Paths } from '@/util/paths'

export interface StartOptions {
  /** Override bind port. 0 = random. Default: random. */
  port?: number
  /** Override bind host. Default: 127.0.0.1. */
  host?: string
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
  let lock: Lock
  try {
    lock = acquireLock(Paths.lock)
  } catch (err) {
    if (err instanceof DaemonLockHeldError) {
      console.error(`agent-workflow: another daemon is already running (PID ${err.pid})`)
      console.error(`  lock file: ${err.lockPath}`)
      console.error(`  if it is stale, remove the lock file manually and try again`)
      process.exit(1)
    }
    throw err
  }

  console.log(`[agent-workflow] daemon starting (pid ${lock.pid})`)
  console.log(`[agent-workflow] lock file: ${lock.path}`)

  // Minimal HTTP server. Real Hono app + token middleware land in P-1-02.
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.host ?? '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/api/health') {
        return Response.json({ ok: true, scaffold: 'P-1-01', pid: lock.pid })
      }
      return new Response('not found', { status: 404 })
    },
  })

  console.log(`[agent-workflow] listening at http://${server.hostname}:${server.port}/`)
  console.log(`[agent-workflow] (token / real routes wire up in P-1-02+)`)

  // Graceful shutdown on signals.
  // Full 30s graceful subprocess shutdown is P-4-06; here we just close the
  // HTTP server and release the lock.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[agent-workflow] received ${signal}, shutting down`)
    server.stop(true)
    lock.release()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  // Defensive — release if we crash for any reason.
  process.on('exit', () => lock.release())

  // Block forever; Bun.serve keeps the event loop alive on its own, but the
  // explicit await makes the start() Promise observable to callers/tests.
  await new Promise<void>(() => {
    /* never resolves; signal handlers exit the process */
  })
}
