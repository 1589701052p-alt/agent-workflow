// PlantUmlBlock — RFC-005 PR-C T18.
//
// Locks in the kroki-style render path (GET deflate+base64 → POST fallback
// → unconfigured fallback / error display). Uses vitest's vi.stubGlobal
// to swap `fetch` for each scenario.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { PlantUmlBlock } from '@/components/review/PlantUmlBlock'

function makeMount(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

async function settle(ms: number = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('encodeForGet', () => {
  test('produces a non-empty base64-url-encoded string', () => {
    const enc = PlantUmlBlock.encodeForGet('@startuml\nA -> B\n@enduml')
    expect(enc.length).toBeGreaterThan(0)
    // base64url alphabet: [A-Za-z0-9_-], no padding
    expect(/^[A-Za-z0-9_-]+$/.test(enc)).toBe(true)
  })

  test('different sources produce different encodings', () => {
    const a = PlantUmlBlock.encodeForGet('@startuml\nA -> B\n@enduml')
    const b = PlantUmlBlock.encodeForGet('@startuml\nC -> D\n@enduml')
    expect(a).not.toBe(b)
  })
})

describe('render — unconfigured endpoint', () => {
  test('empty endpoint → source code + hint', () => {
    const mount = makeMount()
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', undefined, undefined)
    expect(mount.querySelector('.review-diagram__unconfigured')).not.toBeNull()
    expect(mount.querySelector('.review-diagram__hint')?.textContent).toMatch(/not configured/)
    expect(mount.querySelector('.review-diagram__source')?.textContent).toContain('@startuml')
  })

  test('whitespace endpoint → same fallback', () => {
    const mount = makeMount()
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', '   ', undefined)
    expect(mount.querySelector('.review-diagram__unconfigured')).not.toBeNull()
  })
})

describe('render — GET succeeds (kroki path)', () => {
  test('mount receives the returned SVG', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async (_url: string) => {
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://kroki.io', undefined)
    // loading state initially
    expect(mount.querySelector('.review-diagram__loading')).not.toBeNull()
    await settle(50)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })

  test('trailing slash on endpoint is normalized', async () => {
    const mount = makeMount()
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://kroki.io/', undefined)
    await settle(50)
    expect(calls[0]).toMatch(/^https:\/\/kroki\.io\/plantuml\/svg\/[A-Za-z0-9_-]+$/)
  })

  test('Authorization header forwarded when configured', async () => {
    const mount = makeMount()
    const seenHeaders: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      const auth = h.get('Authorization')
      if (auth !== null) seenHeaders.push(auth)
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
    })
    PlantUmlBlock.render(mount, 'src', 'https://kroki.io', 'Bearer xxx')
    await settle(50)
    expect(seenHeaders).toContain('Bearer xxx')
  })
})

describe('render — GET fails, POST succeeds (plantuml-server path)', () => {
  test('falls back to POST raw and renders SVG', async () => {
    const mount = makeMount()
    let getCalled = false
    let postCalled = false
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCalled = true
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 })
      }
      getCalled = true
      return new Response('not found', { status: 404 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://example.test', undefined)
    await settle(50)
    expect(getCalled).toBe(true)
    expect(postCalled).toBe(true)
    expect(mount.querySelector('.review-diagram__svg svg')).not.toBeNull()
  })
})

describe('render — both paths fail', () => {
  test('shows error wrapper + source code', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      return new Response('boom', { status: 500 })
    })
    PlantUmlBlock.render(mount, '@startuml\nA -> B\n@enduml', 'https://example.test', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__error')?.textContent).toMatch(
      /plantuml render failed/,
    )
    expect(mount.querySelector('.review-diagram__source')?.textContent).toContain('@startuml')
  })

  test('network error also falls back to error + source', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection refused')
    })
    PlantUmlBlock.render(mount, 'src', 'https://example.test', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__error')?.textContent).toMatch(/connection refused/)
  })

  test('non-SVG response falls back to error path', async () => {
    const mount = makeMount()
    vi.stubGlobal('fetch', async () => {
      return new Response('<html>not svg</html>', { status: 200 })
    })
    PlantUmlBlock.render(mount, 'src', 'https://example.test', undefined)
    await settle(50)
    expect(mount.querySelector('.review-diagram__error')).not.toBeNull()
  })
})
