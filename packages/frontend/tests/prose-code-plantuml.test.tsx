// RFC-008 T1 — ```plantuml blocks route to the PlantUmlBlock React shell.
// RFC-105 WP-B — the shell now calls PlantUmlBlock.renderViaProxy (the backend
// proxy holds the endpoint/auth), so Prose no longer threads plantuml config.

import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const proxySpy = vi.fn()
vi.mock('@/components/review/PlantUmlBlock', () => ({
  PlantUmlBlock: {
    renderViaProxy: (mount: HTMLElement, source: string) => {
      proxySpy(source)
      mount.innerHTML = '<div data-mocked="plantuml"/>'
    },
  },
}))

import { Prose } from '@/components/prose/Prose'

describe('Prose — plantuml fenced block', () => {
  beforeEach(() => {
    proxySpy.mockClear()
  })

  test('mounts prose__diagram--plantuml container', () => {
    const md = '```plantuml\n@startuml\nA -> B\n@enduml\n```'
    const { container } = render(<Prose body={md} />)
    const node = container.querySelector('[data-prose-diagram="plantuml"]')
    expect(node).not.toBeNull()
  })

  test('routes the source to renderViaProxy (no endpoint/auth in the client)', () => {
    const md = '```plantuml\n@startuml\nA -> B\n@enduml\n```'
    render(<Prose body={md} />)
    expect(proxySpy).toHaveBeenCalledTimes(1)
    expect(proxySpy.mock.calls[0]?.[0]).toContain('@startuml')
    // The shell passes only (mount, source) — no endpoint/auth args.
    expect(proxySpy.mock.calls[0]?.length).toBe(1)
  })
})
