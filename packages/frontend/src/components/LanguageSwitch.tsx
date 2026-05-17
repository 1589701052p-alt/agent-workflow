// RFC-025: Sidebar-footer language switcher.
//
// Two-option segmented control. Clicking an option:
//   1. Optimistically flips i18next via setLanguage (instant UI response).
//   2. Fires PUT /api/config { ...config, language } to persist.
//   3. On error, rolls i18next back to the previous value + shows a muted
//      red error line below the segmented control.
//
// Backend config is the authority — useApplyLanguage will reconcile if the
// backend ever disagrees with the optimistic flip.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Config } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError, setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'
import { isSupportedLanguage } from '@/hooks/useLanguage'
import { getToken, subscribeAuth } from '@/stores/auth'

interface Props {
  className?: string
}

function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuth, getToken, () => null)
}

export function LanguageSwitch({ className }: Props) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const token = useAuthToken()
  const config = useQuery<Config>({
    queryKey: ['config'],
    queryFn: ({ signal }) => api.get('/api/config', undefined, signal),
    enabled: token !== null,
    staleTime: 60_000,
  })

  const current: SupportedLanguage = isSupportedLanguage(config.data?.language)
    ? (config.data!.language as SupportedLanguage)
    : isSupportedLanguage(i18n.language)
      ? (i18n.language as SupportedLanguage)
      : 'zh-CN'

  const mutation = useMutation<Config, Error, SupportedLanguage, { previous: SupportedLanguage }>({
    mutationFn: (lang) =>
      api.put<Config>('/api/config', { ...(config.data ?? {}), language: lang }),
    onMutate: (lang) => {
      const previous = current
      setLanguage(lang)
      return { previous }
    },
    onSuccess: (next) => {
      qc.setQueryData(['config'], next)
    },
    onError: (_err, _lang, ctx) => {
      if (ctx) setLanguage(ctx.previous)
    },
  })

  return (
    <div
      role="group"
      aria-label={t('sidebar.languageGroupLabel')}
      className={`language-switch ${className ?? ''}`.trim()}
    >
      <div className="language-switch__options">
        {SUPPORTED_LANGUAGES.map((lang) => {
          const labelKey = lang === 'zh-CN' ? 'sidebar.lang.zh' : 'sidebar.lang.en'
          const active = lang === current
          return (
            <button
              key={lang}
              type="button"
              role="radio"
              aria-checked={active}
              data-lang={lang}
              className={`language-switch__option ${active ? 'language-switch__option--active' : ''}`.trim()}
              disabled={mutation.isPending}
              onClick={() => {
                if (lang === current) return
                mutation.mutate(lang)
              }}
            >
              {t(labelKey)}
            </button>
          )
        })}
      </div>
      {mutation.error && (
        <div className="language-switch__error" role="alert">
          {describeApiError(mutation.error)}
        </div>
      )}
    </div>
  )
}
