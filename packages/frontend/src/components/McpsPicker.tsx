// RFC-028 — same shape as SkillsPicker, but pointed at /api/mcps. Lets the
// user pick from existing MCP rows instead of typing names by hand. Falls
// back to a plain ChipsInput when the MCP list fails to load (the agent form
// must stay usable even if the daemon's MCP endpoint is temporarily broken).

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'
import { Select } from './Select'

export const MCPS_QUERY_KEY = ['mcps'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function McpsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Mcp[]>({
    queryKey: MCPS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/mcps', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    return (list.data ?? []).filter((m) => !existing.has(m.name))
  }, [list.data, value])

  const failed = list.error !== null && list.error !== undefined

  // One-shot "add to list" dropdown: value stays "" so the trigger always
  // shows the picker label; picking a row appends it to the chips.
  const pickerLabel = list.isLoading
    ? t('agentForm.mcpsPickerLoading')
    : available.length === 0
      ? t('agentForm.mcpsPickerEmpty')
      : t('agentForm.mcpsPickerLabel')

  return (
    <div>
      {!failed && (
        <div style={{ marginBottom: 6 }}>
          <Select<string>
            value=""
            placeholder={pickerLabel}
            ariaLabel={pickerLabel}
            disabled={list.isLoading || available.length === 0}
            data-testid="mcps-picker-select"
            options={available.map((m) => ({
              value: m.name,
              label: m.description ? `${m.name} — ${m.description}` : m.name,
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
          {t('agentForm.mcpsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
