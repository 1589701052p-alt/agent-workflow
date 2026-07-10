// RFC-164 PR-4 — pure helpers for the /workgroups/launch page.
//
// `buildWorkgroupLaunchBody` composes the POST /api/workgroups/:name/tasks
// body. The repo-source / git-identity / extras composition is DELEGATED to
// lib/launch-repo-source's builders (single source — RFC-125 lesson: a
// whitelist body helper someone forgets to extend silently drops fields), and
// the two workflow-launch-only keys they stamp (workflowId / inputs) are
// stripped afterwards because StartWorkgroupTaskSchema doesn't know them —
// the service composes its own StartTask candidate around the builtin host.
//
// `workgroupLaunchErrorMessage` maps the launch endpoint's three 422 codes to
// friendly localized copy (unknown codes fall back to describeApiError).

import { ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import {
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  defaultRepoSource,
  type RepoSource,
} from './launch-repo-source'

export interface WorkgroupLaunchCommon {
  /** Task display name (caller trims; StartWorkgroupTaskSchema re-trims). */
  name: string
  /** The group's mission statement — injected every turn (决策 #12). */
  goal: string
  collaboratorUserIds?: string[]
  /** Pair-gated like the workflow launcher (both or neither). */
  gitUserName?: string
  gitUserEmail?: string
  workingBranch?: string
  autoCommitPush?: boolean
  maxDurationMs?: number
  maxTotalTokens?: number
}

/**
 * Compose the JSON body for POST /api/workgroups/:name/tasks. Explicitly
 * tested field-by-field (name / goal / repo source shapes) so a future
 * whitelist refactor can't silently drop one (RFC-125 pattern).
 */
export function buildWorkgroupLaunchBody(
  repos: RepoSource[],
  common: WorkgroupLaunchCommon,
): Record<string, unknown> {
  const launchCommon = {
    // Stripped below — the workgroup body has no workflowId / inputs; they
    // only exist so the shared repo-source builders can run unchanged.
    workflowId: '',
    inputs: {},
    name: common.name,
    ...(common.gitUserName !== undefined && common.gitUserEmail !== undefined
      ? { gitUserName: common.gitUserName, gitUserEmail: common.gitUserEmail }
      : {}),
    ...(common.workingBranch !== undefined ? { workingBranch: common.workingBranch } : {}),
    ...(common.autoCommitPush === true ? { autoCommitPush: true } : {}),
    ...(common.collaboratorUserIds !== undefined && common.collaboratorUserIds.length > 0
      ? { collaboratorUserIds: common.collaboratorUserIds }
      : {}),
  }
  const body =
    repos.length > 1
      ? buildLaunchBodyMultiRepo(repos, launchCommon)
      : buildLaunchBody(repos[0] ?? defaultRepoSource(), launchCommon)
  delete body.workflowId
  delete body.inputs
  body.goal = common.goal
  if (common.maxDurationMs !== undefined) body.maxDurationMs = common.maxDurationMs
  if (common.maxTotalTokens !== undefined) body.maxTotalTokens = common.maxTotalTokens
  return body
}

export type WorkgroupLaunchReadinessReason = 'no-agent-member' | 'leader-missing'

/**
 * Structured classification of a launch failure (pure — no i18n). The three
 * codes come from the backend launch path:
 *   - workgroup-not-ready              (services/workgroupLaunch.ts, with
 *                                       details.reasons from the shared
 *                                       workgroupLaunchReadiness oracle)
 *   - workgroup-human-members-unsupported (temporary guard on older daemons —
 *                                       copy must say a later version opens it)
 *   - workgroup-launch-invalid         (routes/workgroups.ts schema 422)
 */
export function classifyWorkgroupLaunchError(
  err: unknown,
):
  | { kind: 'not-ready'; reasons: WorkgroupLaunchReadinessReason[] }
  | { kind: 'human-members-unsupported' }
  | { kind: 'invalid-payload' }
  | { kind: 'other' } {
  if (!(err instanceof ApiError)) return { kind: 'other' }
  if (err.code === 'workgroup-not-ready') {
    const raw =
      typeof err.details === 'object' && err.details !== null
        ? (err.details as { reasons?: unknown }).reasons
        : undefined
    const reasons = (Array.isArray(raw) ? raw : []).filter(
      (r): r is WorkgroupLaunchReadinessReason => r === 'no-agent-member' || r === 'leader-missing',
    )
    return { kind: 'not-ready', reasons }
  }
  if (err.code === 'workgroup-human-members-unsupported') {
    return { kind: 'human-members-unsupported' }
  }
  if (err.code === 'workgroup-launch-invalid') return { kind: 'invalid-payload' }
  return { kind: 'other' }
}

/** Localized message for a launch failure (t = i18next translate). */
export function workgroupLaunchErrorMessage(err: unknown, t: (key: string) => string): string {
  const classified = classifyWorkgroupLaunchError(err)
  switch (classified.kind) {
    case 'not-ready': {
      const parts = classified.reasons.map((r) =>
        r === 'no-agent-member'
          ? t('workgroups.readiness.noAgentMember')
          : t('workgroups.readiness.leaderMissing'),
      )
      return [t('workgroups.launch.notReady'), ...parts].join(' ')
    }
    case 'human-members-unsupported':
      return t('workgroups.launch.humanMembersUnsupported')
    case 'invalid-payload':
      return t('workgroups.launch.invalidPayload')
    case 'other':
      return describeApiError(err)
  }
}
