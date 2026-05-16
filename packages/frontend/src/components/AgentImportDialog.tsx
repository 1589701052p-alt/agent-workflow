// RFC-018 — Import dialog for /agents/new.
// Two input paths: upload .md / .markdown file, or paste raw text.
// Hands the parsed result back via onApply for merge into AgentForm draft.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentMarkdownParseResult, CreateAgent } from '@agent-workflow/shared'
import { parseAgentMarkdown } from '@agent-workflow/shared'
import { emptyAgent } from './AgentForm'
import { fieldsOverwrittenByImport } from '@/lib/agent-import-merge'

export interface AgentImportDialogProps {
  open: boolean
  onClose: () => void
  onApply: (result: AgentMarkdownParseResult) => void
  currentValue: CreateAgent
}

type Tab = 'upload' | 'paste'

const ROUTE_KEYS = {
  name: 'agentForm.importDialog.routedTo.name',
  description: 'agentForm.importDialog.routedTo.description',
  model: 'agentForm.importDialog.routedTo.model',
  variant: 'agentForm.importDialog.routedTo.variant',
  temperature: 'agentForm.importDialog.routedTo.temperature',
  steps: 'agentForm.importDialog.routedTo.steps',
  maxSteps: 'agentForm.importDialog.routedTo.maxSteps',
  permission: 'agentForm.importDialog.routedTo.permission',
  bodyMd: 'agentForm.importDialog.routedTo.bodyMd',
  frontmatterExtra: 'agentForm.importDialog.routedTo.frontmatterExtra',
} as const

export function AgentImportDialog({
  open,
  onClose,
  onApply,
  currentValue,
}: AgentImportDialogProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('upload')
  const [rawText, setRawText] = useState('')
  const [filenameStem, setFilenameStem] = useState<string | undefined>(undefined)
  const [parseResult, setParseResult] = useState<AgentMarkdownParseResult | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) {
      // Reset state every time dialog re-opens for a fresh import session.
      setTab('upload')
      setRawText('')
      setFilenameStem(undefined)
      setParseResult(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const willOverwrite = useMemo(() => {
    if (parseResult === null) return [] as string[]
    return fieldsOverwrittenByImport(currentValue, parseResult, emptyAgent())
  }, [parseResult, currentValue])

  const hasYamlError =
    parseResult?.warnings.some((w) => w.startsWith('yaml-parse-failed:')) ?? false

  if (!open) return null

  async function onFileSelected(file: File | null) {
    if (!file) return
    const text = await file.text()
    setRawText(text)
    const m = /^(.+?)(?:\.(?:md|markdown))?$/i.exec(file.name)
    setFilenameStem(m?.[1] ?? file.name)
    setParseResult(null)
  }

  function doParse() {
    if (rawText === '') return
    const r = parseAgentMarkdown(rawText, {
      filenameStem: tab === 'upload' ? filenameStem : undefined,
    })
    setParseResult(r)
  }

  function doApply() {
    if (parseResult === null || hasYamlError) return
    onApply(parseResult)
    onClose()
  }

  function describePreview(): Array<{
    field: string
    value: string
    routeKey: string
  }> {
    if (parseResult === null) return []
    const out: Array<{ field: string; value: string; routeKey: string }> = []
    const p = parseResult.partial
    const add = (field: keyof typeof p, routeKey: string, valueStr?: string) => {
      const v = p[field]
      if (v === undefined) return
      out.push({
        field,
        value: valueStr ?? renderPreviewValue(v),
        routeKey,
      })
    }
    add('name', ROUTE_KEYS.name)
    add('description', ROUTE_KEYS.description)
    add('model', ROUTE_KEYS.model)
    add('variant', ROUTE_KEYS.variant)
    add('temperature', ROUTE_KEYS.temperature)
    add('steps', ROUTE_KEYS.steps)
    add('maxSteps', ROUTE_KEYS.maxSteps)
    add('permission', ROUTE_KEYS.permission)
    if (p.frontmatterExtra !== undefined) {
      for (const key of Object.keys(p.frontmatterExtra)) {
        out.push({
          field: key,
          value: renderPreviewValue(p.frontmatterExtra[key]),
          routeKey: ROUTE_KEYS.frontmatterExtra,
        })
      }
    }
    if (p.bodyMd !== undefined) {
      const sz = new Blob([p.bodyMd]).size
      out.push({
        field: 'body',
        value: t('agentForm.importDialog.bodySizeHint', { bytes: sz }),
        routeKey: ROUTE_KEYS.bodyMd,
      })
    }
    return out
  }

  const previewRows = describePreview()

  return (
    <div
      className="agent-import__overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="agent-import__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="agent-import__header">
          <h2 id={titleId}>{t('agentForm.importDialog.title')}</h2>
          <button
            type="button"
            className="btn btn--sm agent-import__close"
            onClick={onClose}
            aria-label={t('agentForm.importDialog.cancelButton')}
          >
            ×
          </button>
        </header>

        <div className="agent-import__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'upload'}
            className={`agent-import__tab${tab === 'upload' ? ' is-active' : ''}`}
            onClick={() => setTab('upload')}
          >
            {t('agentForm.importDialog.tabUpload')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'paste'}
            className={`agent-import__tab${tab === 'paste' ? ' is-active' : ''}`}
            onClick={() => setTab('paste')}
          >
            {t('agentForm.importDialog.tabPaste')}
          </button>
        </div>

        {tab === 'upload' ? (
          <div className="agent-import__upload">
            <input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              data-testid="agent-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                void onFileSelected(f)
              }}
            />
            {filenameStem !== undefined && (
              <p className="agent-import__filename">
                {t('agentForm.importDialog.selectedFile', { name: filenameStem })}
              </p>
            )}
          </div>
        ) : (
          <textarea
            className="form-input agent-import__textarea"
            rows={14}
            value={rawText}
            data-testid="agent-import-textarea"
            placeholder={t('agentForm.importDialog.pastePlaceholder')}
            onChange={(e) => {
              setRawText(e.target.value)
              setFilenameStem(undefined)
              setParseResult(null)
            }}
          />
        )}

        <div className="agent-import__actions-row">
          <button
            type="button"
            className="btn"
            disabled={rawText === ''}
            data-testid="agent-import-parse"
            onClick={doParse}
          >
            {t('agentForm.importDialog.parseButton')}
          </button>
          <span className="agent-import__hint">{t('agentForm.importDialog.footerHint')}</span>
        </div>

        {parseResult !== null && (
          <section className="agent-import__preview" aria-live="polite">
            {hasYamlError && (
              <div className="agent-import__warning" data-testid="agent-import-warning">
                {parseResult.warnings.find((w) => w.startsWith('yaml-parse-failed:'))}
              </div>
            )}
            {!hasYamlError && willOverwrite.length > 0 && (
              <div className="agent-import__overwrite" data-testid="agent-import-overwrite">
                {t('agentForm.importDialog.willOverwrite', {
                  count: willOverwrite.length,
                  fields: willOverwrite.join(', '),
                })}
              </div>
            )}
            {!hasYamlError && parseResult.warnings.length > 0 && (
              <ul className="agent-import__warnings">
                {parseResult.warnings
                  .filter((w) => !w.startsWith('yaml-parse-failed:'))
                  .map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
              </ul>
            )}
            {previewRows.length === 0 ? (
              <p className="agent-import__empty">{t('agentForm.importDialog.previewEmpty')}</p>
            ) : (
              <table className="agent-import__table">
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={`${row.field}-${i}`}>
                      <td className="agent-import__field">{row.field}</td>
                      <td className="agent-import__value">{row.value}</td>
                      <td className="agent-import__route">{t(row.routeKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <footer className="agent-import__footer">
          <button type="button" className="btn" onClick={onClose}>
            {t('agentForm.importDialog.cancelButton')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={parseResult === null || hasYamlError}
            data-testid="agent-import-apply"
            onClick={doApply}
          >
            {t('agentForm.importDialog.applyButton')}
          </button>
        </footer>
      </div>
    </div>
  )
}

function renderPreviewValue(v: unknown): string {
  if (typeof v === 'string') {
    return v.length > 60 ? `${v.slice(0, 57)}…` : v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  try {
    const json = JSON.stringify(v)
    return json.length > 60 ? `${json.slice(0, 57)}…` : json
  } catch {
    return String(v)
  }
}
