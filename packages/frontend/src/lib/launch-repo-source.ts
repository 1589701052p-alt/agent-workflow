// RFC-024 — pure helpers for the launcher's two-mode Repo source picker.
//
// Keeping these out of the route component so the body / formdata shape is
// trivially unit-testable without spinning up the route harness.

import { parseGitUrl } from '@agent-workflow/shared'

export type RepoSource =
  | {
      kind: 'path'
      repoPath: string
      baseBranch: string
      /**
       * RFC-068 — opt-in `git fetch --all --prune --tags` against the user's
       * local repo before the worktree is materialized. Never `pull` /
       * `merge` — only refreshes remote-tracking refs so the user can pick
       * `origin/<branch>` as a base ref. Default false to preserve legacy
       * (no-fetch) behavior. UI persists last value to localStorage.
       */
      fetchBeforeLaunch?: boolean
    }
  | { kind: 'url'; repoUrl: string; ref: string }

export interface LaunchCommonPayload {
  workflowId: string
  /**
   * RFC-037: user-supplied display name. Required by the backend's
   * `StartTaskSchema`; both helpers stamp it into the outgoing body verbatim
   * (after the caller has trimmed). The schema rejects empty / overlong
   * names server-side, so the helper does not need to re-validate.
   */
  name: string
  inputs: Record<string, string>
  /**
   * RFC-067: optional per-task Git commit identity. Caller has already
   * trimmed; both must be non-empty together or both omitted (XOR enforced
   * client-side via the launcher's `gitIdentityOk` gate + server-side via
   * StartTaskSchema's superRefine). When present, the helper writes both
   * keys into the body; when undefined or blank, the helper omits both keys
   * so the wire is byte-identical to pre-RFC-067 launches.
   */
  gitUserName?: string
  gitUserEmail?: string
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
  // RFC-067: identity pair-check echoes superRefine. Drop both keys if
  // either side is blank — the helper never emits a half-identity wire.
  const hasGitIdentity =
    typeof common.gitUserName === 'string' &&
    common.gitUserName.length > 0 &&
    typeof common.gitUserEmail === 'string' &&
    common.gitUserEmail.length > 0
  if (source.kind === 'path') {
    const out: Record<string, unknown> = {
      workflowId: common.workflowId,
      name: common.name,
      repoPath: source.repoPath,
      baseBranch: source.baseBranch,
      inputs: common.inputs,
    }
    // RFC-068: only set when explicitly true so legacy bodies stay byte-
    // identical (`undefined` field would survive JSON serialization
    // anyway, but explicit gate keeps the wire format clean).
    if (source.fetchBeforeLaunch === true) out.fetchBeforeLaunch = true
    if (hasGitIdentity) {
      out.gitUserName = common.gitUserName
      out.gitUserEmail = common.gitUserEmail
    }
    return out
  }
  const out: Record<string, unknown> = {
    workflowId: common.workflowId,
    name: common.name,
    repoUrl: source.repoUrl,
    inputs: common.inputs,
  }
  if (source.ref.trim().length > 0) out.ref = source.ref.trim()
  if (hasGitIdentity) {
    out.gitUserName = common.gitUserName
    out.gitUserEmail = common.gitUserEmail
  }
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
