// RFC-002: dropdown of existing skills above the chip input. Lets the user
// pick from /api/skills instead of having to remember the exact skill name.
// Falls back to plain ChipsInput when the skills list fails to load, so the
// agent form remains usable.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ChipsInput } from './ChipsInput'

export const SKILLS_QUERY_KEY = ['skills'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function SkillsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  const list = useQuery<Skill[]>({
    queryKey: SKILLS_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  const available = useMemo(() => {
    const existing = new Set(value)
    return (list.data ?? []).filter((s) => !existing.has(s.name))
  }, [list.data, value])

  const failed = list.error !== null && list.error !== undefined

  return (
    <div>
      {!failed && (
        <select
          className="form-input"
          value=""
          disabled={list.isLoading || available.length === 0}
          onChange={(e) => {
            const name = e.target.value
            if (!name) return
            if (!value.includes(name)) onChange([...value, name])
            // Reset the visible selection so the user can keep picking; the
            // controlled value="" pins it back on the next render anyway.
            e.target.value = ''
          }}
          style={{ marginBottom: 6 }}
        >
          <option value="">
            {list.isLoading
              ? t('agentForm.skillsPickerLoading')
              : available.length === 0
                ? t('agentForm.skillsPickerEmpty')
                : t('agentForm.skillsPickerLabel')}
          </option>
          {available.map((s) => (
            <option key={s.name} value={s.name}>
              {s.description ? `${s.name} — ${s.description}` : s.name}
            </option>
          ))}
        </select>
      )}
      <ChipsInput value={value} onChange={onChange} placeholder={placeholder} />
      {failed && (
        <p style={{ marginTop: 4, marginBottom: 0, fontSize: 12 }} className="muted">
          {t('agentForm.skillsPickerLoadFailed')}
        </p>
      )}
    </div>
  )
}
