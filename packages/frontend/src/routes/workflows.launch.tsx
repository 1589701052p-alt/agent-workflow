// /workflows/$id/launch — minimal task starter.
//
// Stage 1 scope (P-2-10): recent-repo dropdown + base-branch dropdown
// (via /api/repos/refs) + auto-generated text inputs for each workflow.inputs
// entry. Multi-file / git-object / enum pickers ship later.

import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  RecentRepo,
  RepoRefsResponse,
  Task,
  Workflow,
  WorkflowInput,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { EnumPicker } from '@/components/launch/EnumPicker'
import { FilesPicker } from '@/components/launch/FilesPicker'
import { GitPicker } from '@/components/launch/GitPicker'
import { UploadPicker } from '@/components/launch/UploadPicker'
import { buildLaunchFormData } from '@/components/launch/buildLaunchFormData'
import { RepoSourceTabs } from '@/components/launch/RepoSourceTabs'
import { Field, TextInput } from '@/components/Form'
import {
  buildLaunchBody,
  buildLaunchFormDataV2,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'
import { Route as RootRoute } from './__root'

export const LaunchRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$id/launch',
  component: LaunchPage,
})

function LaunchPage() {
  const { t } = useTranslation()
  const { id } = LaunchRoute.useParams()
  const navigate = useNavigate()
  const workflow = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
  })
  const recent = useQuery<RecentRepo[]>({
    queryKey: ['repos', 'recent'],
    queryFn: ({ signal }) => api.get('/api/repos/recent', undefined, signal),
  })

  // RFC-024: repo source can be a local path OR a remote git URL.
  const [source, setSource] = useState<RepoSource>({
    kind: 'path',
    repoPath: '',
    baseBranch: '',
  })
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // RFC-020: parallel state for `kind: 'upload'` inputs; key → picked Files.
  const [uploads, setUploads] = useState<Record<string, File[]>>({})

  // Seed inputs map when workflow loads.
  useEffect(() => {
    if (workflow.data === undefined) return
    const seeded: Record<string, string> = {}
    for (const i of workflow.data.definition.inputs ?? []) {
      seeded[i.key] = inputs[i.key] ?? ''
    }
    setInputs(seeded)
    // Auto-pick the most recent repo as default (path mode only).
    if (
      source.kind === 'path' &&
      source.repoPath === '' &&
      recent.data !== undefined &&
      recent.data[0] !== undefined
    ) {
      setSource({
        kind: 'path',
        repoPath: recent.data[0].path,
        baseBranch: recent.data[0].defaultBranch ?? '',
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow.data, recent.data])

  const refs = useQuery<RepoRefsResponse>({
    queryKey: ['repos', 'refs', source.kind === 'path' ? source.repoPath : ''],
    queryFn: ({ signal }) =>
      api.get('/api/repos/refs', { path: source.kind === 'path' ? source.repoPath : '' }, signal),
    enabled: source.kind === 'path' && source.repoPath !== '',
  })

  const hasUploads = Object.values(uploads).some((arr) => arr.length > 0)
  const start = useMutation({
    mutationFn: () => {
      // RFC-020: any kind:'upload' input declared on the workflow drives a
      // multipart submit — even when the user picked zero files, so the
      // backend's upload pipeline runs (it gates min/maxCount centrally).
      const hasUploadKind = (workflow.data?.definition.inputs ?? []).some(
        (i) => i.kind === 'upload',
      )
      if (source.kind === 'path' && (hasUploadKind || hasUploads)) {
        const payload = {
          workflowId: id,
          repoPath: source.repoPath,
          baseBranch: source.baseBranch,
          inputs,
        }
        return api.postMultipart<Task>('/api/tasks', buildLaunchFormData(payload, uploads))
      }
      if (source.kind === 'url' && (hasUploadKind || hasUploads)) {
        // RFC-024: URL + uploads not supported by the backend yet — keep the
        // multipart envelope for parity, backend will 422 us politely.
        return api.postMultipart<Task>(
          '/api/tasks',
          buildLaunchFormDataV2(source, { workflowId: id, inputs }, uploads),
        )
      }
      return api.post<Task>('/api/tasks', buildLaunchBody(source, { workflowId: id, inputs }))
    },
    onSuccess: (t) => navigate({ to: '/tasks/$id', params: { id: t.id } }),
  })

  if (workflow.isLoading) return <div className="page muted">{t('editor.loadingWorkflow')}</div>
  if (workflow.error !== null && workflow.error !== undefined)
    return <div className="page error-box">{describeError(workflow.error)}</div>
  if (workflow.data === undefined) return null

  const inputDefs = workflow.data.definition.inputs ?? []
  const missingRequired = inputDefs.some((def) => {
    if (def.kind === 'upload') {
      const list = uploads[def.key] ?? []
      const rec = def as Record<string, unknown>
      const minCount = typeof rec.minCount === 'number' ? rec.minCount : 0
      if (def.required === true && list.length === 0) return true
      if (list.length < minCount) return true
      return false
    }
    return def.required === true && (inputs[def.key] ?? '').trim() === ''
  })
  const repoIssue = source.kind === 'path' ? repoLaunchIssue(refs.data ?? null) : null
  const sourceReady =
    source.kind === 'path'
      ? source.repoPath !== '' && source.baseBranch !== ''
      : validateRepoUrl(source.repoUrl) === null
  const canSubmit = sourceReady && !missingRequired && repoIssue === null && !start.isPending

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('launch.title', { name: workflow.data.name })}</h1>
          <p className="page__hint">
            {t('launch.hintBefore')}
            <code>{t('launch.hintCode')}</code>
            {t('launch.hintAfter')}
          </p>
        </div>
        <Link to="/workflows/$id" params={{ id }} className="btn btn--sm">
          {t('launch.backToEditor')}
        </Link>
      </header>

      {repoIssue === 'no-commits' && <div className="error-box">{t('launch.repoNoCommits')}</div>}

      <div className="form-grid">
        <RepoSourceTabs source={source} onChange={setSource} />

        {source.kind === 'url' && start.isPending && (
          <div className="muted" data-testid="launch-cloning-hint">
            {t('launch.repoSource.cloningHint')}
          </div>
        )}

        {inputDefs.length === 0 && <div className="muted">{t('launch.noInputs')}</div>}

        {inputDefs.map((def) => (
          <Field
            key={def.key}
            label={`${def.label} (${def.key})`}
            required={def.required === true}
            hint={def.description}
          >
            {def.kind === 'upload' ? (
              <UploadPicker
                def={def}
                files={uploads[def.key] ?? []}
                onChange={(next) => setUploads((prev) => ({ ...prev, [def.key]: next }))}
              />
            ) : (
              <DynamicInput
                def={def}
                repoPath={source.kind === 'path' ? source.repoPath : ''}
                value={inputs[def.key] ?? ''}
                onChange={(v) => setInputs((prev) => ({ ...prev, [def.key]: v }))}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => start.mutate()}
          disabled={!canSubmit}
        >
          {start.isPending ? t('launch.starting') : t('launch.start')}
        </button>
        {start.error !== null && start.error !== undefined && (
          <span className="form-actions__error">{describeError(start.error)}</span>
        )}
      </div>
    </div>
  )
}

function DynamicInput({
  def,
  repoPath,
  value,
  onChange,
}: {
  def: WorkflowInput
  repoPath: string
  value: string
  onChange: (next: string) => void
}) {
  if (def.kind === 'text') {
    const multiline = (def as Record<string, unknown>).multiline === true
    if (multiline) {
      return (
        <textarea
          className="form-input"
          rows={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={def.required === true}
        />
      )
    }
    return <TextInput value={value} onChange={onChange} required={def.required === true} />
  }
  if (def.kind === 'files') {
    return <FilesPicker def={def} repoPath={repoPath} value={value} onChange={onChange} />
  }
  if (def.kind === 'enum') {
    return <EnumPicker def={def} value={value} onChange={onChange} />
  }
  if (def.kind === 'git') {
    return <GitPicker def={def} repoPath={repoPath} value={value} onChange={onChange} />
  }
  return <TextInput value={value} onChange={onChange} placeholder={`raw ${def.kind} value`} />
}

/**
 * RFC-004: the launcher form is driven solely by `definition.inputs[]`. The
 * input nodes on the canvas don't show up as form fields by themselves — they
 * route the value at task-run time into the graph. Exporting this trivial
 * accessor pins the contract so a future refactor can't quietly switch the
 * launcher to "scan input nodes" and bypass the inputs[] declaration.
 */
export function launcherFieldDefs(
  def:
    | {
        inputs?: WorkflowInput[]
      }
    | undefined,
): WorkflowInput[] {
  return def?.inputs ?? []
}

/**
 * Pre-launch validation of the chosen repo. Returns a stable issue code
 * the UI uses to render an inline banner AND disable Start.
 *
 * Today the only blocking case is `no-commits`: `git init -b main` alone
 * leaves the unborn `main` ref unresolvable, so `git worktree add` later
 * fails with `cannot resolve base ref 'main'`. We want to refuse the
 * launch up front rather than queue a doomed task.
 *
 * Returns `null` when refs haven't loaded yet OR the repo is launchable —
 * the caller folds the `null` case into its other gating predicates
 * (e.g. missingRequired, repoPath !== '').
 *
 * Exported for unit tests.
 */
export function repoLaunchIssue(refs: { hasCommits: boolean } | null): 'no-commits' | null {
  if (refs === null) return null
  if (refs.hasCommits === false) return 'no-commits'
  return null
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
