// `agent-workflow start` — daemon foreground entry.

import { ensureTokenFile } from '@/auth/token'
import { loadConfig } from '@/config'
import { openDb } from '@/db/client'
import { createApp } from '@/server'
import { startLimitsTicker } from '@/services/limits'
import { reapOrphanRuns } from '@/services/orphans'
import { startEventsArchiver } from '@/services/eventsArchive'
import { startWorktreeGc } from '@/services/gc'
import { acquireLock, DaemonLockHeldError, type Lock } from '@/util/lock'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { MIN_OPENCODE_VERSION, probeOpencode } from '@/util/opencode'
import { Paths } from '@/util/paths'
import { buildWebSocketAdapter } from '@/ws/server'
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'

export interface StartOptions {
  port?: number
  host?: string
}

export async function startCommand(opts: StartOptions = {}): Promise<void> {
  // 1. Logger — must come before lock so failures land in stdout/file.
  configureLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    logFile: Paths.daemonLog,
  })
  const log = createLogger('daemon')

  // 2. Single-instance lock.
  let lock: Lock
  try {
    lock = acquireLock(Paths.lock)
  } catch (err) {
    if (err instanceof DaemonLockHeldError) {
      log.error('another daemon is already running', { pid: err.pid, lock: err.lockPath })
      console.error(
        `agent-workflow: another daemon is already running (PID ${err.pid})\n` +
          `  lock file: ${err.lockPath}\n` +
          `  if it is stale, remove the lock file manually and try again`,
      )
      process.exit(1)
    }
    throw err
  }
  log.info('lock acquired', { pid: lock.pid, lock: lock.path })

  // 3. Load config; honor logLevel if user set non-default in config.
  const config = loadConfig(Paths.config)
  if (config.logLevel !== 'info') {
    configureLogger({ level: config.logLevel })
  }
  log.info('config loaded', { path: Paths.config, language: config.language, theme: config.theme })

  // 4. opencode version probe — daemon refuses to start on incompatible version.
  const probe = await probeOpencode(config.opencodePath)
  if (probe.version === null) {
    log.error('opencode binary not found or unreadable', { binary: probe.binary })
    console.error(
      `agent-workflow: cannot execute "${probe.binary}".\n` +
        `  install opencode (>=${MIN_OPENCODE_VERSION}) and ensure it is on PATH,\n` +
        `  or set 'opencodePath' in ${Paths.config}.`,
    )
    lock.release()
    process.exit(1)
  }
  if (!probe.compatible) {
    log.error('opencode too old', { found: probe.version, required: MIN_OPENCODE_VERSION })
    console.error(
      `agent-workflow: opencode ${probe.version} is older than the required ${MIN_OPENCODE_VERSION}.\n` +
        `  run "opencode upgrade" or set 'opencodePath' to a newer binary.`,
    )
    lock.release()
    process.exit(1)
  }
  log.info('opencode probe ok', { version: probe.version, binary: probe.binary })

  // 5. DB — open + apply migrations. dbVersion = number of SQL files in the
  // bundled migrations folder (== the highest version we've applied, since
  // openDb() applies all pending migrations on startup).
  const db = openDb({ path: Paths.db, migrationsFolder: Paths.migrationsDir })
  const dbVersion = existsSync(Paths.migrationsDir)
    ? readdirSync(Paths.migrationsDir).filter((f) => f.endsWith('.sql')).length
    : 0
  log.info('db ready', { path: Paths.db, dbVersion })

  // 5b. P-4-07: reap orphan runs from the previous (crashed/SIGKILLed) daemon
  // process. Any task/node_run left in 'running' is flipped to 'interrupted'
  // with task.error_message = 'daemon-restart' so the UI surfaces what
  // happened.
  try {
    const reap = await reapOrphanRuns(db)
    if (reap.tasks > 0 || reap.runs > 0) {
      log.warn('reaped orphan runs from previous daemon', {
        tasks: reap.tasks,
        runs: reap.runs,
      })
    }
  } catch (err) {
    log.warn('orphan reap failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // 6. Token (generate-on-first-run, chmod 600).
  const token = ensureTokenFile(Paths.tokenFile)
  log.info('token ready', { tokenFile: Paths.tokenFile })

  // 7. HTTP server.
  const app = createApp({
    token,
    configPath: Paths.config,
    opencodeVersion: probe.version,
    dbVersion,
    db,
  })

  const bindHost = opts.host ?? config.bindHost
  const bindPort = opts.port ?? config.bindPort ?? 0
  const ws = buildWebSocketAdapter({ token, db })
  const server = Bun.serve({
    port: bindPort,
    hostname: bindHost,
    fetch(req, srv) {
      const upgraded = ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded !== false) return upgraded
      return app.fetch(req)
    },
    websocket: ws.handlers,
  })

  const baseUrl = `http://${server.hostname}:${server.port}/`
  log.info('listening', { url: baseUrl })

  // Write runtime info file for `status` / `stop` subcommands to discover us.
  writeFileSync(
    Paths.daemonInfo,
    JSON.stringify(
      {
        pid: lock.pid,
        host: server.hostname,
        port: server.port,
        url: baseUrl,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  // Browser-facing URL with token included; printed exactly once on stdout
  // and never written to the persistent log (per design.md §10.2).
  const browserUrl = `${baseUrl}?token=${token}`
  process.stdout.write(
    `\nagent-workflow ready — open this URL in your browser:\n  ${browserUrl}\n\n`,
  )

  // 8. Background tickers (P-4-04 limits + P-4-09 worktree GC + P-5-01 events archival).
  const limitsTicker = startLimitsTicker(db)
  const gcTicker = startWorktreeGc(db, () => loadConfig(Paths.config))
  const archiveTicker = startEventsArchiver(db, () => loadConfig(Paths.config), Paths.logsDir)

  // 9. Graceful shutdown (P-4-06).
  //
  // SIGTERM/SIGINT:
  //   - stop accepting new HTTP requests
  //   - abort all running tasks (their AbortControllers SIGTERM their child
  //     opencode processes via runner.ts; the scheduler then marks rows
  //     canceled/interrupted)
  //   - poll for ~30s; any task still in 'running' after the budget is
  //     flipped to 'interrupted' so the next daemon start surfaces it as
  //     daemon-restart instead of leaving stale rows.
  // Sync cleanup of .daemon.info — must happen before any await in the
  // signal path. CI on macOS flaked when this was buried behind
  // `await import(...) + await gracefulShutdown(...)`: if the daemon was
  // killed before the awaits resolved, the file outlived the process and
  // the cli.test.ts existsSync assertion failed.
  const removeDaemonInfo = (): void => {
    try {
      unlinkSync(Paths.daemonInfo)
    } catch {
      // already removed or never written
    }
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal })
    limitsTicker.stop()
    gcTicker.stop()
    archiveTicker.stop()
    removeDaemonInfo()
    server.stop(true)
    try {
      const { gracefulShutdown } = await import('@/services/shutdown')
      await gracefulShutdown(db, 30_000)
    } catch (err) {
      log.warn('graceful shutdown error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    lock.release()
    process.exit(0)
  }
  process.on('SIGTERM', () => {
    // unlink synchronously the instant the signal fires; the async shutdown
    // continues in the background.
    removeDaemonInfo()
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    removeDaemonInfo()
    void shutdown('SIGINT')
  })
  // Belt-and-suspenders for paths the signal handlers can't reach (uncaught
  // exception, explicit process.exit elsewhere). on('exit') is synchronous
  // and runs on every normal termination path.
  process.on('exit', () => {
    removeDaemonInfo()
    lock.release()
  })

  await new Promise<void>(() => {
    /* never resolves */
  })
}
