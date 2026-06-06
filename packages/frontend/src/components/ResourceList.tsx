// Shared placeholder list rendering. Real DataTable arrives in P-1-17.

import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

export interface ResourceListItem {
  id: string
  primary: string
  secondary?: string
}

export interface ResourceListProps {
  title: string
  placeholder: string
  items: ResourceListItem[]
  isLoading: boolean
  error: unknown
}

export function ResourceList({ title, placeholder, items, isLoading, error }: ResourceListProps) {
  const { t } = useTranslation()
  return (
    <div className="page">
      <header className="page__header">
        <h1>{title}</h1>
        <p className="page__hint">{placeholder}</p>
      </header>
      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && <ErrorBox error={error} t={t} />}
      {!isLoading && error === null && items.length === 0 && (
        <div className="muted">{t('common.emptyResource', { title: title.toLowerCase() })}</div>
      )}
      {items.length > 0 && (
        <ul className="resource-list">
          {items.map((item) => (
            <li key={item.id} className="resource-list__item">
              <div className="resource-list__primary">{item.primary}</div>
              {item.secondary !== undefined && (
                <div className="resource-list__secondary">{item.secondary}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ErrorBox({ error, t }: { error: unknown; t: TFunction }) {
  let label = t('common.unknownError')
  if (error instanceof ApiError) label = `${error.code}: ${error.message}`
  else if (error instanceof Error) label = error.message
  return <div className="error-box">⚠ {label}</div>
}
