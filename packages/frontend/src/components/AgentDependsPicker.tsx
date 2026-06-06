// RFC-022: dropdown of existing agents above the chip input. Mirror of
// SkillsPicker. Lets the form author pick the closure members from
// /api/agents instead of typing names; self-name is filtered out because
// the save-time guard refuses self-references.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'
import { Select } from './Select'

export const AGENTS_QUERY_KEY = ['agents'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  /** Name of the agent being edited — excluded from the dropdown so the form
   *  cannot offer "select self" (which the save-time guard would reject). */
  selfName?: string
  placeholder?: string
}

export function AgentDependsPicker({ value, onChange, selfName, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Agent[]>({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    return (list.data ?? []).filter((a) => !existing.has(a.name) && a.name !== selfName)
  }, [list.data, value, selfName])

  const failed = list.error !== null && list.error !== undefined

  // One-shot "add to list" dropdown: value stays "" so the trigger always
  // shows the picker label; picking a row appends it to the chips.
  const pickerLabel = list.isLoading
    ? t('agentForm.dependsPickerLoading')
    : available.length === 0
      ? t('agentForm.dependsPickerEmpty')
      : t('agentForm.dependsPickerLabel')

  return (
    <div>
      {!failed && (
        <div style={{ marginBottom: 6 }}>
          <Select<string>
            value=""
            placeholder={pickerLabel}
            ariaLabel={pickerLabel}
            disabled={list.isLoading || available.length === 0}
            options={available.map((a) => ({
              value: a.name,
              label: a.description ? `${a.name} — ${a.description}` : a.name,
            }))}
            onChange={(name) => {
              if (name === '' || value.includes(name)) return
              onChange([...value, name])
            }}
          />
        </div>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.dependsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
