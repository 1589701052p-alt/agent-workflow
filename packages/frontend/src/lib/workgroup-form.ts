// RFC-164 PR-1 — pure helpers for the /workgroups form. Mirrors lib/mcp-form:
// the parse/validate/assemble logic lives outside the React tree so the
// validation matrix (leader gating, displayName token rules, member typing)
// is unit-testable without rendering the page.
//
// Error values are raw i18n keys (`workgroups.errors.*`) — the widgets
// translate at render time (same contract as PluginFields).

import type {
  CreateWorkgroup,
  UpdateWorkgroup,
  UserPublic,
  Workgroup,
  WorkgroupMemberInput,
  WorkgroupMemberType,
  WorkgroupMode,
} from '@agent-workflow/shared'
import {
  CreateWorkgroupSchema,
  UpdateWorkgroupSchema,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  WORKGROUP_NAME_RE,
} from '@agent-workflow/shared'

/** Characters the member displayName must not contain (mirrors the shared
 *  WorkgroupMemberDisplayNameSchema refine: @ breaks mentions, commas break
 *  roster lists, whitespace breaks both). */
const DISPLAY_NAME_FORBIDDEN_RE = /[@,\s]/

export interface WorkgroupMemberRowState {
  /** Local-only row identity — React keys and the leader radio anchor to it,
   *  so renaming a member never silently moves the leader flag. */
  key: string
  memberType: WorkgroupMemberType
  /** memberType='agent' — may reference a not-yet-existing agent (dangling
   *  references are legal; launch-time validation owns existence). */
  agentName: string
  /** memberType='human' — users.id of the picked platform user. */
  userId: string
  displayName: string
  roleDesc: string
}

export interface WorkgroupFormState {
  name: string
  description: string
  instructions: string
  mode: WorkgroupMode
  /** Row `key` of the designated leader (leader_worker mode). */
  leaderKey: string | null
  /** Stored switch values. free_collab renders them as forced-on but never
   *  mutates them, so flipping back to leader_worker restores the choices
   *  (mirrors shared resolveWorkgroupSwitches: fc reads all-on regardless
   *  of storage). */
  switches: { shareOutputs: boolean; directMessages: boolean; blackboard: boolean }
  /** undefined = field cleared → omit from payload (backend defaults to 20). */
  maxRounds: number | undefined
  completionGate: boolean
  members: WorkgroupMemberRowState[]
}

let rowSeq = 0
/** Monotonic local row key — unique within the session, never sent on the wire. */
export function nextMemberRowKey(): string {
  rowSeq += 1
  return `row-${rowSeq}`
}

export function emptyAgentRow(): WorkgroupMemberRowState {
  return {
    key: nextMemberRowKey(),
    memberType: 'agent',
    agentName: '',
    userId: '',
    displayName: '',
    roleDesc: '',
  }
}

export function emptyHumanRow(): WorkgroupMemberRowState {
  return { ...emptyAgentRow(), memberType: 'human' }
}

/** Fresh create-page draft: one empty agent row (lw mode needs an agent
 *  leader anyway, so this is the least-click starting point). */
export function newWorkgroupForm(): WorkgroupFormState {
  return {
    name: '',
    description: '',
    instructions: '',
    mode: 'leader_worker',
    leaderKey: null,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    members: [emptyAgentRow()],
  }
}

/** Inverse of the payload builders — seed the edit page from a stored row. */
export function workgroupToForm(w: Workgroup): WorkgroupFormState {
  const members = [...w.members]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map<WorkgroupMemberRowState>((m) => ({
      // Server ids are unique — reuse them as local row keys.
      key: m.id,
      memberType: m.memberType,
      agentName: m.agentName ?? '',
      userId: m.userId ?? '',
      displayName: m.displayName,
      roleDesc: m.roleDesc,
    }))
  return {
    name: w.name,
    description: w.description,
    instructions: w.instructions,
    mode: w.mode,
    leaderKey: w.leaderMemberId,
    switches: { ...w.switches },
    maxRounds: w.maxRounds,
    completionGate: w.completionGate,
    members,
  }
}

/** Default member alias when a human row picks a platform user: the user's
 *  display name with mention-breaking characters stripped, falling back to
 *  the username (whose charset is always a legal alias token). */
export function deriveMemberAlias(user: Pick<UserPublic, 'displayName' | 'username'>): string {
  const cleaned = user.displayName.replace(/[@,\s]+/g, '').slice(0, 64)
  return cleaned.length > 0 ? cleaned : user.username
}

/** Leader member's displayName for list rendering; null for free_collab /
 *  unset (callers render an em dash). */
export function workgroupLeaderDisplayName(w: Workgroup): string | null {
  if (w.mode !== 'leader_worker' || w.leaderMemberId === null) return null
  return w.members.find((m) => m.id === w.leaderMemberId)?.displayName ?? null
}

export type BuiltWorkgroup<P> =
  | { ok: true; payload: P }
  | { ok: false; errors: Record<string, string> }

/**
 * Shared validation for both intents. Keys:
 *   name / members / leader / maxRounds — form-level fields;
 *   member-{i}-agentName / member-{i}-userId / member-{i}-displayName — row-level.
 */
function collectErrors(
  form: WorkgroupFormState,
  intent: 'create' | 'update',
): Record<string, string> {
  const errors: Record<string, string> = {}

  if (intent === 'create') {
    if (form.name.length === 0) errors.name = 'workgroups.errors.nameRequired'
    else if (form.name.length > 128 || !WORKGROUP_NAME_RE.test(form.name)) {
      errors.name = 'workgroups.errors.nameInvalid'
    }
  }

  if (form.members.length === 0) errors.members = 'workgroups.errors.membersRequired'

  const seen = new Map<string, number>()
  form.members.forEach((m, i) => {
    if (m.memberType === 'agent') {
      if (m.agentName.trim().length === 0) {
        errors[`member-${i}-agentName`] = 'workgroups.errors.agentNameRequired'
      }
    } else if (m.userId.length === 0) {
      errors[`member-${i}-userId`] = 'workgroups.errors.userRequired'
    }
    const dn = m.displayName.trim()
    if (dn.length === 0) {
      errors[`member-${i}-displayName`] = 'workgroups.errors.displayNameRequired'
    } else if (DISPLAY_NAME_FORBIDDEN_RE.test(dn)) {
      errors[`member-${i}-displayName`] = 'workgroups.errors.displayNameInvalid'
    } else if (dn.length > 64) {
      errors[`member-${i}-displayName`] = 'workgroups.errors.displayNameTooLong'
    } else if (seen.has(dn)) {
      errors[`member-${i}-displayName`] = 'workgroups.errors.displayNameDuplicate'
      // Mark the first occurrence too — the user needs to see both rows.
      const first = seen.get(dn)!
      errors[`member-${first}-displayName`] ??= 'workgroups.errors.displayNameDuplicate'
    } else {
      seen.set(dn, i)
    }
  })

  if (form.mode === 'leader_worker') {
    const leader =
      form.leaderKey === null ? undefined : form.members.find((m) => m.key === form.leaderKey)
    if (leader === undefined) errors.leader = 'workgroups.errors.leaderRequired'
    else if (leader.memberType !== 'agent') errors.leader = 'workgroups.errors.leaderMustBeAgent'
  }

  if (form.maxRounds !== undefined) {
    if (
      !Number.isInteger(form.maxRounds) ||
      form.maxRounds < 1 ||
      form.maxRounds > WORKGROUP_MAX_ROUNDS_LIMIT
    ) {
      errors.maxRounds = 'workgroups.errors.maxRoundsInvalid'
    }
  }

  return errors
}

function assembleConfig(form: WorkgroupFormState): UpdateWorkgroup {
  const members = form.members.map<WorkgroupMemberInput>((m) =>
    m.memberType === 'agent'
      ? {
          memberType: 'agent',
          agentName: m.agentName.trim(),
          displayName: m.displayName.trim(),
          roleDesc: m.roleDesc,
        }
      : {
          memberType: 'human',
          userId: m.userId,
          displayName: m.displayName.trim(),
          roleDesc: m.roleDesc,
        },
  )
  const leaderRow =
    form.mode === 'leader_worker' && form.leaderKey !== null
      ? form.members.find((m) => m.key === form.leaderKey)
      : undefined
  return {
    description: form.description,
    instructions: form.instructions,
    mode: form.mode,
    ...(leaderRow !== undefined ? { leaderDisplayName: leaderRow.displayName.trim() } : {}),
    switches: { ...form.switches },
    ...(form.maxRounds !== undefined ? { maxRounds: form.maxRounds } : { maxRounds: 20 }),
    completionGate: form.completionGate,
    members,
  }
}

/** Map schema-fallback issues to the same error record shape. Pre-validation
 *  covers every UI-reachable case; this net only catches wire-shape drift. */
function schemaIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of issues) {
    const path = issue.path.join('.')
    out[path === '' ? '_' : path] = issue.message
  }
  return out
}

export function buildCreateWorkgroupPayload(
  form: WorkgroupFormState,
): BuiltWorkgroup<CreateWorkgroup> {
  const errors = collectErrors(form, 'create')
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const parsed = CreateWorkgroupSchema.safeParse({ name: form.name, ...assembleConfig(form) })
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error.issues) }
  return { ok: true, payload: parsed.data }
}

export function buildUpdateWorkgroupPayload(
  form: WorkgroupFormState,
): BuiltWorkgroup<UpdateWorkgroup> {
  const errors = collectErrors(form, 'update')
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const parsed = UpdateWorkgroupSchema.safeParse(assembleConfig(form))
  if (!parsed.success) return { ok: false, errors: schemaIssues(parsed.error.issues) }
  return { ok: true, payload: parsed.data }
}
