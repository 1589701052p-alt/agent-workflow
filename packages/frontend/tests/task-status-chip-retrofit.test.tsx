// RFC-035 PR1 — locks the TaskStatusChip retrofit: it must internally
// render <StatusChip> with the shared kind map and the localised label.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { TaskStatusChip } from '../src/components/TaskStatusChip'
import { TASK_STATUS_KIND } from '../src/lib/task-status'
import '../src/i18n'
import { TASK_STATUS } from '@agent-workflow/shared'

describe('<TaskStatusChip /> retrofit', () => {
  for (const status of TASK_STATUS) {
    test(`status=${status} renders status-chip--${TASK_STATUS_KIND[status]}`, () => {
      const { container } = render(<TaskStatusChip status={status} />)
      const chip = container.querySelector('.status-chip')
      expect(chip, `chip for ${status}`).not.toBeNull()
      expect(chip?.className).toContain(`status-chip--${TASK_STATUS_KIND[status]}`)
    })
  }

  test('text content is the localised label, not the raw enum', () => {
    const { container } = render(<TaskStatusChip status="awaiting_human" />)
    const chip = container.querySelector('.status-chip')
    expect(chip?.textContent ?? '').not.toContain('awaiting_human')
    expect((chip?.textContent ?? '').length).toBeGreaterThan(0)
  })
})
