// P-5-03 stage 1: i18next + react-i18next bootstrap.
//
// Default language is zh-CN (matches `Config.language` default). The detector
// reads `localStorage.aw-language` first, then the browser navigator.language.
//
// Usage:
//   import { useTranslation } from 'react-i18next'
//   const { t } = useTranslation()
//   <span>{t('nav.agents')}</span>
//
// For backend ApiError → user-facing message, use `describeApiError` below.

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { ApiError } from '@/api/client'
import { enUS } from './en-US'
import { zhCN } from './zh-CN'

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const LANG_STORAGE_KEY = 'aw-language'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANG_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  })

export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang)
}

/**
 * Map a backend ApiError to a human-facing message in the current locale.
 * Unknown codes fall back to the raw `message` field, prefixed with the
 * generic 'fallback' string. This keeps stack-trace-style codes useful for
 * debugging while still showing something readable in the UI.
 */
export function describeApiError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : String(err)
  }
  const t = i18n.t.bind(i18n)
  const exists = i18n.exists(`errors.${err.code}`)
  if (exists) return t(`errors.${err.code}`)
  // Fall back to: "<localized 'Request failed'>: <backend message>"
  return `${t('errors.fallback')}: ${err.message}`
}

export default i18n
