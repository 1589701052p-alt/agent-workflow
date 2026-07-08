// RFC-045 — admin manual create memory dialog.
//
// Opens from the /memory page header `[+ New memory]` button. On Save:
//   POST /api/memories  (perm=memory:approve; route is shared with the
//   existing `createManualCandidate` path so the WS publishes
//   memory.candidate.created for free).
// After a successful create the dialog closes and the caller switches
// the visible tab to Approval Queue.
//
// RFC-151 PR-4: chrome (Dialog + footer + scope-option queries + validation
// gate) lives in the shared <MemoryDialogShell>; this file keeps only the
// create-side specifics — empty form seed, POST payload, invalidations.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { MemoryDialogShell } from './MemoryDialogShell'
import { useMemoryFormState, type MemoryFormState } from './MemoryFormFields'

export interface MemoryNewDialogProps {
  open: boolean
  onClose: () => void
  onCreated?: (m: Memory) => void
}

interface CreatePayload {
  scopeType: MemoryFormState['scopeType']
  scopeId: string | null
  title: string
  bodyMd: string
  tags?: string[]
}

export function MemoryNewDialog(props: MemoryNewDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const f = useMemoryFormState()

  const create = useMutation<Memory, ApiError, CreatePayload>({
    mutationFn: async (payload) => {
      const res = await api.post<{ memory: Memory }>('/api/memories', payload)
      return res.memory
    },
    onSuccess: (memory) => {
      void qc.invalidateQueries({ queryKey: ['memories', 'candidates'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'pending-count'] })
      f.reset()
      props.onCreated?.(memory)
      props.onClose()
    },
  })

  const handleSubmit = () => {
    const payload: CreatePayload = {
      scopeType: f.state.scopeType,
      scopeId: f.state.scopeType === 'global' ? null : f.state.scopeId,
      title: f.state.title.trim(),
      bodyMd: f.state.bodyMd.trim(),
      tags: f.state.tags.length > 0 ? f.state.tags : undefined,
    }
    create.mutate(payload)
  }

  return (
    <MemoryDialogShell
      open={props.open}
      onClose={props.onClose}
      title={t('memory.newDialogTitle')}
      testid="memory-new-dialog"
      form={f}
      pending={create.isPending}
      errorText={
        create.error !== null && create.error !== undefined ? describeApiError(create.error) : null
      }
      onSubmit={handleSubmit}
    />
  )
}
