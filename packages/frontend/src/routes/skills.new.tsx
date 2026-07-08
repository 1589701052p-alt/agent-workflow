// Skill create page. Two tabs:
//   * Managed — POST /api/skills (the framework owns the dir).
//   * External — POST /api/skills/import-external (point at an existing dir).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { SKILL_NAME_RE } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Field, TextArea, TextInput } from '@/components/Form'
import { describeApiError } from '@/i18n'
import { ImportZipPanel } from '@/components/skills/ImportZipPanel'
import { TabBar } from '@/components/TabBar'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/skills/new',
  component: SkillCreatePage,
})

type Tab = 'managed' | 'external' | 'folder' | 'zip'

interface RegisterSourceResponse {
  source: { id: string; label: string; childCount: number }
  imported: Array<{ name: string }>
  skipped: Array<{ proposedName?: string; reason: string }>
}

function SkillCreatePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('managed')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [externalPath, setExternalPath] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [folderLabel, setFolderLabel] = useState('')

  const create = useMutation({
    mutationFn: (): Promise<Skill> => {
      if (tab === 'managed') {
        return api.post<Skill>('/api/skills', { name, description, bodyMd })
      }
      return api.post<Skill>('/api/skills/import-external', { name, description, externalPath })
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      navigate({ to: '/skills/$name', params: { name: s.name } })
    },
  })

  const registerFolder = useMutation({
    mutationFn: (): Promise<RegisterSourceResponse> =>
      api.post<RegisterSourceResponse>('/api/skill-sources', {
        path: folderPath,
        ...(folderLabel ? { label: folderLabel } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['skills'] })
      void qc.invalidateQueries({ queryKey: ['skill-sources'] })
      navigate({ to: '/skills' })
    },
  })

  const disabled =
    tab === 'folder'
      ? folderPath === '' || registerFolder.isPending
      : name === '' ||
        create.isPending ||
        (tab === 'external' && externalPath === '') ||
        !SKILL_NAME_RE.test(name)

  return (
    <div className="page">
      <header className="page__header">
        <h1>{t('skills.newTitle')}</h1>
        <p className="page__hint">
          {t('skills.newHintBefore')}
          <code>{t('skills.newHintManaged')}</code>
          {t('skills.newHintMid')}
          <code>{t('skills.newHintExternal')}</code>
          {t('skills.newHintAfter')}
        </p>
      </header>

      <TabBar<Tab>
        tabs={[
          { key: 'managed', label: t('skills.tabManaged') },
          { key: 'external', label: t('skills.tabExternal') },
          { key: 'folder', label: t('skills.tabFolder') },
          { key: 'zip', label: t('skills.tabZip'), testid: 'skills-tab-zip' },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === 'zip' ? (
        <ImportZipPanel />
      ) : (
        <>
          <div className="form-grid">
            {tab === 'folder' ? (
              <>
                <Field
                  label={t('skills.fieldFolderPath')}
                  required
                  hint={t('skills.fieldFolderPathHint')}
                >
                  <TextInput
                    value={folderPath}
                    onChange={setFolderPath}
                    placeholder={t('skills.folderPathPlaceholder')}
                    required
                  />
                </Field>
                <Field label={t('skills.fieldFolderLabel')} hint={t('skills.fieldFolderLabelHint')}>
                  <TextInput value={folderLabel} onChange={setFolderLabel} />
                </Field>
              </>
            ) : (
              <>
                <Field label={t('skills.fieldName')} required hint={t('skills.fieldNameHint')}>
                  <TextInput
                    value={name}
                    onChange={setName}
                    required
                    pattern={SKILL_NAME_RE.source}
                  />
                </Field>
                <Field label={t('skills.fieldDescription')}>
                  <TextInput value={description} onChange={setDescription} />
                </Field>
                {tab === 'managed' ? (
                  <Field label={t('skills.fieldBody')}>
                    <TextArea value={bodyMd} onChange={setBodyMd} rows={10} monospace />
                  </Field>
                ) : (
                  <Field
                    label={t('skills.fieldExternalPath')}
                    required
                    hint={t('skills.fieldExternalPathHint')}
                  >
                    <TextInput
                      value={externalPath}
                      onChange={setExternalPath}
                      placeholder={t('skills.externalPathPlaceholder')}
                      required
                    />
                  </Field>
                )}
              </>
            )}
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => (tab === 'folder' ? registerFolder.mutate() : create.mutate())}
              disabled={disabled}
            >
              {tab === 'folder'
                ? registerFolder.isPending
                  ? t('common.creating')
                  : t('skills.createFolderButton')
                : create.isPending
                  ? t('common.creating')
                  : t('skills.createButton')}
            </button>
            {tab !== 'folder' && create.error !== null && create.error !== undefined && (
              <span className="form-actions__error">{describeApiError(create.error)}</span>
            )}
            {tab === 'folder' &&
              registerFolder.error !== null &&
              registerFolder.error !== undefined && (
                <span className="form-actions__error">
                  {describeApiError(registerFolder.error)}
                </span>
              )}
          </div>
        </>
      )}
    </div>
  )
}
