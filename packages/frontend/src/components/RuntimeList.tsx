// RFC-112 — runtime registry list (replaces the two stacked RuntimeStatusCards
// in Settings → Runtime). Each row is a registered runtime: name + protocol +
// deep-smoke conformance chip + binary path + actions. The two built-ins
// (opencode / claude-code) are read-only (Test only); custom forks add Edit /
// Delete. "Add runtime" + Edit open a Dialog that deep-smokes the binary before
// saving. Admin-only writes are enforced server-side; non-admins still see the
// list (the agent / settings runtime pickers read it).
//
// Reuses the shared primitives only: Dialog, Form Field/TextInput, Select,
// StatusChip, ErrorBanner/LoadingState — no native modal chrome / inputs.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'

export const RUNTIMES_QUERY_KEY = ['runtimes'] as const

type RuntimeProtocol = 'opencode' | 'claude-code'

interface SmokeResult {
  outcome:
    | 'conforms'
    | 'spawn-failed'
    | 'auth-missing'
    | 'model-call-failed'
    | 'stream-nonconforming'
  conforms: boolean
  detail: string
  sawNonce?: boolean
  sawEnvelope?: boolean
  exitCode?: number | null
}

interface RuntimeView {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  builtin: boolean
  lastProbe: SmokeResult | null
  createdAt: number
  updatedAt: number
}

/** Map a smoke outcome to a StatusChip kind (green/amber/red/neutral). */
function smokeChipKind(probe: SmokeResult | null): 'success' | 'warn' | 'danger' | 'neutral' {
  if (probe === null) return 'neutral'
  if (probe.conforms) return 'success'
  if (probe.outcome === 'auth-missing' || probe.outcome === 'model-call-failed') return 'warn'
  return 'danger'
}

export function RuntimeList() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<RuntimeView | 'new' | null>(null)

  const list = useQuery<{ runtimes: RuntimeView[] }>({
    queryKey: RUNTIMES_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes', undefined, signal),
    staleTime: 30_000,
  })

  const probe = useMutation({
    mutationFn: (name: string) =>
      api.post<{ smoke: SmokeResult }>(`/api/runtimes/${encodeURIComponent(name)}/probe`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY }),
  })

  const del = useMutation({
    mutationFn: (name: string) => api.delete(`/api/runtimes/${encodeURIComponent(name)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY }),
  })

  const runtimes = list.data?.runtimes ?? []

  return (
    <div className="page__section" style={{ marginBottom: 16 }}>
      <div className="page__header--row" style={{ marginBottom: 8 }}>
        <strong>{t('runtimes.title')}</strong>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setEditing('new')}
        >
          {t('runtimes.add')}
        </button>
      </div>
      <p className="muted" style={{ margin: '0 0 12px 0', fontSize: 13 }}>
        {t('runtimes.subtitle')}
      </p>

      {list.isLoading ? (
        <LoadingState />
      ) : list.error !== null && list.error !== undefined ? (
        <ErrorBanner error={list.error} />
      ) : (
        <ul className="runtime-list" role="list">
          {runtimes.map((rt) => (
            <li key={rt.name} className="runtime-list__row" role="listitem">
              <div className="runtime-list__main">
                <span className="runtime-list__name">{rt.name}</span>
                <StatusChip kind="neutral" size="sm">
                  {rt.protocol === 'claude-code'
                    ? t('runtimes.protocolClaude')
                    : t('runtimes.protocolOpencode')}
                </StatusChip>
                {rt.builtin && (
                  <StatusChip kind="neutral" size="sm">
                    {t('runtimes.builtin')}
                  </StatusChip>
                )}
                <StatusChip kind={smokeChipKind(rt.lastProbe)} size="sm" withDot>
                  {rt.lastProbe === null
                    ? t('runtimes.smokeUntested')
                    : t(`runtimes.smoke.${rt.lastProbe.outcome}`)}
                </StatusChip>
              </div>
              <div className="runtime-list__meta">
                <code className="runtime-list__binary">
                  {rt.binaryPath ?? t('runtimes.defaultBinary')}
                </code>
              </div>
              <div className="runtime-list__actions">
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={probe.isPending}
                  onClick={() => probe.mutate(rt.name)}
                >
                  {t('runtimes.test')}
                </button>
                {!rt.builtin && (
                  <>
                    <button type="button" className="btn btn--xs" onClick={() => setEditing(rt)}>
                      {t('runtimes.edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--xs btn--danger"
                      disabled={del.isPending}
                      onClick={() => del.mutate(rt.name)}
                    >
                      {t('runtimes.delete')}
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}

      {editing !== null && (
        <RuntimeFormDialog
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void qc.invalidateQueries({ queryKey: RUNTIMES_QUERY_KEY })
          }}
        />
      )}
    </div>
  )
}

function RuntimeFormDialog(props: {
  existing: RuntimeView | null
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const isEdit = props.existing !== null
  const [name, setName] = useState(props.existing?.name ?? '')
  const [protocol, setProtocol] = useState<RuntimeProtocol>(props.existing?.protocol ?? 'opencode')
  const [binaryPath, setBinaryPath] = useState(props.existing?.binaryPath ?? '')
  const [smoke, setSmoke] = useState<SmokeResult | null>(props.existing?.lastProbe ?? null)

  const test = useMutation({
    mutationFn: () =>
      api.post<{ smoke: SmokeResult }>('/api/runtimes/probe', {
        protocol,
        binaryPath: binaryPath.trim(),
      }),
    onSuccess: (r) => setSmoke(r.smoke),
  })

  const save = useMutation({
    mutationFn: () => {
      const trimmed = binaryPath.trim()
      if (isEdit) {
        return api.put(`/api/runtimes/${encodeURIComponent(name)}`, {
          binaryPath: trimmed === '' ? null : trimmed,
        })
      }
      return api.post('/api/runtimes', {
        name: name.trim(),
        protocol,
        ...(trimmed === '' ? {} : { binaryPath: trimmed }),
        probe: trimmed !== '',
      })
    },
    onSuccess: () => props.onSaved(),
  })

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={isEdit ? t('runtimes.editTitle') : t('runtimes.addTitle')}
      footer={
        <>
          <button
            type="button"
            className="btn"
            disabled={test.isPending || binaryPath.trim() === ''}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t('runtimes.testing') : t('runtimes.testBinary')}
          </button>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || (!isEdit && name.trim() === '')}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <Field label={t('runtimes.fieldName')} hint={t('runtimes.fieldNameHint')} required>
        <TextInput value={name} onChange={setName} disabled={isEdit} data-testid="runtime-name" />
      </Field>
      <Field label={t('runtimes.fieldProtocol')} hint={t('runtimes.fieldProtocolHint')}>
        <Select<RuntimeProtocol>
          value={protocol}
          ariaLabel={t('runtimes.fieldProtocol')}
          onChange={setProtocol}
          disabled={isEdit}
          options={[
            { value: 'opencode', label: t('runtimes.protocolOpencode') },
            { value: 'claude-code', label: t('runtimes.protocolClaude') },
          ]}
        />
      </Field>
      <Field label={t('runtimes.fieldBinary')} hint={t('runtimes.fieldBinaryHint')}>
        <TextInput
          value={binaryPath}
          onChange={setBinaryPath}
          placeholder={t('runtimes.defaultBinary')}
          data-testid="runtime-binary"
        />
      </Field>
      {smoke !== null && (
        <div style={{ marginTop: 8 }}>
          <StatusChip kind={smokeChipKind(smoke)} size="sm" withDot>
            {t(`runtimes.smoke.${smoke.outcome}`)}
          </StatusChip>
          <p className="muted" style={{ margin: '4px 0 0 0', fontSize: 12 }}>
            {smoke.detail}
          </p>
        </div>
      )}
      {test.error !== null && test.error !== undefined && <ErrorBanner error={test.error} />}
      {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
    </Dialog>
  )
}
