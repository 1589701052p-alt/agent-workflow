// RFC-008 T1 — ```plantuml blocks route to the PlantUmlBlock React shell.

import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const renderSpy = vi.fn()
vi.mock('@/components/review/PlantUmlBlock', () => ({
  PlantUmlBlock: {
    render: (
      mount: HTMLElement,
      source: string,
      endpoint: string | undefined,
      authHeader: string | undefined,
    ) => {
      renderSpy(source, endpoint, authHeader)
      mount.innerHTML = '<div data-mocked="plantuml"/>'
    },
  },
}))

import { Prose } from '@/components/prose/Prose'

describe('Prose — plantuml fenced block', () => {
  beforeEach(() => {
    renderSpy.mockClear()
  })

  test('mounts prose__diagram--plantuml container', () => {
    const md = '```plantuml\n@startuml\nA -> B\n@enduml\n```'
    const { container } = render(<Prose body={md} />)
    const node = container.querySelector('[data-prose-diagram="plantuml"]')
    expect(node).not.toBeNull()
  })

  test('endpoint + authHeader threaded into PlantUmlBlock.render', () => {
    const md = '```plantuml\n@startuml\nA -> B\n@enduml\n```'
    render(
      <Prose body={md} plantumlEndpoint="https://kroki.example/" plantumlAuthHeader="Bearer abc" />,
    )
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(renderSpy.mock.calls[0]?.[0]).toContain('@startuml')
    expect(renderSpy.mock.calls[0]?.[1]).toBe('https://kroki.example/')
    expect(renderSpy.mock.calls[0]?.[2]).toBe('Bearer abc')
  })
})
