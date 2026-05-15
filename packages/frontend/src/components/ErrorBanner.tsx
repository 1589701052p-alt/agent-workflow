// Shared inline error banner used by list pages.

import { useTranslation } from 'react-i18next'
import { ApiError } from '@/api/client'

export function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useTranslation()
  let msg = t('common.unknownError')
  if (error instanceof ApiError) msg = `${error.code}: ${error.message}`
  else if (error instanceof Error) msg = error.message
  return <div className="error-box">⚠ {msg}</div>
}
