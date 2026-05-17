// RFC-024 — pure helpers for the launcher's two-mode Repo source picker.
//
// Keeping these out of the route component so the body / formdata shape is
// trivially unit-testable without spinning up the route harness.

import { parseGitUrl } from '@agent-workflow/shared'

export type RepoSource =
  | { kind: 'path'; repoPath: string; baseBranch: string }
  | { kind: 'url'; repoUrl: string; ref: string }

export interface LaunchCommonPayload {
  workflowId: string
  inputs: Record<string, string>
}

/**
 * Compose the JSON body for `POST /api/tasks` based on the active source
 * mode. URL mode omits `baseBranch` (the backend falls back to the cached
 * repo's default branch). Empty `ref` is dropped so the schema's
 * `min(1).optional()` doesn't reject `""`.
 */
export function buildLaunchBody(
  source: RepoSource,
  common: LaunchCommonPayload,
): Record<string, unknown> {
  if (source.kind === 'path') {
    return {
      workflowId: common.workflowId,
      repoPath: source.repoPath,
      baseBranch: source.baseBranch,
      inputs: common.inputs,
    }
  }
  const out: Record<string, unknown> = {
    workflowId: common.workflowId,
    repoUrl: source.repoUrl,
    inputs: common.inputs,
  }
  if (source.ref.trim().length > 0) out.ref = source.ref.trim()
  return out
}

/**
 * Same shape as `buildLaunchBody`, but stamps it into the existing multipart
 * envelope used by RFC-020 uploads. Wrapping in this helper keeps the
 * launcher's "uploads + url" combo encoded consistently — though the
 * backend currently rejects that combo with `multipart-upload-requires-
 * path-mode`, the frontend still has to send the bytes somewhere.
 */
export function buildLaunchFormDataV2(
  source: RepoSource,
  common: LaunchCommonPayload,
  uploads: Record<string, File[]>,
): FormData {
  const inputsOut: Record<string, string> = { ...common.inputs }
  for (const key of Object.keys(uploads)) {
    if (!(key in inputsOut)) inputsOut[key] = ''
  }
  const body = buildLaunchBody(source, { ...common, inputs: inputsOut })
  const fd = new FormData()
  fd.set('payload', new Blob([JSON.stringify(body)], { type: 'application/json' }))
  for (const [key, list] of Object.entries(uploads)) {
    for (const f of list) {
      fd.append(`files[${key}][]`, f, f.name)
    }
  }
  return fd
}

/**
 * Inline validation for the URL field. Returns:
 *   - 'empty'    — URL hasn't been typed yet (Start stays disabled).
 *   - 'invalid'  — URL doesn't parse via `parseGitUrl`. UI renders red copy.
 *   - null       — looks plausible; submission can proceed.
 */
export function validateRepoUrl(input: string): 'empty' | 'invalid' | null {
  const v = input.trim()
  if (v.length === 0) return 'empty'
  if (parseGitUrl(v) === null) return 'invalid'
  return null
}
