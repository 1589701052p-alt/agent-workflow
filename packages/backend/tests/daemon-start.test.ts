import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mainPath = resolve(import.meta.dir, '..', 'src', 'main.ts')

describe('daemon start (P-1-01)', () => {
  let tmp: string
  let env: Record<string, string>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-daemon-'))
    env = { ...(process.env as Record<string, string>), AGENT_WORKFLOW_HOME: tmp }
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('starts, serves /api/health, releases lock on SIGTERM', async () => {
    const child = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    let url: string | null = null
    try {
      url = await waitForListening(child.stdout, 5000)
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/)

      const healthUrl = (url.endsWith('/') ? url : url + '/') + 'api/health'
      const res = await fetch(healthUrl)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; scaffold: string; pid: number }
      expect(body.ok).toBe(true)
      expect(body.scaffold).toBe('P-1-01')
      expect(body.pid).toBe(child.pid ?? -1)
    } finally {
      child.kill('SIGTERM')
      await child.exited
    }
  })

  test('a second daemon start is rejected while the first holds the lock', async () => {
    const first = Bun.spawn({
      cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      await waitForListening(first.stdout, 5000)

      const second = Bun.spawn({
        cmd: ['bun', 'run', mainPath, 'start', '--port', '0'],
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const exitCode = await second.exited
      expect(exitCode).toBe(1)

      const stderr = await new Response(second.stderr).text()
      expect(stderr).toContain('another daemon is already running')
      expect(stderr).toContain(`PID ${first.pid ?? -1}`)
    } finally {
      first.kill('SIGTERM')
      await first.exited
    }
  })
})

/** Drain stdout until we see the "listening at <url>" line, or time out. */
async function waitForListening(
  stdout: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) throw new Error('daemon exited before printing "listening at"')
      buffer += decoder.decode(value, { stream: true })
      const m = buffer.match(/listening at (http:\/\/[^\s]+)/)
      if (m && m[1] !== undefined) return m[1]
    }
    throw new Error(`timed out waiting for "listening at" within ${timeoutMs}ms; got:\n${buffer}`)
  } finally {
    reader.releaseLock()
  }
}
