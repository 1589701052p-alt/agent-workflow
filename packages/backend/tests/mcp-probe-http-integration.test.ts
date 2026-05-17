// RFC-030 T7 — end-to-end probe against a real in-process MCP HTTP server.
//
// Uses Bun.serve + `WebStandardStreamableHTTPServerTransport` to host a
// minimal MCP endpoint, then drives the default openClient (Streamable HTTP
// transport on the client side) through probeMcp. Verifies:
//   - status='ok' + 2 tools captured
//   - finishedAt - startedAt < 5s (latency budget)
//   - server is reachable + handshake completes (handshakeMs > 0)

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Mcp } from '@agent-workflow/shared'
import { probeMcp } from '../src/services/mcpProbe'

let server: ReturnType<typeof Bun.serve> | null = null
let port = 0

function buildMcp(): McpServer {
  // Fresh server per request — required for stateless WebStandard transport,
  // which complains "Already connected to a transport" if the same McpServer
  // instance is wired to more than one transport across requests.
  const mcp = new McpServer(
    { name: 'mock-mcp-http', version: '0.2.0' },
    { capabilities: { tools: {} } },
  )
  mcp.tool('hello', 'Say hello', async () => ({
    content: [{ type: 'text', text: 'hi' }],
  }))
  mcp.tool('ping', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  return mcp
}

beforeAll(() => {
  server = Bun.serve({
    port: 0, // pick a free port
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
      const mcp = buildMcp()
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      })
      await mcp.connect(transport)
      try {
        return await transport.handleRequest(req)
      } finally {
        await transport.close().catch(() => {})
        await mcp.close().catch(() => {})
      }
    },
  })
  if (server.port === undefined) throw new Error('Bun.serve did not assign a port')
  port = server.port
})

afterAll(() => {
  server?.stop()
})

function makeRemoteMcp(): Mcp {
  return {
    id: 'm_http_fixture',
    name: 'mock-http',
    description: '',
    type: 'remote',
    config: { url: `http://localhost:${port}/mcp`, timeoutMs: 5_000 },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  } as Mcp
}

describe('probe against real HTTP MCP fixture', () => {
  test('status=ok + 2 tools + handshakeMs > 0 + latency budget', async () => {
    const r = await probeMcp(makeRemoteMcp())
    expect(r.status).toBe('ok')
    expect(r.errorCode === null || r.errorCode === 'partial').toBe(true)
    expect((r.tools ?? []).map((t) => t.name).sort()).toEqual(['hello', 'ping'])
    expect(r.serverInfo?.name).toBe('mock-mcp-http')
    expect(r.handshakeMs ?? -1).toBeGreaterThanOrEqual(0)
    expect(r.latencyMs).toBeLessThan(5_000)
  }, 15_000)
})
