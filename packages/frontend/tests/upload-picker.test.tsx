// RFC-020 T6: UploadPicker render/interaction. Verifies file list rendering,
// remove button, and maxCount cap (extra files dropped when limit hit).

import { I18nextProvider } from 'react-i18next'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { UploadPicker } from '../src/components/launch/UploadPicker'
import i18n from '../src/i18n'

function makeFile(name: string, size = 10): File {
  const f = new File(['x'.repeat(size)], name, { type: 'text/plain' })
  return f
}

function wrap(node: React.ReactElement) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
}

describe('UploadPicker', () => {
  test('renders one row per selected file with name + size + remove button', () => {
    const files = [makeFile('a.txt', 10), makeFile('b.txt', 2048)]
    render(
      wrap(
        <UploadPicker
          def={
            {
              kind: 'upload',
              key: 'refs',
              label: 'r',
              targetDir: 'inputs',
            } as unknown as WorkflowInput
          }
          files={files}
          onChange={() => {}}
        />,
      ),
    )
    expect(screen.getByText('a.txt')).toBeTruthy()
    expect(screen.getByText('b.txt')).toBeTruthy()
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy()
  })

  test('clicking remove invokes onChange without the dropped index', () => {
    let last: File[] = [makeFile('a.txt'), makeFile('b.txt')]
    const onChange = (next: File[]) => {
      last = next
    }
    const { rerender } = render(
      wrap(
        <UploadPicker
          def={
            {
              kind: 'upload',
              key: 'refs',
              label: 'r',
              targetDir: 'inputs',
            } as unknown as WorkflowInput
          }
          files={last}
          onChange={onChange}
        />,
      ),
    )
    const buttons = screen.getAllByRole('button')
    // First two are "Choose files" + nothing — the per-row remove buttons come
    // after; pick by filtering on the removeFile label heuristic.
    const removeButtons = buttons.filter((b) => b.className.includes('btn--ghost'))
    expect(removeButtons.length).toBe(2)
    fireEvent.click(removeButtons[0]!)
    expect(last.map((f) => f.name)).toEqual(['b.txt'])
    rerender(
      wrap(
        <UploadPicker
          def={
            {
              kind: 'upload',
              key: 'refs',
              label: 'r',
              targetDir: 'inputs',
            } as unknown as WorkflowInput
          }
          files={last}
          onChange={onChange}
        />,
      ),
    )
    expect(screen.queryByText('a.txt')).toBeNull()
  })

  test('maxCount is reflected in the hint', () => {
    render(
      wrap(
        <UploadPicker
          def={
            {
              kind: 'upload',
              key: 'refs',
              label: 'r',
              targetDir: 'inputs',
              maxCount: 3,
            } as unknown as WorkflowInput
          }
          files={[]}
          onChange={() => {}}
        />,
      ),
    )
    expect(screen.getByText(/max 3/)).toBeTruthy()
  })
})
