// RFC-105 WP-B — PlantUmlBlock.renderViaProxy maps the /api/plantuml/render
// response union onto the existing DOM states, keeping DOMPurify + the
// frontend's syntax-error extractor.

import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('@/api/client', () => ({ api: { post: vi.fn() } }))

import '../src/i18n'
import { PlantUmlBlock } from '@/components/review/PlantUmlBlock'
import { api } from '@/api/client'

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => vi.clearAllMocks())

describe('PlantUmlBlock.renderViaProxy', () => {
  test('svg response → sanitized .review-diagram__svg', async () => {
    vi.mocked(api.post).mockResolvedValue({
      svg: '<svg><rect/></svg>',
      host: 'kroki.test',
    } as never)
    const mount = document.createElement('div')
    PlantUmlBlock.renderViaProxy(mount, '@startuml\nA->B\n@enduml')
    await flush()
    expect(mount.querySelector('.review-diagram__svg')).not.toBeNull()
  })

  test('unconfigured → source-dump fallback', async () => {
    vi.mocked(api.post).mockResolvedValue({ unconfigured: true } as never)
    const mount = document.createElement('div')
    PlantUmlBlock.renderViaProxy(mount, '@startuml\nA->B\n@enduml')
    await flush()
    expect(mount.querySelector('.review-diagram__unconfigured')).not.toBeNull()
  })

  test('errorSvg with a PlantUML syntax diagnostic → error banner', async () => {
    vi.mocked(api.post).mockResolvedValue({
      errorSvg:
        '<svg><text>PlantUML version 1.2024</text><text>From string (line 2)</text><text>Syntax Error?</text></svg>',
      host: 'kroki.test',
    } as never)
    const mount = document.createElement('div')
    PlantUmlBlock.renderViaProxy(mount, '@startuml\nbad\n@enduml')
    await flush()
    expect(mount.querySelector('.review-diagram__error')).not.toBeNull()
    expect(mount.querySelector('.review-diagram__svg')).toBeNull()
  })

  test('200 { error } (render-failed union member) → error banner with detail', async () => {
    vi.mocked(api.post).mockResolvedValue({ error: 'POST 503' } as never)
    const mount = document.createElement('div')
    PlantUmlBlock.renderViaProxy(mount, '@startuml\nA->B\n@enduml')
    await flush()
    const err = mount.querySelector('.review-diagram__error')
    expect(err).not.toBeNull()
    expect(err?.textContent).toContain('POST 503')
  })

  test('network error → error banner, no crash', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('boom'))
    const mount = document.createElement('div')
    PlantUmlBlock.renderViaProxy(mount, '@startuml\nA->B\n@enduml')
    await flush()
    expect(mount.querySelector('.review-diagram__error')).not.toBeNull()
  })
})
