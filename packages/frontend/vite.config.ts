import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Resolve the daemon URL by reading ~/.agent-workflow/.daemon.info, which the
// running daemon writes at startup. Falls back to 127.0.0.1:7456 if absent.
// The daemon picks a free port (port=0) when bindPort isn't set in config,
// so a hardcoded proxy target goes stale on every restart.
function resolveDaemonTarget(): string {
  const fallback = 'http://127.0.0.1:7456'
  try {
    const infoPath = path.join(homedir(), '.agent-workflow', '.daemon.info')
    if (!existsSync(infoPath)) return fallback
    const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as {
      host?: string
      port?: number
      url?: string
    }
    if (typeof info.url === 'string' && info.url !== '') {
      return info.url.replace(/\/$/, '')
    }
    if (typeof info.host === 'string' && typeof info.port === 'number') {
      return `http://${info.host}:${info.port}`
    }
    return fallback
  } catch {
    return fallback
  }
}

const daemonTarget = resolveDaemonTarget()
// eslint-disable-next-line no-console
console.log(`[vite] proxying /api and /ws → ${daemonTarget}`)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': daemonTarget,
      '/ws': { target: daemonTarget, ws: true, changeOrigin: true },
    },
  },
})
