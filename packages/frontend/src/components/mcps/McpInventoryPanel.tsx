// RFC-030 — Inventory panel on /mcps/$name.
//
// Composed of four collapsible <details> sections (Tools / Resources / Prompts /
// Capabilities) plus a sticky header with the status chip, last-probed
// timestamp, latency, and a "Re-probe" button. On error, an error box at
// the top of the body surfaces errorCode + errorMessage with a collapsible
// errorDetail JSON viewer.
//
// We use the standard probe query hooks so this panel and the list page
// stay cache-coherent: re-probing here invalidates the same keys the list
// page reads from.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { McpProbe, McpToolInfo } from '@agent-workflow/shared'
import { McpProbeStatusChip, type McpProbeUiStatus } from '@/components/McpProbeStatusChip'
import { useMcpProbe, useProbeMcpMutation } from '@/lib/mcp-probe-query'

export interface McpInventoryPanelProps {
  mcpName: string
}

export function McpInventoryPanel(props: McpInventoryPanelProps) {
  const { t } = useTranslation()
  const probeQ = useMcpProbe(props.mcpName)
  const probeMut = useProbeMcpMutation(props.mcpName)

  const probe = probeQ.data ?? null
  const isProbing = probeMut.isPending
  const uiStatus: McpProbeUiStatus = isProbing
    ? 'probing'
    : probe === null
      ? 'unknown'
      : probe.status === 'ok'
        ? 'ok'
        : 'error'

  return (
    <section id="inventory" className="mcp-inventory">
      <header className="mcp-inventory__header">
        <h2 className="mcp-inventory__title">
          {t('mcps.probe.section.tools')} · {t('mcps.probe.section.resources')} ·{' '}
          {t('mcps.probe.section.prompts')}
        </h2>
        <McpProbeStatusChip status={uiStatus} title={probe?.errorMessage ?? undefined} />
        <span className="mcp-inventory__meta">
          {probe === null
            ? t('mcps.probe.neverProbed')
            : t('mcps.probe.lastProbed', {
                at: formatTimestamp(probe.updatedAt),
              })}
          {probe !== null && ` · ${formatLatency(probe.latencyMs)}`}
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => probeMut.mutate()}
          disabled={isProbing}
          data-testid={`mcp-inventory-reprobe-${props.mcpName}`}
        >
          {isProbing ? t('mcps.probe.btnRunning') : t('mcps.probe.btnRun')}
        </button>
      </header>

      {probe !== null && (probe.status === 'error' || probe.errorCode === 'partial') && (
        <ErrorBox probe={probe} />
      )}

      {probe === null ? (
        <p className="muted">{t('mcps.probe.neverProbed')}</p>
      ) : (
        <>
          <ToolsSection tools={probe.tools} />
          <ResourcesSection resources={probe.resources} templates={probe.resourceTemplates} />
          <PromptsSection prompts={probe.prompts} />
          <CapabilitiesSection capabilities={probe.capabilities} />
        </>
      )}
    </section>
  )
}

function ErrorBox(props: { probe: McpProbe }) {
  const { t } = useTranslation()
  const [showDetail, setShowDetail] = useState(false)
  const codeKey = errorCodeI18nKey(props.probe.errorCode)
  return (
    <div className="mcp-inventory__error" data-testid="mcp-inventory-error">
      <p className="mcp-inventory__error-title">{t('mcps.probe.error.title')}</p>
      <p className="mcp-inventory__error-message">
        {codeKey !== null ? t(codeKey) : t('mcps.probe.error.codeInternalError')}
      </p>
      {props.probe.errorMessage !== null && props.probe.errorMessage !== '' && (
        <p className="mcp-inventory__error-message">{props.probe.errorMessage}</p>
      )}
      {props.probe.errorDetail !== null && (
        <>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowDetail((v) => !v)}
            data-testid="mcp-inventory-error-detail-toggle"
          >
            {showDetail ? t('mcps.probe.error.hideDetail') : t('mcps.probe.error.showDetail')}
          </button>
          {showDetail && (
            <pre className="mcp-inventory__tool-schema">
              {JSON.stringify(props.probe.errorDetail, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

function errorCodeI18nKey(code: McpProbe['errorCode']): string | null {
  if (code === null) return null
  switch (code) {
    case 'connect-failed':
      return 'mcps.probe.error.codeConnectFailed'
    case 'handshake-failed':
      return 'mcps.probe.error.codeHandshakeFailed'
    case 'auth-required':
      return 'mcps.probe.error.codeAuthRequired'
    case 'timeout':
      return 'mcps.probe.error.codeTimeout'
    case 'partial':
      return 'mcps.probe.error.codePartial'
    case 'internal-error':
      return 'mcps.probe.error.codeInternalError'
    case 'mcp-disabled':
      return 'mcps.probe.error.codeMcpDisabled'
    default:
      return 'mcps.probe.error.codeInternalError'
  }
}

function ToolsSection(props: { tools: McpToolInfo[] | null }) {
  const { t } = useTranslation()
  const tools = props.tools ?? []
  return (
    <details className="mcp-inventory__section" open data-testid="mcp-inventory-tools">
      <summary>
        {t('mcps.probe.section.tools')} ({tools.length})
      </summary>
      {tools.length === 0 ? (
        <p className="muted">{t('mcps.probe.tools.empty')}</p>
      ) : (
        tools.map((tool) => <McpToolRow key={tool.name} tool={tool} />)
      )}
    </details>
  )
}

function McpToolRow(props: { tool: McpToolInfo }) {
  const { t } = useTranslation()
  const [showSchema, setShowSchema] = useState(false)
  const desc = props.tool.description ?? ''
  const hasSchema = props.tool.inputSchema !== undefined && props.tool.inputSchema !== null
  return (
    <div className="mcp-inventory__tool" data-testid={`mcp-tool-row-${props.tool.name}`}>
      <div className="mcp-inventory__tool-name">{props.tool.name}</div>
      <div className="mcp-inventory__tool-desc">
        {desc === '' ? t('mcps.probe.tools.descriptionEmpty') : desc}
      </div>
      <div className="mcp-inventory__tool-schema">
        {hasSchema ? (
          <details onToggle={(e) => setShowSchema((e.target as HTMLDetailsElement).open)}>
            <summary data-testid={`mcp-tool-schema-toggle-${props.tool.name}`}>
              {showSchema ? t('mcps.probe.tools.hideSchema') : t('mcps.probe.tools.showSchema')}
            </summary>
            <pre data-testid={`mcp-tool-schema-${props.tool.name}`}>
              {JSON.stringify(props.tool.inputSchema, null, 2)}
            </pre>
          </details>
        ) : (
          <span className="muted">{t('mcps.probe.tools.noInputSchema')}</span>
        )}
      </div>
    </div>
  )
}

function ResourcesSection(props: {
  resources: McpProbe['resources']
  templates: McpProbe['resourceTemplates']
}) {
  const { t } = useTranslation()
  const r = props.resources ?? []
  const tpls = props.templates ?? []
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-resources">
      <summary>
        {t('mcps.probe.section.resources')} ({r.length + tpls.length})
      </summary>
      {r.length === 0 && tpls.length === 0 ? (
        <p className="muted">{t('mcps.probe.resources.empty')}</p>
      ) : (
        <>
          <ul>
            {r.map((x) => (
              <li key={x.uri}>
                <code>{x.uri}</code>
                {x.name !== undefined && ` — ${x.name}`}
              </li>
            ))}
          </ul>
          {tpls.length > 0 && (
            <>
              <p className="mcp-inventory__tool-desc">
                {t('mcps.probe.resources.templatesHeading')}
              </p>
              <ul>
                {tpls.map((x) => (
                  <li key={x.uriTemplate}>
                    <code>{x.uriTemplate}</code>
                    {x.name !== undefined && ` — ${x.name}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </details>
  )
}

function PromptsSection(props: { prompts: McpProbe['prompts'] }) {
  const { t } = useTranslation()
  const prompts = props.prompts ?? []
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-prompts">
      <summary>
        {t('mcps.probe.section.prompts')} ({prompts.length})
      </summary>
      {prompts.length === 0 ? (
        <p className="muted">{t('mcps.probe.prompts.empty')}</p>
      ) : (
        prompts.map((p) => (
          <div key={p.name} className="mcp-inventory__tool">
            <div className="mcp-inventory__tool-name">{p.name}</div>
            {p.description !== undefined && (
              <div className="mcp-inventory__tool-desc">{p.description}</div>
            )}
            {p.arguments !== undefined && p.arguments.length > 0 && (
              <>
                <div className="mcp-inventory__tool-desc">
                  {t('mcps.probe.prompts.argumentsHeading')}
                </div>
                <ul>
                  {p.arguments.map((a) => (
                    <li key={a.name}>
                      <code>{a.name}</code>
                      {a.required === true && ` · ${t('mcps.probe.prompts.argumentRequired')}`}
                      {a.description !== undefined && ` — ${a.description}`}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ))
      )}
    </details>
  )
}

function CapabilitiesSection(props: { capabilities: McpProbe['capabilities'] }) {
  const { t } = useTranslation()
  const caps = props.capabilities ?? {}
  const keys = Object.keys(caps)
  return (
    <details className="mcp-inventory__section" data-testid="mcp-inventory-capabilities">
      <summary>
        {t('mcps.probe.section.capabilities')} ({keys.length})
      </summary>
      {keys.length === 0 ? (
        <p className="muted">{t('mcps.probe.capabilities.empty')}</p>
      ) : (
        <pre className="mcp-inventory__tool-schema">{JSON.stringify(caps, null, 2)}</pre>
      )}
    </details>
  )
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}
