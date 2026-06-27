// RFC-112 PR-A — runtime registry: named runtime instances {name, protocol,
// binaryPath} backed by the `runtimes` table. The two built-ins (opencode,
// claude-code) are framework-seeded (builtin=1, read-only). agents.runtime /
// config.defaultRuntime reference a row by name; this module resolves a name to
// a (protocol, binary) for dispatch and owns CRUD + the read-only / in-use /
// name guards. Admin-managed (the route layer enforces requireAdmin); there is
// no per-user ACL — a runtime is machine-level config including a local binary
// path (RFC-112 D3).

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, runtimes } from '@/db/schema'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import type { RuntimeKind } from '@/services/runtime'
import { createLogger } from '@/util/log'

const log = createLogger('runtimeRegistry')

export const RUNTIME_PROTOCOLS = ['opencode', 'claude-code'] as const
export type RuntimeProtocol = (typeof RUNTIME_PROTOCOLS)[number]

/** The two framework built-ins — reserved names + seeded read-only rows. */
export const BUILTIN_RUNTIMES: ReadonlyArray<{ name: string; protocol: RuntimeProtocol }> = [
  { name: 'opencode', protocol: 'opencode' },
  { name: 'claude-code', protocol: 'claude-code' },
]
const BUILTIN_NAMES = new Set(BUILTIN_RUNTIMES.map((b) => b.name))

/** RFC-112 Codex P3: runtime names are lowercase, URL-safe (used in /:name routes). */
export const RUNTIME_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

/**
 * RFC-113: the execution params a runtime spawns with (agents only SELECT a
 * runtime). variant/temperature/steps/maxSteps are opencode-only. NULL model =
 * "omit model" (a distinct profile from an explicit model).
 */
export interface RuntimeProfile {
  model: string | null
  variant: string | null
  temperature: number | null
  steps: number | null
  maxSteps: number | null
}

export interface RuntimeRow extends RuntimeProfile {
  id: string
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  builtin: boolean
  lastProbeJson: string | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

export interface ResolvedRuntime extends RuntimeProfile {
  name: string
  protocol: RuntimeKind
  binaryPath: string | null
}

const NULL_PROFILE: RuntimeProfile = {
  model: null,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
}

export interface RuntimeView extends RuntimeProfile {
  name: string
  protocol: RuntimeProtocol
  binaryPath: string | null
  builtin: boolean
  /** RFC-113: this row is the global default (name === config.defaultRuntime). */
  isDefault: boolean
  lastProbe: unknown
  createdAt: number
  updatedAt: number
}

/** Extract just the execution params from a row. */
export function runtimeProfileOf(row: RuntimeProfile): RuntimeProfile {
  return {
    model: row.model,
    variant: row.variant,
    temperature: row.temperature,
    steps: row.steps,
    maxSteps: row.maxSteps,
  }
}

/**
 * Public view of a row for the HTTP layer — parses the cached probe JSON back to
 * an object. Lives here (not in the route) so the route file stays free of the
 * `as` cast the RFC-054 W1-7 guard bans; this is our own serialized data, not
 * unvalidated user input. `defaultRuntimeName` (config.defaultRuntime) drives the
 * in-table default marker (RFC-113 D3/D7).
 */
export function runtimeRowToView(
  row: RuntimeRow,
  defaultRuntimeName: string | null | undefined,
): RuntimeView {
  let lastProbe: unknown = null
  if (row.lastProbeJson !== null) {
    try {
      lastProbe = JSON.parse(row.lastProbeJson)
    } catch {
      lastProbe = null
    }
  }
  return {
    name: row.name,
    protocol: row.protocol,
    binaryPath: row.binaryPath,
    builtin: row.builtin,
    isDefault: row.name === (defaultRuntimeName ?? 'opencode'),
    ...runtimeProfileOf(row),
    lastProbe,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// --- reads -----------------------------------------------------------------

export async function listRuntimes(db: DbClient): Promise<RuntimeRow[]> {
  return (await db.select().from(runtimes)) as RuntimeRow[]
}

export async function getRuntime(db: DbClient, name: string): Promise<RuntimeRow | null> {
  const row = (await db.select().from(runtimes).where(eq(runtimes.name, name)).limit(1))[0]
  return (row as RuntimeRow | undefined) ?? null
}

// --- resolution (name → protocol + binary) ---------------------------------

/**
 * Resolve a runtime NAME to its (protocol, binaryPath). Unknown / empty name
 * fail-safe to the built-in opencode (+ warn) so a dangling agent.runtime can't
 * brick a dispatch. db-aware (custom names aren't derivable from the string).
 */
export async function resolveRuntimeByName(
  db: DbClient,
  name: string | null | undefined,
): Promise<ResolvedRuntime> {
  const n = typeof name === 'string' && name.length > 0 ? name : null
  if (n !== null) {
    const row = await getRuntime(db, n)
    if (row !== null)
      return {
        name: row.name,
        protocol: row.protocol,
        binaryPath: row.binaryPath,
        ...runtimeProfileOf(row),
      }
    // RFC-112: the two built-in NAMES resolve to their protocol (default binary)
    // even when the registry row isn't seeded — so RFC-111 'opencode' /
    // 'claude-code' values keep working in any context (tests, a dispatch that
    // races startup seeding). Only CUSTOM names require a registered row. RFC-113:
    // no row → no profile params (NULL = the binary's own default).
    if (n === 'opencode' || n === 'claude-code') {
      return { name: n, protocol: n, binaryPath: null, ...NULL_PROFILE }
    }
    log.warn('runtime-name-unknown-fallback-opencode', { name: n })
  }
  return { name: 'opencode', protocol: 'opencode', binaryPath: null, ...NULL_PROFILE }
}

/** agent.runtime ?? config.defaultRuntime ?? 'opencode', resolved to a row. */
export async function resolveAgentRuntime(
  db: DbClient,
  agentRuntime: string | null | undefined,
  defaultRuntime: string | null | undefined,
): Promise<ResolvedRuntime> {
  const pick = (v: string | null | undefined): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  return resolveRuntimeByName(db, pick(agentRuntime) ?? pick(defaultRuntime) ?? 'opencode')
}

/**
 * The argv head for a resolved runtime: the custom binary if set, else the
 * protocol's default (RFC-111 behavior — opencode: config.opencodePath/PATH,
 * claude: config.claudeCodePath/PATH).
 */
export function runtimeHead(
  resolved: ResolvedRuntime,
  config: { opencodePath?: string | null; claudeCodePath?: string | null },
): string[] {
  if (resolved.binaryPath !== null && resolved.binaryPath.length > 0) return [resolved.binaryPath]
  if (resolved.protocol === 'opencode')
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
}

// --- guards ----------------------------------------------------------------

export function assertNotBuiltinRuntime(row: Pick<RuntimeRow, 'builtin' | 'name'>): void {
  if (row.builtin) {
    throw new ForbiddenError(
      'runtime-builtin-readonly',
      `runtime '${row.name}' is a built-in framework runtime and is read-only`,
    )
  }
}

function validateName(name: string): void {
  if (!RUNTIME_NAME_RE.test(name))
    throw new ValidationError(
      'runtime-name-invalid',
      'runtime name must be lowercase URL-safe (^[a-z0-9][a-z0-9-]{0,30}$)',
    )
  if (BUILTIN_NAMES.has(name))
    throw new ConflictError(
      'runtime-name-reserved',
      `'${name}' is a reserved built-in runtime name`,
    )
}

function validateProtocol(protocol: string): asserts protocol is RuntimeProtocol {
  if (!RUNTIME_PROTOCOLS.includes(protocol as RuntimeProtocol))
    throw new ValidationError(
      'runtime-protocol-invalid',
      `protocol must be one of ${RUNTIME_PROTOCOLS.join(' | ')}`,
    )
}

/** RFC-112 Codex P3: a single executable path, not a shell string with args. */
function validateBinaryPath(binaryPath: string | null | undefined): string | null {
  if (binaryPath === null || binaryPath === undefined) return null
  const p = binaryPath.trim()
  if (p.length === 0) return null
  if (/[\n\r]/.test(p))
    throw new ValidationError('runtime-binary-invalid', 'binaryPath must be a single path')
  return p
}

/** Rows that reference a runtime name (block delete to avoid dangling refs). */
export async function findRuntimeReferences(
  db: DbClient,
  name: string,
  defaultRuntimeName: string | null | undefined,
): Promise<{ agentNames: string[]; isDefault: boolean }> {
  const refAgents = (await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.runtime, name))) as { name: string }[]
  return { agentNames: refAgents.map((a) => a.name), isDefault: defaultRuntimeName === name }
}

// --- CRUD ------------------------------------------------------------------

/** RFC-113: optional per-field profile params on create/update. */
export interface RuntimeProfileInput {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  maxSteps?: number | null
}

/** Validate + normalize profile params into the row columns (only present keys). */
function profilePatch(input: RuntimeProfileInput): Partial<RuntimeProfile> {
  const out: Partial<RuntimeProfile> = {}
  const str = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  if (input.model !== undefined) out.model = str(input.model)
  if (input.variant !== undefined) out.variant = str(input.variant)
  if (input.temperature !== undefined) {
    if (input.temperature !== null && (input.temperature < 0 || input.temperature > 2))
      throw new ValidationError('runtime-temperature-invalid', 'temperature must be 0–2')
    out.temperature = input.temperature
  }
  for (const k of ['steps', 'maxSteps'] as const) {
    const v = input[k]
    if (v !== undefined) {
      if (v !== null && (!Number.isInteger(v) || v < 1))
        throw new ValidationError(`runtime-${k}-invalid`, `${k} must be a positive integer`)
      out[k] = v
    }
  }
  return out
}

export interface CreateRuntimeInput extends RuntimeProfileInput {
  name: string
  protocol: string
  binaryPath?: string | null
  lastProbeJson?: string | null
  createdBy?: string | null
}

export async function createRuntime(db: DbClient, input: CreateRuntimeInput): Promise<RuntimeRow> {
  validateName(input.name)
  validateProtocol(input.protocol)
  const binaryPath = validateBinaryPath(input.binaryPath)
  const existing = await getRuntime(db, input.name)
  if (existing !== null)
    throw new ConflictError('runtime-exists', `runtime '${input.name}' already exists`)
  await db.insert(runtimes).values({
    id: ulid(),
    name: input.name,
    protocol: input.protocol as RuntimeProtocol,
    binaryPath,
    builtin: false,
    lastProbeJson: input.lastProbeJson ?? null,
    createdBy: input.createdBy ?? null,
    ...profilePatch(input),
  })
  const row = await getRuntime(db, input.name)
  if (row === null) throw new Error('runtime insert vanished')
  return row
}

export interface UpdateRuntimeInput extends RuntimeProfileInput {
  binaryPath?: string | null
  lastProbeJson?: string | null
}

/**
 * Update a runtime's binary_path / profile params / cached probe. `name` and
 * `protocol` are IMMUTABLE (the reference key + the driver/session-format pin).
 * RFC-113 D8: BUILT-INS are editable here (binary/model/params) — only their
 * identity (name/protocol) + deletion stay locked (deleteRuntime guards those).
 */
export async function updateRuntime(
  db: DbClient,
  name: string,
  input: UpdateRuntimeInput,
): Promise<RuntimeRow> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  const patch: Record<string, unknown> = { updatedAt: Date.now(), ...profilePatch(input) }
  if (input.binaryPath !== undefined) patch.binaryPath = validateBinaryPath(input.binaryPath)
  if (input.lastProbeJson !== undefined) patch.lastProbeJson = input.lastProbeJson
  await db.update(runtimes).set(patch).where(eq(runtimes.name, name))
  const updated = await getRuntime(db, name)
  if (updated === null) throw new Error('runtime update vanished')
  return updated
}

/**
 * Cache a deep-smoke result onto a row's `last_probe_json` for display. Allowed
 * on BUILT-INS (unlike updateRuntime) — a probe result is advisory display, not
 * an identity edit, so it doesn't trip the read-only lock. No-op if the row is gone.
 */
export async function cacheRuntimeProbe(
  db: DbClient,
  name: string,
  lastProbeJson: string,
): Promise<void> {
  await db
    .update(runtimes)
    .set({ lastProbeJson, updatedAt: Date.now() })
    .where(eq(runtimes.name, name))
}

export async function deleteRuntime(
  db: DbClient,
  name: string,
  defaultRuntimeName: string | null | undefined,
): Promise<void> {
  const row = await getRuntime(db, name)
  if (row === null) throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
  assertNotBuiltinRuntime(row)
  const refs = await findRuntimeReferences(db, name, defaultRuntimeName)
  if (refs.isDefault || refs.agentNames.length > 0) {
    const by = [
      refs.isDefault ? 'config.defaultRuntime' : null,
      ...refs.agentNames.map((a) => `agent '${a}'`),
    ].filter((s): s is string => s !== null)
    throw new ConflictError(
      'runtime-in-use',
      `runtime '${name}' is in use by ${by.join(', ')}; re-point them first`,
    )
  }
  await db.delete(runtimes).where(eq(runtimes.name, name))
}

// --- seed ------------------------------------------------------------------

/**
 * Ensure the two built-in rows exist with the canonical IDENTITY (protocol +
 * builtin=1). RFC-112 Codex P2 reset them fully; RFC-113 D8 narrows the reset to
 * IDENTITY ONLY — `binary_path` + the profile params (model/variant/...) are now
 * admin-editable + carry migrated config values (§3), so they must be PRESERVED
 * across restarts. Only a wrong protocol / non-builtin flag (corruption, or a
 * user who acquired the reserved name) is corrected. A row not present is created
 * with NULL binary/params (the config→builtin migration fills them next).
 */
export async function seedBuiltinRuntimes(db: DbClient): Promise<void> {
  for (const b of BUILTIN_RUNTIMES) {
    const row = await getRuntime(db, b.name)
    if (row === null) {
      await db
        .insert(runtimes)
        .values({ id: ulid(), name: b.name, protocol: b.protocol, binaryPath: null, builtin: true })
    } else if (row.protocol !== b.protocol || !row.builtin) {
      // identity drift only — preserve binary_path + profile params.
      log.warn('runtime-builtin-identity-reset', {
        name: b.name,
        was: { protocol: row.protocol, builtin: row.builtin },
      })
      await db
        .update(runtimes)
        .set({ protocol: b.protocol, builtin: true, updatedAt: Date.now() })
        .where(eq(runtimes.name, b.name))
    }
  }
}

// --- RFC-113 one-time startup migrations ------------------------------------

/** RFC-113 §3.1: backfill config defaults into the built-in rows — NULL cols
 *  ONLY (`??=`), so it's idempotent + never clobbers an admin-edited built-in. */
export async function migrateConfigIntoBuiltins(
  db: DbClient,
  config: {
    opencodePath?: string | null
    claudeCodePath?: string | null
    defaultModel?: string | null
    defaultClaudeModel?: string | null
    defaultVariant?: string | null
    defaultTemperature?: number | null
    defaultSteps?: number | null
    defaultMaxSteps?: number | null
  },
): Promise<void> {
  const backfill = async (
    name: string,
    fields: Partial<RuntimeProfile & { binaryPath: string }>,
  ) => {
    const row = await getRuntime(db, name)
    if (row === null) return
    const patch: Record<string, unknown> = {}
    if (row.binaryPath === null && fields.binaryPath != null) patch.binaryPath = fields.binaryPath
    if (row.model === null && fields.model != null) patch.model = fields.model
    if (row.variant === null && fields.variant != null) patch.variant = fields.variant
    if (row.temperature === null && fields.temperature != null)
      patch.temperature = fields.temperature
    if (row.steps === null && fields.steps != null) patch.steps = fields.steps
    if (row.maxSteps === null && fields.maxSteps != null) patch.maxSteps = fields.maxSteps
    if (Object.keys(patch).length > 0)
      await db
        .update(runtimes)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(runtimes.name, name))
  }
  await backfill('opencode', {
    binaryPath: config.opencodePath ?? undefined,
    model: config.defaultModel ?? undefined,
    variant: config.defaultVariant ?? undefined,
    temperature: config.defaultTemperature ?? undefined,
    steps: config.defaultSteps ?? undefined,
    maxSteps: config.defaultMaxSteps ?? undefined,
  } as Partial<RuntimeProfile & { binaryPath: string }>)
  await backfill('claude-code', {
    binaryPath: config.claudeCodePath ?? undefined,
    model: config.defaultClaudeModel ?? undefined,
  } as Partial<RuntimeProfile & { binaryPath: string }>)
}

/** Canonical profile key for dedup (RFC-113 §3.2 Codex P3-1: null-norm + fixed
 *  numeric serialization so REAL float equality / undefined don't split groups). */
function profileKey(protocol: string, binary: string | null, p: RuntimeProfile): string {
  const norm = (v: unknown): string => (v == null ? '\x00' : String(v))
  const temp = p.temperature == null ? '\x00' : p.temperature.toFixed(4)
  return [
    protocol,
    norm(binary),
    norm(p.model),
    norm(p.variant),
    temp,
    norm(p.steps),
    norm(p.maxSteps),
  ].join('\x1f')
}

/**
 * RFC-113 §3.2 (D6 + Codex P1-1/P1-4/P2-1/P3-1): re-home each USER agent's
 * model/params onto a runtime profile. Excludes built-in / internal agents.
 * Dedups by canonical profile key; PREFERS the agent's current runtime when it
 * matches; preserves NULL model as a distinct profile; clears the deprecated
 * agent columns so the runtime is the single source. Idempotent.
 */
export async function migrateAgentParamsToRuntimes(
  db: DbClient,
  config: { defaultRuntime?: string | null },
): Promise<void> {
  const agentRows = (await db
    .select({
      id: agents.id,
      runtime: agents.runtime,
      model: agents.model,
      variant: agents.variant,
      temperature: agents.temperature,
      steps: agents.steps,
      maxSteps: agents.maxSteps,
    })
    .from(agents)
    .where(eq(agents.builtin, false))) as Array<{
    id: string
    runtime: string | null
    model: string | null
    variant: string | null
    temperature: number | null
    steps: number | null
    maxSteps: number | null
  }>

  const allRuntimes = await listRuntimes(db)
  const rowByName = new Map(allRuntimes.map((r) => [r.name, r]))
  const nameByKey = new Map<string, string>()
  const usedNames = new Set<string>(allRuntimes.map((r) => r.name))
  for (const r of allRuntimes)
    nameByKey.set(profileKey(r.protocol, r.binaryPath, runtimeProfileOf(r)), r.name)

  const seq: Record<string, number> = {}
  const nextName = (protocol: string): string => {
    for (;;) {
      seq[protocol] = (seq[protocol] ?? 0) + 1
      const cand = `${protocol}-${seq[protocol]}`
      if (!usedNames.has(cand)) {
        usedNames.add(cand)
        return cand
      }
    }
  }

  // group agents by canonical profile key.
  const groups = new Map<
    string,
    {
      protocol: RuntimeProtocol
      binary: string | null
      profile: RuntimeProfile
      ids: string[]
      current: Set<string>
    }
  >()
  for (const a of agentRows) {
    // RFC-113: an agent with NO explicit params has nothing to re-home — in the
    // new model it simply ADOPTS its runtime's profile. Skipping it (a) preserves
    // that, and (b) makes the migration idempotent: after a re-home the agent's
    // params are cleared (all-NULL), so a re-run leaves it on its new runtime
    // instead of re-deriving a (now-NULL) profile that no longer matches.
    if (
      a.model == null &&
      a.variant == null &&
      a.temperature == null &&
      a.steps == null &&
      a.maxSteps == null
    )
      continue
    const resolved = await resolveRuntimeByName(db, a.runtime ?? config.defaultRuntime)
    const profile: RuntimeProfile = {
      model: a.model,
      variant: a.variant,
      temperature: a.temperature,
      steps: a.steps,
      maxSteps: a.maxSteps,
    }
    const key = profileKey(resolved.protocol, resolved.binaryPath, profile)
    let g = groups.get(key)
    if (g === undefined) {
      g = {
        protocol: resolved.protocol,
        binary: resolved.binaryPath,
        profile,
        ids: [],
        current: new Set(),
      }
      groups.set(key, g)
    }
    g.ids.push(a.id)
    if (a.runtime != null) g.current.add(a.runtime)
  }

  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key)
    if (g === undefined) continue
    // 1. prefer a CURRENT runtime of this group whose profile already matches.
    let target: string | undefined
    for (const rt of g.current) {
      const row = rowByName.get(rt)
      if (row && profileKey(row.protocol, row.binaryPath, runtimeProfileOf(row)) === key) {
        target = rt
        break
      }
    }
    // 2. else any existing runtime with this profile.
    if (target === undefined) target = nameByKey.get(key)
    // 3. else create a new runtime capturing the profile.
    if (target === undefined) {
      target = nextName(g.protocol)
      await db.insert(runtimes).values({
        id: ulid(),
        name: target,
        protocol: g.protocol,
        binaryPath: g.binary,
        builtin: false,
        ...g.profile,
      })
      nameByKey.set(key, target)
    }
    // 4. repoint agents + clear deprecated params (single source = runtime).
    for (const id of g.ids) {
      await db
        .update(agents)
        .set({
          runtime: target,
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
        })
        .where(eq(agents.id, id))
    }
  }
}
