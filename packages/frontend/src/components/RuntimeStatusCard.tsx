// RFC-001 + RFC-111: read-only runtime status card shown at the top of the
// Settings → Runtime tab. Calls GET /api/runtime/opencode (default) or, with
// `runtime="claude"`, GET /api/runtime/claude. Renders one of three states
// (probing / ok / failed) and offers a manual "Re-probe" button.
//
// The opencode probe is a hard daemon requirement (a red dot signals a broken
// install). The claude probe is SOFT (RFC-111 D10): claude-code is an optional
// second runtime, so a missing binary renders neutrally (grey dot + "optional"
// hint) and never implies the daemon itself is unhealthy.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { RuntimeClaudeStatus, RuntimeOpencodeStatus } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { describeApiError } from '@/i18n'

export const RUNTIME_OPENCODE_QUERY_KEY = ['runtime', 'opencode'] as const
/** RFC-111: soft claude-code probe (GET /api/runtime/claude). */
export const RUNTIME_CLAUDE_QUERY_KEY = ['runtime', 'claude'] as const

type RuntimeKind = 'opencode' | 'claude'
type RuntimeStatus = RuntimeOpencodeStatus | RuntimeClaudeStatus

interface Props {
  runtime?: RuntimeKind
}

export function RuntimeStatusCard({ runtime = 'opencode' }: Props = {}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const isClaude = runtime === 'claude'
  const queryKey = isClaude ? RUNTIME_CLAUDE_QUERY_KEY : RUNTIME_OPENCODE_QUERY_KEY
  const path = isClaude ? '/api/runtime/claude' : '/api/runtime/opencode'
  const probe = useQuery<RuntimeStatus>({
    queryKey,
    queryFn: ({ signal }) => api.get(path, undefined, signal),
    staleTime: 30_000,
  })

  const reprobe = (): void => {
    void qc.invalidateQueries({ queryKey })
  }

  const titleKey = isClaude
    ? 'settingsForm.claudeRuntimeStatusTitle'
    : 'settingsForm.runtimeStatusTitle'

  return (
    <div className="info-box-muted" style={{ marginBottom: 16 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
      >
        <strong>{t(titleKey)}</strong>
        <button
          type="button"
          className="btn"
          onClick={reprobe}
          disabled={probe.isFetching}
          style={{ fontSize: 12, padding: '2px 10px' }}
        >
          {t('settingsForm.runtimeStatusReprobe')}
        </button>
      </div>
      <div style={{ marginTop: 8 }}>{renderBody(probe, t, isClaude)}</div>
    </div>
  )
}

function renderBody(
  probe: ReturnType<typeof useQuery<RuntimeStatus>>,
  t: (key: string, opts?: Record<string, unknown>) => string,
  isClaude: boolean,
) {
  // Per-runtime copy: the shared "ok / incompatible / binary / min version"
  // lines are runtime-agnostic; only the runtime-named ones differ. The claude
  // variants read as optional so a missing claude doesn't look like a fault.
  const probingKey = isClaude
    ? 'settingsForm.claudeRuntimeStatusProbing'
    : 'settingsForm.runtimeStatusProbing'
  const notFoundKey = isClaude
    ? 'settingsForm.claudeRuntimeStatusNotFound'
    : 'settingsForm.runtimeStatusNotFound'
  const hintKey = isClaude
    ? 'settingsForm.claudeRuntimeStatusHint'
    : 'settingsForm.runtimeStatusHint'

  if (probe.isLoading) {
    return (
      <p style={{ margin: 0, fontSize: 13 }} className="muted">
        <StatusDot color="grey" /> {t(probingKey)}
      </p>
    )
  }
  if (probe.error !== null && probe.error !== undefined) {
    return (
      <p style={{ margin: 0, fontSize: 13 }} className="error-box">
        {describeApiError(probe.error)}
      </p>
    )
  }
  const data = probe.data
  if (data === undefined) return <></>

  const isOk = data.version !== null && data.compatible
  const isIncompatible = data.version !== null && !data.compatible
  // opencode not-found is a hard fault (red). claude not-found is soft (grey):
  // it's an optional runtime, so only an *incompatible* claude warrants red.
  const dotColor: 'green' | 'red' | 'grey' = isOk
    ? 'green'
    : isIncompatible
      ? 'red'
      : isClaude
        ? 'grey'
        : 'red'

  let line: string
  if (isOk) {
    line = t('settingsForm.runtimeStatusOk', { version: data.version })
  } else if (isIncompatible) {
    line = t('settingsForm.runtimeStatusIncompatible', {
      version: data.version,
      minVersion: data.minVersion,
    })
  } else {
    line = t(notFoundKey)
  }

  return (
    <>
      <p style={{ margin: 0, fontSize: 13 }} className={!isOk && isClaude ? 'muted' : undefined}>
        <StatusDot color={dotColor} /> {line}
      </p>
      <p style={{ margin: '4px 0 0 0', fontSize: 12 }} className="muted">
        {t('settingsForm.runtimeStatusBinary', { path: data.binary })} ·{' '}
        {t('settingsForm.runtimeStatusMinVersion', { version: data.minVersion })}
      </p>
      {!isOk && (
        <p style={{ margin: '4px 0 0 0', fontSize: 12 }} className="muted">
          {t(hintKey)}
        </p>
      )}
    </>
  )
}

function StatusDot({ color }: { color: 'green' | 'red' | 'grey' }) {
  const bg = color === 'green' ? '#1e8e3e' : color === 'red' ? '#c5221f' : '#9aa0a6'
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: bg,
        marginRight: 6,
        verticalAlign: 'baseline',
      }}
    />
  )
}
