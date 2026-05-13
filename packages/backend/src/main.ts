// Entry point for the agent-workflow daemon CLI.
// Subcommands:
//   start    P-1-01 ✓
//   stop     P-1-05
//   status   P-1-05
//   version  P-1-05 (basic version implemented now)
//   doctor   P-1-05
//   config   P-1-05
//   migrate  P-1-05
//   backup   P-5-02

import { startCommand } from './cli/start'

function readPortFlag(argv: string[]): number | undefined {
  const i = argv.indexOf('--port')
  if (i < 0) return undefined
  const next = argv[i + 1]
  if (next === undefined) {
    console.error('--port requires a value')
    process.exit(2)
  }
  const n = Number(next)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`invalid --port value: ${next}`)
    process.exit(2)
  }
  return n
}

function readHostFlag(argv: string[]): string | undefined {
  const i = argv.indexOf('--host')
  if (i < 0) return undefined
  const next = argv[i + 1]
  if (next === undefined) {
    console.error('--host requires a value')
    process.exit(2)
  }
  return next
}

async function main(): Promise<void> {
  const sub = Bun.argv[2] ?? 'help'

  switch (sub) {
    case 'start':
      await startCommand({
        port: readPortFlag(Bun.argv),
        host: readHostFlag(Bun.argv),
      })
      break

    case 'version':
      console.log('agent-workflow 0.0.0 (M1, P-1-01)')
      break

    case 'stop':
    case 'status':
    case 'doctor':
    case 'config':
    case 'migrate':
    case 'backup':
      console.error(`'${sub}' subcommand wired in M1 (P-1-05); not yet implemented`)
      process.exit(2)
      break

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log('usage: agent-workflow <command> [options]')
      console.log('')
      console.log('commands:')
      console.log('  start [--port N] [--host H]   start daemon foreground')
      console.log('  stop                          send SIGTERM to running daemon (P-1-05)')
      console.log('  status                        print daemon status (P-1-05)')
      console.log('  version                       print version')
      console.log('  doctor                        run health checks (P-1-05)')
      console.log('  config get|set <key> [value]  read/write settings (P-1-05)')
      console.log('  migrate                       run pending DB migrations (P-1-05)')
      console.log('  backup                        export backup tarball (P-5-02)')
      if (sub !== 'help' && sub !== '--help' && sub !== '-h') {
        console.error(`unknown subcommand: ${sub}`)
        process.exit(2)
      }
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
