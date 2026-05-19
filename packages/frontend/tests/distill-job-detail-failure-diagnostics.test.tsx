// RFC-043 T5 — FailureDiagnostics contract.

import { afterEach, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import { FailureDiagnostics } from '../src/components/memory/distill-job-detail/FailureDiagnostics'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function mkJob(overrides: Partial<MemoryDistillJob> = {}): MemoryDistillJob {
  return {
    id: 'j1',
    debounceKey: 'k',
    sourceKind: 'feedback',
    sourceEventId: 'src',
    taskId: null,
    scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
    status: 'done',
    attempts: 0,
    nextRunAt: 0,
    lastError: null,
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    opencodeSessionId: null,
    userPromptMd: null,
    exitCode: 0,
    stderrExcerpt: null,
    ...overrides,
  }
}

describe('FailureDiagnostics', () => {
  test('renders nothing when there is nothing to diagnose', () => {
    const { container } = render(<FailureDiagnostics job={mkJob()} />)
    expect(container.firstChild).toBeNull()
  })

  test('renders the panel when status=failed', () => {
    render(<FailureDiagnostics job={mkJob({ status: 'failed', lastError: 'boom', attempts: 3 })} />)
    expect(screen.getByTestId('distill-failure-diagnostics')).toBeTruthy()
  })

  test('shows stderr block when stderrExcerpt is non-empty', () => {
    render(
      <FailureDiagnostics
        job={mkJob({
          status: 'failed',
          attempts: 1,
          stderrExcerpt: 'fatal: distiller crashed',
        })}
      />,
    )
    const panel = screen.getByTestId('distill-failure-diagnostics')
    expect(panel.textContent ?? '').toContain('fatal:')
  })
})
