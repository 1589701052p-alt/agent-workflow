# RFC-036 — 技术设计

> 配套 [proposal.md](./proposal.md)。proposal 定产品意图，本文件钉技术契约。

## 1. 模块拓扑

```
packages/backend/
  db/
    migrations/
      0018_rfc036_users.sql            # users / user_sessions / user_pats / user_identities
      0019_rfc036_oidc_providers.sql   # oidc_providers
      0020_rfc036_task_collab.sql      # task_collaborators / node_assignments / tasks.owner_user_id
  src/
    auth/
      session.ts       # 三轨 middleware：daemon token / session token / PAT
      passwords.ts     # argon2id hash + verify
      sessionStore.ts  # CRUD user_sessions + sha256 token hash
      patStore.ts      # CRUD user_pats + sha256 token hash
      secretBox.ts     # AES-256-GCM 包/解 client_secret，key 来自 ~/.agent-workflow/secret.key
      actor.ts         # Actor 类型 + actorOf(c) + 转 system 行为
    services/
      users.ts             # CRUD + search + status / role 规则
      userIdentities.ts    # link/unlink + provider/subject 反查
      pats.ts              # 生成 / list / revoke / expiry sweep
      oidcProviders.ts     # CRUD + discovery test
      oidc/
        discovery.ts       # /.well-known/openid-configuration fetch + 1h LRU 缓存 + JWKS 缓存
        flow.ts            # PKCE + nonce + state map (in-memory, 5min TTL)
        tokens.ts          # code → tokens → id_token verify（jose 库）
        provisioning.ts    # 纯函数 decideProvisioning(provider, idTokenClaims, existingIdentity) → action
      taskCollab.ts        # 协作者 / 节点指派 CRUD + 校验
      permissions.ts       # hasPermission + requirePermission middleware factory
    routes/
      auth.ts        # login / logout / change-password / me / sessions / pats / identities
      oidc-auth.ts   # /api/auth/oidc/* （登录 flow）
      users.ts       # admin CRUD + search
      oidc.ts        # admin /api/oidc/providers/*
      tasks.ts       # 现有路由扩展：launch 加 assignments，list 加 scope
      reviews.ts     # 现有：决策端点叠权限校验
      clarify.ts     # 现有：答复端点叠权限校验
    cli/
      user.ts        # agent-workflow user create / reset-password
packages/shared/src/
  schemas/
    user.ts                  # User / Session / PAT / Identity zod
    permission.ts            # PERMISSIONS literal + ROLE_PERMISSIONS map
    oidcProvider.ts          # OidcProvider zod
    taskCollab.ts            # TaskCollaborator / NodeAssignment zod
    task.ts                  # 既有：加 assignments / scope / collaboratorUserIds
packages/frontend/src/
  components/
    UserPicker.tsx           # 共享 single/multi picker
    user/UserMenu.tsx        # sidebar footer 头像 + dropdown
    user/ChangePasswordDialog.tsx
    user/IdentitiesPanel.tsx
    user/PatPanel.tsx
    user/SessionsPanel.tsx
    user/LoginForm.tsx
    user/OidcLoginButtons.tsx
    settings/AuthenticationTab.tsx
    settings/OidcProviderDialog.tsx
    settings/PublicBaseUrlField.tsx
    tasks/AssignmentsField.tsx
    tasks/CollaboratorsField.tsx
    common/NoPermissionEmpty.tsx
  routes/
    auth.tsx                 # 既有：扩展三入口
    settings.tsx             # 既有：加 Authentication tab
    account.tsx              # 新：用户自服务（/account 路由，不在 /settings 之下，避免被 admin gate 误拦）
    users.tsx                # 新：admin 列表
    users.detail.tsx         # 新：admin 行详情
  hooks/
    useActor.ts              # 当前登录 actor
    usePermission.ts         # hasPermission(actor, perm)
    useUserSearch.ts         # React Query 包 /api/users/search
  stores/
    auth.ts                  # 既有：扩展 setSessionToken / setPat / setDaemonToken
  lib/
    redact.ts                # redactSecret 共享（OIDC client_secret 等）
```

## 2. 数据库 schema

下方用 SQLite DDL 描述；Drizzle 表定义在 `packages/backend/src/db/schema.ts` 同步。

### 2.1 migration 0018 — users / sessions / pats / identities

```sql
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT UNIQUE,            -- nullable; UNIQUE constraint allows multiple NULLs in SQLite
  display_name    TEXT NOT NULL,
  password_hash   TEXT,                   -- NULL = oidc-only user
  role            TEXT NOT NULL DEFAULT 'user',  -- check: 'admin' | 'user'
  status          TEXT NOT NULL DEFAULT 'active', -- check: 'active' | 'disabled' | 'invited'
  force_password_change INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  CHECK (role IN ('admin', 'user')),
  CHECK (status IN ('active', 'disabled', 'invited'))
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email    ON users(email);
CREATE INDEX idx_users_status   ON users(status);

CREATE TABLE user_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,      -- sha256 hex of raw 'aws_s_<32-hex>' (= 64+6 chars input)
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at);

CREATE TABLE user_pats (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,      -- sha256 hex of raw 'aws_pat_<32-hex>'
  scopes_json   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,                   -- NULL = never expires
  revoked_at    INTEGER
);

CREATE INDEX idx_user_pats_user ON user_pats(user_id);

CREATE TABLE user_identities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL,            -- FK validated at app layer until oidc_providers exists
  subject        TEXT NOT NULL,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  linked_at      INTEGER NOT NULL,
  UNIQUE (provider_id, subject)
);

CREATE INDEX idx_user_identities_user     ON user_identities(user_id);
CREATE INDEX idx_user_identities_provider ON user_identities(provider_id);

-- Seed __system__ user (id = literal '__system__' for stable refs, not ULID).
INSERT INTO users (id, username, display_name, password_hash, role, status, created_at, updated_at)
VALUES ('__system__', '__system__', 'System', NULL, 'admin', 'active',
        CAST(strftime('%s','now') AS INTEGER) * 1000,
        CAST(strftime('%s','now') AS INTEGER) * 1000);
```

> **id 设计**：除 `__system__` 行外其它 users 行用 ULID（与既有 agents / mcps 一致）。`__system__` 字面量便于审计字段直读 + 测试 stable。

### 2.2 migration 0019 — oidc_providers

```sql
CREATE TABLE oidc_providers (
  id                          TEXT PRIMARY KEY,
  slug                        TEXT NOT NULL UNIQUE,   -- URL-safe identifier
  display_name                TEXT NOT NULL,
  issuer_url                  TEXT NOT NULL,
  client_id                   TEXT NOT NULL,
  client_secret_enc           TEXT NOT NULL,           -- AES-256-GCM(client_secret, secret.key); base64(iv|ct|tag)
  scopes                      TEXT NOT NULL DEFAULT 'openid profile email',
  provisioning                TEXT NOT NULL DEFAULT 'invite',
  allowed_email_domains_json  TEXT NOT NULL DEFAULT '[]',
  icon_url                    TEXT,
  enabled                     INTEGER NOT NULL DEFAULT 1,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  schema_version              INTEGER NOT NULL DEFAULT 1,
  CHECK (provisioning IN ('auto', 'allowlist', 'invite'))
);

CREATE INDEX idx_oidc_providers_enabled ON oidc_providers(enabled);
```

> migration 同时把 `user_identities.provider_id` FK 加上（之前先创建表，因为 0018 时 oidc_providers 还不存在）：

```sql
-- SQLite 不支持 ALTER ADD CONSTRAINT；通过表重建添加 FK。
PRAGMA foreign_keys=OFF;
CREATE TABLE user_identities_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL REFERENCES oidc_providers(id) ON DELETE RESTRICT,
  subject        TEXT NOT NULL,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  linked_at      INTEGER NOT NULL,
  UNIQUE (provider_id, subject)
);
INSERT INTO user_identities_new SELECT * FROM user_identities;
DROP TABLE user_identities;
ALTER TABLE user_identities_new RENAME TO user_identities;
CREATE INDEX idx_user_identities_user     ON user_identities(user_id);
CREATE INDEX idx_user_identities_provider ON user_identities(provider_id);
PRAGMA foreign_keys=ON;
```

### 2.3 migration 0020 — task collaboration

```sql
ALTER TABLE tasks ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_owner ON tasks(owner_user_id);

CREATE TABLE task_collaborators (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role      TEXT NOT NULL,
  added_by  TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (task_id, user_id, role),
  CHECK (role IN ('owner', 'reviewer', 'clarify_target', 'collaborator'))
);

CREATE INDEX idx_task_collab_user ON task_collaborators(user_id);
CREATE INDEX idx_task_collab_task ON task_collaborators(task_id);

CREATE TABLE node_assignments (
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by  TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  INTEGER NOT NULL,
  PRIMARY KEY (task_id, node_id, kind),
  CHECK (kind IN ('reviewer', 'clarify_target'))
);

CREATE INDEX idx_node_assign_user ON node_assignments(user_id);
CREATE INDEX idx_node_assign_task ON node_assignments(task_id);
```

## 3. shared schemas

### 3.1 `packages/shared/src/schemas/permission.ts`

```ts
export const PERMISSIONS = [
  // resource read (admin + user)
  'agents:read', 'skills:read', 'mcps:read', 'plugins:read',
  'workflows:read', 'repos:read', 'runtime:read',
  // resource write (admin only)
  'agents:write', 'skills:write', 'mcps:write', 'plugins:write',
  'workflows:write', 'repos:write',
  // user management (admin only)
  'users:read', 'users:write',
  // user search picker (admin + user) — public-fields-only endpoint
  'users:search',
  // global settings (admin only)
  'settings:read', 'settings:write',
  // OIDC providers config (admin only)
  'oidc:read', 'oidc:configure',
  // backup (admin only)
  'backup:run',
  // tasks
  'tasks:launch',
  'tasks:read:own', 'tasks:read:all',
  'tasks:cancel:own', 'tasks:cancel:all',
  // self-service (admin + user)
  'account:self',
] as const

export type Permission = (typeof PERMISSIONS)[number]
export type Role = 'admin' | 'user'

// 资源 read：admin / user 都有；写权限、users 全字段、settings、oidc、backup 都仅 admin。
const USER_RESOURCE_READS: Permission[] = [
  'agents:read', 'skills:read', 'mcps:read', 'plugins:read',
  'workflows:read', 'repos:read', 'runtime:read',
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],          // 全集
  user: [
    ...USER_RESOURCE_READS,
    'users:search',
    'tasks:launch',
    'tasks:read:own',
    'tasks:cancel:own',
    'account:self',
  ],
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm)
}
```

**显式不在 `user` 集合的 admin-only 点**：`agents:write` / `skills:write` / `mcps:write` / `plugins:write` / `workflows:write` / `repos:write` / `users:read` / `users:write` / `settings:read` / `settings:write` / `oidc:read` / `oidc:configure` / `backup:run` / `tasks:read:all` / `tasks:cancel:all`。Snapshot 测试 `permission.test.ts` 把这个负向集合也锁住，防止后续误加权限到 user 角色。

> `__system__` 在 actor 层映射成 `role='admin'`，自动走 admin 全集。

### 3.2 `user.ts` (excerpt)

```ts
export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  email: z.string().email().max(254).nullable(),
  displayName: z.string().min(1).max(128),
  role: z.enum(['admin', 'user']),
  status: z.enum(['active', 'disabled', 'invited']),
  forcePasswordChange: z.boolean().default(false),
  createdBy: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastLoginAt: z.number().int().nonnegative().nullable(),
})

/** /api/users/search 返回的最小公开字段 */
export const UserPublicSchema = UserSchema.pick({
  id: true, username: true, displayName: true, role: true, status: true,
})

export const CreateUserBodySchema = z.object({
  username: UserSchema.shape.username,
  email: UserSchema.shape.email.optional(),
  displayName: UserSchema.shape.displayName,
  role: UserSchema.shape.role,
  password: z.string().min(8).max(256).optional(), // omit + role='user' → status='invited'
  sendInvite: z.boolean().optional(),
})

export const PatScopeSchema = z.enum([
  'tasks:launch', 'tasks:read:own', 'agents:read', 'workflows:read', // 等
])

export const PatPublicSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  scopes: z.array(PatScopeSchema),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
})
```

### 3.3 `oidcProvider.ts`

```ts
export const ProvisioningSchema = z.enum(['auto', 'allowlist', 'invite'])

export const OidcProviderSchema = z.object({
  id: z.string(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  displayName: z.string().min(1).max(128),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  // client_secret 在 API 层不读写——CreateBody / PatchBody 单独定义
  scopes: z.string().min(1).max(512),
  provisioning: ProvisioningSchema,
  allowedEmailDomains: z.array(z.string().regex(/^@[a-z0-9.-]+$/i)).default([]),
  iconUrl: z.string().url().nullable(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const OidcProviderPublicSchema = OidcProviderSchema.pick({
  slug: true, displayName: true, iconUrl: true,
})

export const CreateOidcProviderBodySchema = OidcProviderSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ clientSecret: z.string().min(1).max(1024) })
```

### 3.4 `taskCollab.ts`

```ts
export const TaskCollaboratorRoleSchema = z.enum([
  'owner', 'reviewer', 'clarify_target', 'collaborator',
])

export const TaskCollaboratorSchema = z.object({
  taskId: z.string(),
  userId: z.string(),
  role: TaskCollaboratorRoleSchema,
  addedBy: z.string(),
  addedAt: z.number(),
})

export const NodeAssignmentKindSchema = z.enum(['reviewer', 'clarify_target'])

export const NodeAssignmentSchema = z.object({
  taskId: z.string(),
  nodeId: z.string(),
  kind: NodeAssignmentKindSchema,
  userId: z.string(),
  assignedBy: z.string(),
  assignedAt: z.number(),
})

// 启动 task 时的 launcher 副表
export const NodeAssignmentInputSchema = z.object({
  nodeId: z.string().min(1),
  kind: NodeAssignmentKindSchema,
  userId: z.string().min(1),
})
```

### 3.5 task.ts 既有 schema 扩展

`CreateTaskBodySchema`（既有）追加：

```ts
.extend({
  assignments: z.array(NodeAssignmentInputSchema).default([]),
  collaboratorUserIds: z.array(z.string().min(1)).default([]),
})
```

`TaskSchema`（既有）追加：

```ts
.extend({
  ownerUserId: z.string().nullable(),  // NULL = legacy / system
})
```

`ListTasksQuerySchema` 加：

```ts
scope: z.enum(['mine', 'shared', 'all']).optional(),
```

## 4. 鉴权 middleware

### 4.1 三轨解析顺序

```ts
// auth/session.ts
export function multiAuth(deps: AuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const raw = extractRaw(c)
    if (!raw) throw new UnauthorizedError()

    let actor: Actor | null = null
    if (raw.startsWith('aws_s_')) {
      actor = await resolveSession(raw, deps)
    } else if (raw.startsWith('aws_pat_')) {
      actor = await resolvePat(raw, deps)
    } else if (raw.length === 64 /* daemon token format */) {
      actor = resolveDaemonToken(raw, deps)
    }
    if (!actor) throw new UnauthorizedError()

    c.set('actor', actor)
    await next()
  }
}

export type Actor = {
  user: UserRow         // includes __system__ row
  source: 'session' | 'pat' | 'daemon'
  permissions: ReadonlySet<Permission>
}
```

> daemon token 比对仍是 `crypto.timingSafeEqual`；session token / PAT 比对是 `sha256(raw) === stored_hash`（SHA-256 + 常量长度，无 timing 风险）。

### 4.2 `requirePermission(perm)` factory

```ts
// services/permissions.ts
export function requirePermission(perm: Permission): MiddlewareHandler {
  return async (c, next) => {
    const actor = actorOf(c)
    if (!actor.permissions.has(perm)) {
      throw new ForbiddenError(perm)
    }
    await next()
  }
}
```

每个路由按用法挂：

```ts
// routes/agents.ts (excerpt)
app.get('/api/agents', requirePermission('agents:read'), listAgents)
app.post('/api/agents', requirePermission('agents:write'), createAgent)
app.put('/api/agents/:id', requirePermission('agents:write'), updateAgent)
app.delete('/api/agents/:id', requirePermission('agents:write'), deleteAgent)
```

GET 路径放 `*:read`（regular user 也通过）；写路径放 `*:write`（admin only）。

### 4.3 任务可见性中间件

```ts
// routes/tasks.ts (excerpt)
app.get('/api/tasks/:id', requirePermission('tasks:read:own'), async (c) => {
  const id = c.req.param('id')
  const actor = actorOf(c)
  const task = await taskRepo.findById(id)
  if (!task || !canViewTask(actor, task)) {
    throw new ForbiddenError('task-not-visible')
  }
  return c.json(materialize(task))
})

// services/taskCollab.ts
export function canViewTask(actor: Actor, task: TaskRow): boolean {
  if (actor.permissions.has('tasks:read:all')) return true       // admin
  if (task.ownerUserId === actor.user.id) return true
  return taskCollabRepo.hasMembership(task.id, actor.user.id)
}
```

GET `/api/tasks` 列表 SQL 直接 join：

```ts
const rows = await db.select().from(tasks)
  .where(and(
    isNull(tasks.deletedAt),
    actor.permissions.has('tasks:read:all') && scope === 'all'
      ? sql`1=1`
      : or(
          eq(tasks.ownerUserId, actor.user.id),
          inArray(tasks.id, db.select({ id: taskCollaborators.taskId })
                              .from(taskCollaborators)
                              .where(eq(taskCollaborators.userId, actor.user.id)))
        ),
  ))
```

`scope=shared` 时另加 `ne(tasks.ownerUserId, actor.user.id)` 过滤掉自己 owner。

## 5. OIDC 流程

### 5.1 库选型

- **jose**（pure JS / Bun 兼容）做 JWT 验证 + JWKS fetch + nonce / iat / aud 校验。
- **不**用 `openid-client`（Node-only 依赖，Bun 兼容性历史不稳）；自己写 discovery + token exchange（HTTP 直调），结构简单（一个 GET、一个 POST）。

### 5.2 PKCE + state

```ts
// auth/oidc/flow.ts
export interface PendingFlow {
  providerId: string
  state: string            // also serves as map key
  codeVerifier: string
  nonce: string
  redirectUri: string
  expiresAt: number        // now + 5min
  // optional: link to existing user (link flow, not login flow)
  linkUserId?: string
  postLoginRedirect?: string
}

const pending = new Map<string, PendingFlow>()  // process-local

export function startFlow(provider, opts): PendingFlow {
  const state = randomBase64Url(32)
  const codeVerifier = randomBase64Url(64)
  const nonce = randomBase64Url(16)
  const f = { providerId: provider.id, state, codeVerifier, nonce, ...opts,
              expiresAt: Date.now() + 5 * 60 * 1000 }
  pending.set(state, f)
  // hourly GC 也清过期
  return f
}

export function consume(state: string): PendingFlow | null {
  const f = pending.get(state)
  if (!f) return null
  pending.delete(state)
  if (f.expiresAt < Date.now()) return null
  return f
}
```

GC：复用 RFC-033 daemon hourly ticker，扫 `pending` map 删过期；进程退出全清。

### 5.3 discovery 缓存

```ts
// auth/oidc/discovery.ts
const cache = new Map<string /*issuerUrl*/, { metadata: OidcMetadata; jwks: JwkSet; fetchedAt: number }>()
const TTL_MS = 60 * 60 * 1000

export async function getProviderMetadata(issuerUrl: string) {
  const hit = cache.get(issuerUrl)
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit
  const meta = await fetchDiscovery(issuerUrl)
  const jwks = await fetchJwks(meta.jwks_uri)
  const entry = { metadata: meta, jwks, fetchedAt: Date.now() }
  cache.set(issuerUrl, entry)
  return entry
}
```

### 5.4 callback handler

```ts
// routes/oidc-auth.ts (pseudocode)
app.get('/api/auth/oidc/:slug/callback', async (c) => {
  const { code, state } = c.req.query()
  const flow = consume(state)
  if (!flow) throw new BadRequestError('invalid-state')
  const provider = await oidcProviders.findById(flow.providerId)
  if (!provider || !provider.enabled) throw new BadRequestError('provider-disabled')

  const { metadata, jwks } = await getProviderMetadata(provider.issuerUrl)
  const tokens = await exchangeCodeForTokens({
    tokenEndpoint: metadata.token_endpoint,
    clientId: provider.clientId,
    clientSecret: secretBox.unseal(provider.clientSecretEnc),
    code, codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri,
  })
  const claims = await verifyIdToken(tokens.id_token, {
    jwks, issuer: metadata.issuer, audience: provider.clientId, nonce: flow.nonce,
  })

  // 4 种分支
  if (flow.linkUserId) {
    await linkIdentity(flow.linkUserId, provider, claims)
    return redirect(flow.postLoginRedirect ?? '/account?linked=' + provider.slug)
  }

  const decision = decideProvisioning(provider, claims, await identitiesByProviderSubject(provider.id, claims.sub))
  // decision: { action: 'login' | 'create' | 'bindInvited' | 'reject', reason?: string, userId?: string }
  switch (decision.action) {
    case 'login': {
      const session = await sessions.create(decision.userId)
      return setSessionCookieAndRedirect(c, session.token)
    }
    case 'create': {
      const user = await users.create({
        username: deriveUsername(claims),
        email: claims.email,
        displayName: claims.name ?? claims.email ?? '(no-name)',
        role: 'user',
        status: 'active',
        passwordHash: null,
      })
      await identities.create(user.id, provider.id, claims.sub, claims.email, !!claims.email_verified)
      const session = await sessions.create(user.id)
      return setSessionCookieAndRedirect(c, session.token)
    }
    case 'bindInvited': {
      await users.activateInvited(decision.userId)
      await identities.create(decision.userId, provider.id, claims.sub, claims.email, !!claims.email_verified)
      const session = await sessions.create(decision.userId)
      return setSessionCookieAndRedirect(c, session.token)
    }
    case 'reject': {
      return c.html(renderFriendlyRejectPage(decision.reason)) // 403
    }
  }
})
```

### 5.5 provisioning 纯函数（可单测）

```ts
// services/oidc/provisioning.ts
export function decideProvisioning(
  provider: OidcProvider,
  claims: IdTokenClaims,
  existingIdentity: UserIdentity | null,
  existingInvitedByEmail: User | null,
): ProvisioningDecision {
  if (existingIdentity) {
    return { action: 'login', userId: existingIdentity.userId }
  }
  if (provider.provisioning === 'auto') {
    return { action: 'create' }
  }
  if (provider.provisioning === 'allowlist') {
    const ok = claims.email && claims.email_verified &&
               provider.allowedEmailDomains.some((d) => claims.email!.toLowerCase().endsWith(d.toLowerCase()))
    return ok ? { action: 'create' }
              : { action: 'reject', reason: 'email-domain-not-allowed' }
  }
  // 'invite'
  if (existingInvitedByEmail && claims.email_verified) {
    return { action: 'bindInvited', userId: existingInvitedByEmail.id }
  }
  return { action: 'reject', reason: 'not-invited' }
}
```

### 5.6 redirect URI 推导

```ts
// auth/oidc/redirect.ts
export function resolveRedirectUri(c: Context, provider: OidcProvider, configPublicBaseUrl: string | null): string {
  const base = configPublicBaseUrl
    ?? deriveFromRequest(c, configTrustedHosts)  // X-Forwarded-Proto + X-Forwarded-Host 或 Origin
  return `${base.replace(/\/$/, '')}/api/auth/oidc/${provider.slug}/callback`
}

function deriveFromRequest(c: Context, trustedHosts: string[]): string {
  const proto = c.req.header('X-Forwarded-Proto') ?? new URL(c.req.url).protocol.replace(':','')
  const host  = c.req.header('X-Forwarded-Host')  ?? c.req.header('Host')
  if (trustedHosts.length > 0 && !trustedHosts.includes(host!)) {
    throw new BadRequestError('untrusted-host')
  }
  return `${proto}://${host}`
}
```

settings.json 新增：

```ts
publicBaseUrl: z.string().url().optional(),
trustedHosts: z.array(z.string()).default([]),
```

### 5.7 secret 加解

```ts
// auth/secretBox.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface SecretBox {
  seal(plaintext: string): string  // base64(iv|ct|tag)
  unseal(packed: string): string
}

export function createSecretBox(keyPath: string): SecretBox {
  const key = ensureKeyFile(keyPath)  // 32 random bytes, chmod 600
  return {
    seal(pt) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([c.update(pt, 'utf8'), c.final()])
      const tag = c.getAuthTag()
      return Buffer.concat([iv, ct, tag]).toString('base64')
    },
    unseal(packed) {
      const buf = Buffer.from(packed, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(buf.length - 16)
      const ct = buf.subarray(12, buf.length - 16)
      const d = createDecipheriv('aes-256-gcm', key, iv)
      d.setAuthTag(tag)
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
    },
  }
}
```

key 文件路径：`~/.agent-workflow/secret.key`，daemon 首启随机生成 32 字节 + chmod 600；丢失等价于"所有 OIDC client_secret 失效"（管理员需重输 client_secret）。备份指南文档化。

## 6. service 层

### 6.1 users.ts 接口

```ts
export interface UsersService {
  list(query: UsersQuery): Promise<{ rows: UserRow[]; total: number }>
  search(query: { q?: string; limit: number; excludeIds: string[] }): Promise<UserPublic[]>
  findById(id: string): Promise<UserRow | null>
  findByUsername(username: string): Promise<UserRow | null>
  create(actor: Actor, body: CreateUserBody): Promise<UserRow>
  update(actor: Actor, id: string, patch: PatchUserBody): Promise<UserRow>
  resetPassword(actor: Actor, id: string, opts: { newPassword: string; force?: boolean; revokePats?: boolean }): Promise<void>
  disable(actor: Actor, id: string): Promise<void>           // soft delete
}
```

`update` / `disable` 内置 **last-admin-protection**：

```ts
async function disable(actor, id) {
  const u = await findById(id); if (!u) throw new NotFoundError()
  if (u.id === '__system__') throw new ForbiddenError('system-user-immutable')
  if (u.id === actor.user.id) throw new BadRequestError('cannot-disable-self')
  if (u.role === 'admin') {
    const others = await countActiveAdmins({ excludeId: id })
    if (others === 0) throw new BadRequestError('last-admin-protection')
  }
  await db.update(users).set({ status: 'disabled' }).where(eq(users.id, id))
  await sessions.revokeAllForUser(id)
  // PAT 不动 —— admin 可单独决定是否 revoke
}
```

### 6.2 taskCollab.ts 关键函数

```ts
export interface TaskCollabService {
  ensureLauncherCollaborator(taskId: string, actorId: string): Promise<void>
  recordAssignments(taskId: string, actorId: string, items: NodeAssignmentInput[]): Promise<void>
  recordCollaborators(taskId: string, actorId: string, userIds: string[]): Promise<void>
  changeAssignment(actor: Actor, taskId: string, nodeId: string, kind: NodeAssignmentKind, newUserId: string): Promise<void>
  canViewTask(actor: Actor, task: TaskRow): Promise<boolean>
  isAssignedReviewer(actor: Actor, taskId: string, nodeId: string): Promise<boolean>
  isAssignedClarifyTarget(actor: Actor, taskId: string, nodeId: string): Promise<boolean>
  ensureValidAssignments(workflowDef: WorkflowDefinition, items: NodeAssignmentInput[]): void
}
```

`ensureValidAssignments` 纯函数：拒绝 nodeId 不存在 / 节点 kind 与 assignment.kind 不匹配 / 同 (nodeId, kind) 出现多次。

## 7. 路由变更点（影响清单）

下表列出受 RFC-036 改动的所有路由文件 + 改动方式：

| 文件                                           | 改动                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/server.ts`               | 把 `tokenAuth(deps.token)` 替换为 `multiAuth(deps)`；`mountAuthRoutes` `mountOidcRoutes` `mountUsersRoutes` 新挂 |
| `packages/backend/src/auth/token.ts`           | 保留但 export `legacyDaemonTokenAuth` 不再直接挂；新 `auth/session.ts` 持 multiAuth                              |
| `packages/backend/src/routes/agents.ts`        | GET → `requirePermission('agents:read')`；POST/PUT/DELETE/PATCH → `agents:write`                                |
| `packages/backend/src/routes/skills.ts`        | 同上，对应 `skills:*`                                                                                           |
| `packages/backend/src/routes/mcps.ts`          | `mcps:*`                                                                                                        |
| `packages/backend/src/routes/plugins.ts`       | `plugins:*`                                                                                                     |
| `packages/backend/src/routes/workflows.ts`     | `workflows:*`                                                                                                   |
| `packages/backend/src/routes/repos.ts`         | `repos:read` GET / `repos:write` POST                                                                           |
| `packages/backend/src/routes/cached-repos.ts`  | `repos:read` GET / `repos:write` POST / DELETE                                                                  |
| `packages/backend/src/routes/runtime.ts`       | `runtime:read`（admin + user 都可调，homepage runtime dot 依赖）                                                |
| `packages/backend/src/routes/config.ts`        | **GET → `settings:read`（admin only）**；**PUT → `settings:write`（admin only）**；non-admin 调直接 403          |
| `packages/backend/src/routes/backup.ts`        | **`backup:run`（admin only）**，与 settings 分离的独立权限点，备份恢复属敏感操作                                |
| `packages/backend/src/routes/health.ts`        | 维持公开（无 auth）                                                                                              |
| `packages/backend/src/routes/tasks.ts`         | POST → `tasks:launch` + collab record；GET list 加 scope；GET detail / WS 加 visibility gate；PATCH assignments 端点 |
| `packages/backend/src/routes/reviews.ts`       | GET 列表按 actor 过滤；POST decision 加 reviewer/owner/admin 校验                                                |
| `packages/backend/src/routes/clarify.ts`       | GET 列表按 actor 过滤；POST answer 加 clarify_target/owner/admin 校验                                            |

新文件：

| 文件                                                | 内容                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/routes/auth.ts`               | login/logout/me/change-password/sessions/pats/identities (user-scoped，挂 `requirePermission('account:self')` —— 自动通过 admin + user)       |
| `packages/backend/src/routes/oidc-auth.ts`          | `/api/auth/oidc/providers` (public) + login start + callback（前两个 public，callback 公开但端到端校验 state map）                            |
| `packages/backend/src/routes/users.ts`              | **`GET /api/users` / detail / POST / PATCH / DELETE / reset-password → admin only（`users:read` / `users:write`）**；`/api/users/search` → `requirePermission('users:search')`（admin + user 都可调，返公开 schema 只含 5 字段） |
| `packages/backend/src/routes/oidc.ts`               | **admin only**：CRUD `/api/oidc/providers` (`oidc:configure` write / `oidc:read` GET) + `/test` (`oidc:configure`)                            |

**端点权威性原则**：每个 admin-only 端点都用 `requirePermission` 显式挂；regular user (含 PAT 持有者) 越权 → 全部 403 `code: 'forbidden'` + 响应体 `{requiredPermission, actorPermissions: [...]}`，调试期能让 admin 一眼看出 actor 缺哪条。frontend `<NoPermissionEmpty>` 渲染同样的 i18n key，UI 与 API 错误体语义对齐。

## 8. 前端组件契约

### 8.1 `<UserPicker>`

```ts
type UserPickerProps =
  | { multiple: false; value: string | null; onChange: (v: string | null) => void; excludeIds?: string[]; placeholder?: string }
  | { multiple: true;  value: string[];        onChange: (v: string[]) => void;        excludeIds?: string[]; placeholder?: string }
```

行为：

- focus 触发 React Query `useUserSearch('')` 默认列表（按 last_used_at desc，前 20）；
- 输入 debounce 200ms（lodash.debounce / `useDebouncedValue` 均可，遵循 RFC-033 实现风格 = inline 函数）；
- 渲染：`display_name • username`（左）+ role chip + status chip（disabled 灰显 + tooltip "已停用"）；
- 键盘导航：`useKeyboardNav` 抽到 `lib/keyboardNav.ts`；
- 多选：选中追加 chip + 退格删除最后一个 + 已选项搜索结果中过滤；
- 单选：选中变 chip + 显示删除 X 清空；
- `excludeIds`：传入历史指派 user 时确保它仍能渲染（保留 chip）但搜索结果中过滤。

### 8.2 `<AssignmentsField>` (launcher 段)

```ts
interface AssignmentsFieldProps {
  workflowDefinition: WorkflowDefinition
  actorId: string
  value: NodeAssignmentInput[]
  onChange: (v: NodeAssignmentInput[]) => void
}
```

从 `workflowDefinition.nodes` 抽 `kind in {review, clarify}` 的节点，按 nodeId asc 渲染列表；每行单选 `<UserPicker single>`；默认值 = actorId；onChange 把每行的 userId 合并成 array 输出。"Reset all to me" 按钮一键回默认。

### 8.3 `<OidcLoginButtons>`

```ts
// 拉 /api/auth/oidc/providers 公开端点；按 displayName asc 渲染按钮；
// click → POST /api/auth/oidc/:slug/login/start → window.location = data.authorizeUrl
```

### 8.4 `<LoginForm>` 三入口

布局：

```
[username/password 表单]
─────── or ───────
[OIDC button: GitHub Enterprise]
[OIDC button: Google]
─────── 高级 ───────
> Use daemon token (折叠区，admin 维护用)
```

`/auth?redirect=/tasks/xxx` 仍走 redirect 跳回；OIDC start 端点把 `postLoginRedirect=...` 透传给 `consume()` 用。

### 8.5 `<UserMenu>` 侧栏 footer

admin 版（4 条目）：

```
┌─────────────────────────┐
│  [avatar] alice         │
│  Admin                  │
├─────────────────────────┤
│  我的账户   → /account   │
│  管理用户   → /users     │
│  系统设置   → /settings  │
│  退出登录                │
└─────────────────────────┘
```

regular user 版（2 条目）：

```
┌─────────────────────────┐
│  [avatar] bob           │
│  User                   │
├─────────────────────────┤
│  我的账户   → /account   │
│  退出登录                │
└─────────────────────────┘
```

实现要点：

- 渲染时通过 `usePermission('settings:read')` / `usePermission('users:read')` 判定，假则 dropdown 不渲染该条；
- `<SettingsGearButton>`（RFC-032 引入的独立齿轮 icon）**仅 admin 渲染**（DOM 中完全不存在，没有 disabled / hidden 状态）—— regular user 的 sidebar footer 只剩 `<LanguageSwitch> + <UserMenu>` 两件；
- 主题切换 / 语言切换走 sidebar footer 直接控件（与 RFC-025/032 一致），不再从 `/settings` 入口进入；regular user 修改这两项只写 localStorage，PUT `/api/config` 路径对其 403，前端按 hook 短路（admin 路径正常 sync 全局默认）。

### 8.6 `<NoPermissionEmpty>`

通用组件，所有 admin-only 路由（`/users` / `/users/$id` / `/settings` / `/settings/*` 子页）在路由组件入口立即 `usePermission('users:read'|'settings:read')` 判定，为假渲染：

```
┌────────────────────────────────┐
│        🔒 (lock icon)           │
│   需要管理员权限                 │
│   该页面仅 admin 角色可访问。     │
│   [回到首页]  [联系管理员]        │
└────────────────────────────────┘
```

- 复用 RFC-035 `<EmptyState>` 组件；
- "联系管理员"按钮仅作 UX 提示（mailto: `admin@...` 不实做，v1 显示文案 "请联系您的管理员"）；
- 不做 404 —— 让用户知道页面存在但无权访问，admin 可被告知去开权限；
- 同步在 sidebar 阶段就隐藏入口（DOM 不渲染齿轮 + UserMenu 里不显"管理用户"/"系统设置"行）；该 EmptyState 是**第二层兜底**（用户硬粘 URL 走过来）+ 后端 401/403 是**第三层权威**。

## 9. 启动 task 端到端时序

1. **前端 launcher 表单提交** → `POST /api/tasks` body 含 `repo / workflow_id / inputs / assignments[] / collaboratorUserIds[]`。
2. **后端校验**：`requirePermission('tasks:launch')` → `ensureValidAssignments(workflowDef, assignments)`（422 if invalid）→ 校验 userIds 全部 status='active'（422 if disabled）。
3. **事务**：
   ```
   BEGIN
     INSERT tasks (..., owner_user_id = actor.id);
     INSERT task_collaborators (task_id, actor.id, 'owner', actor.id, now);
     FOR each collaboratorUserIds: INSERT task_collaborators (..., 'collaborator');
     FOR each assignment: INSERT node_assignments (..., assignment);
     -- 同时把指派人也写一行 task_collaborators role='reviewer' or 'clarify_target'
     -- 保证 canViewTask 直接通过 collaborator 闭包，不用 join 两张表
   COMMIT
   ```
4. **scheduler 起 task**：与今天完全一样，无改动。
5. **review / clarify** 节点跑到 awaiting_review / awaiting_human：
   - WS 推送：`/ws/tasks/:id` channel + 全局 `/ws/inbox`（既有的 reviews / clarify pending-count 端点已经支撑，无需新 WS）；
   - 前端 inbox drawer 自动更新（reviewer 那侧）。
6. **reviewer 提交决策**：`POST /api/reviews/:nodeRunId/decision` → 走 `isAssignedReviewer(actor, task, node)`（先反查 nodeRun → task → assignments 表）→ 通过则写 `doc_versions.decidedBy = actor.id` → cascadeSiblingReviews 流转。
7. **clarify_target 答复**：同形。

## 10. 失败模式 + 边界

| 场景                                         | 行为                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| daemon token 文件丢失                        | daemon 启动失败 + log error；admin 须手动 `rm token && restart`                                                          |
| OIDC discovery 5xx / 超时                    | callback 返 503 friendly page "IdP unreachable"；admin /settings test 按钮显示同样错                                     |
| id_token sig 验证失败                        | callback 返 400 friendly page；事件 log `[rfc036/oidc-verify-failed]` 至 daemon log                                      |
| state 过期 / 不存在                          | callback 返 400 friendly page "Login session expired, try again"                                                         |
| `auto` provisioning + 同 email 已存在 user   | 不做 auto-link；继续创建新 user 行（username 防冲突追加后缀）；admin 后续在 /users 看到两个相似账号可手动 disable 一个    |
| invite-only IdP + email_verified=false       | 拒绝（reject reason='email-not-verified'）                                                                               |
| disabled provider 还有 identity              | identity 行保留；登录 flow 不渲染按钮；已登录用户 session 不动                                                           |
| 删除 provider with identities                | 409 `provider-still-linked`；query `force=true` 走 cascade，绑定该 provider 的 user 若 password_hash NULL 自动 disable    |
| reviewer disabled 后 task 进入 awaiting_review | reviewer 无法登录；task owner / admin 用 PATCH `/api/tasks/:id/assignments/:nodeId` 改新 reviewer                        |
| WS 升级时 task 不可见                          | 直接 reject `403`，client 自动跳 `/auth` 或显示无权页                                                                    |
| daemon token 持有人启动 task                | owner_user_id = `__system__`；admin 在 /tasks 看 "owner = System" 标识                                                   |
| PAT 过期                                      | resolvePat 直接返 null → 401；前端按 401 弹"PAT 失效，请重新登录"                                                        |
| 多个 admin 并发改最后 admin                   | last-admin-protection 在 service 层用 SELECT 后 UPDATE 不行；改用 `UPDATE WHERE (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active' AND id != ?) > 0` 单语句原子；UPDATE 0 rows → 抛错 |

## 11. 与其它 RFC 的兼容

- **RFC-005 review**：`doc_versions.decidedBy` 字段类型不变（TEXT）；新写入 user_id，旧 `'local'` 兼容渲染；review reject/iterate cascade 不动。
- **RFC-013 review historical versions**：历史版只读详情 + decidedBy 已记 → 渲染用 RFC-036 user 信息（小工具：`displayActor(decidedBy)` 函数把 ULID/local/system 三态各显示）。
- **RFC-014 iterate sibling regen**：cascade sibling decidedBy='system' 不变。
- **RFC-023 clarify**：`clarify_sessions.answeredBy` 同形改；clarify 节点 launcher 自动列入 assignments 列表 (kind='clarify_target')。
- **RFC-024 launch from Git URL**：launcher 表单两个 tab（path / URL）都加 assignments 段。
- **RFC-026 clarify inline session**：与 RFC-026 解耦；inline 模式下 clarify session 的答复人仍是 clarify_target 用户。
- **RFC-027 node session view / RFC-029 inventory / RFC-030 mcp probe**：纯数据展示，不涉及权限；GET 端点叠 `tasks:read:own` 即可，scope 由 visibility 闭包决定。
- **RFC-032 nav redesign**：sidebar footer 加 `<UserMenu>` (admin/user 两版列表条目)；`<SettingsGearButton>` 改为 **admin only 条件渲染**（regular user 完全不在 DOM）；`<LanguageSwitch>` 维持现状但其 PUT `/api/config` 路径对 user 403，hook 短路只写 localStorage；homepage greeting 拿 username；inbox drawer 不动（数据端点自动按 actor 过滤）。
- **RFC-033 batch repo import / RFC-034 submodule**：纯 admin 操作 → `repos:write`；regular user GET 不变。
- **RFC-035 UX consistency**：复用 RFC-035 的 `<Dialog>` `<EmptyState>` `<DetailLayout>` 组件；`/users` 详情用 DetailLayout；OidcProviderDialog 用 Dialog；`<NoPermissionEmpty>` 基于 `<EmptyState>` 实现 + 复用 lock icon 风格。

## 12. 测试策略

### 12.1 shared 包测试（vitest，纯函数）

- `permission.test.ts`：`PERMISSIONS` 常量 snapshot；`ROLE_PERMISSIONS.admin` 必须是 `PERMISSIONS` 全集（防漏加新权限点）；`ROLE_PERMISSIONS.user` 含 6 必有项（`agents:read` / `workflows:read` / `tasks:launch` / `account:self` / `users:search` / `runtime:read`）；**ROLE_PERMISSIONS.user 必不含 9 admin-only 点**（snapshot 锁负向集合：`settings:read` `settings:write` `users:read` `users:write` `oidc:read` `oidc:configure` `backup:run` `agents:write` `tasks:read:all`）；`hasPermission` 真值矩阵 6 cells（admin∋agents:write / user∌agents:write / user∋agents:read / admin∋oidc:configure / **user∌settings:read** / **user∌users:read**）。
- `user-schema.test.ts`：username regex 边界（首字符必字母 / 数字、长度 1..64、不允许大写）；email 可空；CreateUserBodySchema 缺 password 合法（invited）。
- `oidc-provider-schema.test.ts`：issuerUrl 必须是 URL；provisioning 必须 ∈ 3 枚举；allowedEmailDomains 每项必须 `@` 开头。
- `provisioning.test.ts`（纯函数 `decideProvisioning`）：6 path 覆盖（existingIdentity → login / auto → create / allowlist+match → create / allowlist+miss → reject / invite+verified-email-match → bindInvited / invite+no-match → reject）。
- `task-collab-schema.test.ts`：NodeAssignmentKindSchema 仅 2 枚举；TaskCollaboratorRoleSchema 仅 4 枚举。

### 12.2 backend 测试（bun:test，集成 + 单测）

- `auth-session.test.ts`：三种 token prefix 各正向 + 失效 / 过期 / revoked / 错位（aws_s_ 但 PAT）；daemon token 64-hex 长度边界（63 / 65 拒）；timingSafeEqual 路径覆盖。
- `users-service.test.ts`：CRUD 各端 + last-admin-protection（删 / disable / role→user）+ 软删 + 重置密码 revoke sessions + reset 不动 PAT + `__system__` immutability。
- `pats.test.ts`：generate token 含 prefix + sha256 后存盘 + 一次性返回原文 + lookup hit + lookup expire + lookup revoked。
- `oidc-flow.test.ts`：mock fetch 拦截 discovery + token endpoint + JWKS；构造合法 id_token 用 jose sign + 验证通过；nonce / aud / iss 各错一次 → 失败；state map 5min TTL；一次性消费。
- `oidc-providers-crud.test.ts`：create + edit (clientSecret 空保持 / 非空覆盖) + delete with identities → 409 + force=true cascade + delete 受影响 user 自动 disable.
- `task-visibility.test.ts`：admin scope=all 看全 / scope=mine 限自己 / user scope=mine 仅 owner∪collaborator / user 直访他人 task → 403；WS upgrade gate。
- `task-launch.test.ts`：assignments 422 path（disabled user / invalid nodeId / kind 不匹配 / 同 (nodeId,kind) 重复）+ 成功路径事务原子（中间错回滚到无脏 task_collaborators 行）。
- `review-decision-auth.test.ts`：reviewer 提交通过 + owner 提交通过 + admin 提交通过 + 第三方 403 + reviewer disabled → 401（session 已 revoke）+ decidedBy 持久化为 actor.id（不是 'local'）。
- `clarify-answer-auth.test.ts`：同形。
- `secret-box.test.ts`：seal → unseal round-trip；不同 key 解密失败；tag 篡改失败。
- `last-admin-atomic.test.ts`：模拟两个 admin 并发 `disable` 对方 → 最多一个成功。
- `admin-only-gate.test.ts`：**user session token 调以下 endpoint 全 403**：`GET /api/config` / `PUT /api/config` / `GET /api/oidc/providers` / `POST /api/oidc/providers` / `PATCH /api/oidc/providers/:id` / `DELETE /api/oidc/providers/:id` / `POST /api/oidc/providers/:id/test` / `GET /api/users` / `GET /api/users/:id` / `POST /api/users` / `PATCH /api/users/:id` / `DELETE /api/users/:id` / `POST /api/users/:id/reset-password` / `POST /api/backup` / `POST /api/backup/restore`；每条断言响应体 `{code: 'forbidden', requiredPermission}` 准确；同 user session 调 `GET /api/users/search?q=alice` 返 200（公开字段 only），返回体不含 email/lastLoginAt（snapshot 锁公开 schema）；同 user session 调 `GET /api/runtime/opencode` 返 200（homepage 依赖）。
- `pat-permission-gate.test.ts`：user 的 PAT 持有相同权限点（不能"PAT 绕过 role 限制"）；admin 创 PAT 留 `scopes: ['tasks:launch']` 时调 `/api/agents` 写 → 403（scope 严格）。

### 12.3 frontend 测试（vitest + @testing-library/react）

- `user-picker.test.tsx`：debounce 200ms + 首次 focus 拉默认列表 + 键盘上下 + Enter + 多选追加 chip + 退格删除 + disabled 用户灰显 + excludeIds 不重复出现 + accessibility（role=combobox / aria-activedescendant）。
- `assignments-field.test.tsx`：workflow def 含 2 review + 1 clarify + 3 agent 节点 → 列出 3 行（review × 2 + clarify × 1）+ 默认 actorId + 改一行后 onChange payload；Reset all 还原。
- `login-form.test.tsx`：username/password 流 + 三种错误（401 / 423 disabled / mustChangePassword 弹框）；OIDC providers 端点空 → 不渲染分隔线；多 provider 按 displayName asc。
- `change-password-dialog.test.tsx`：旧 / 新 / 确认匹配 + force_password_change=true 时跳旧字段。
- `users-page.test.tsx`：admin 渲染 New 按钮 + 列表行操作；user 渲染 NoPermissionEmpty；admin 自己行 disable / 改 role 按钮 disabled。
- `account-page.test.tsx`：/account 路由 admin + user 都可进；linked identities / PAT 列表 / generate PAT 弹框（含一次性 secret + copy）/ sessions revoke。
- `settings-page-admin-gate.test.tsx`：admin 进 `/settings` 看到 tabs（Appearance/Runtime/Authentication/Backup）；**user 进 `/settings` → `<NoPermissionEmpty>` + "回到首页"按钮**；user 进 `/settings/authentication` 同形（任意 hash/子路径都拦）；user mocked permissions Set 不含 settings:read 时所有子页都拦截。
- `settings-authentication-tab.test.tsx`：admin only；provider 列表 + Add / Edit / Test connection；非 admin 因 settings 整页被拦不会到达此组件。
- `user-menu-condition-render.test.tsx`：admin sidebar footer dropdown 显示 4 条（我的账户 / 管理用户 / 系统设置 / 退出登录）；user 显示 2 条（我的账户 / 退出登录）；**user DOM 中完全无 `<SettingsGearButton>` 节点**（querySelector 返 null，不是 hidden / disabled）；同 user query "管理用户" / "系统设置" 文案应不存在。
- `no-permission-empty.test.tsx`：组件渲染 lock icon + "需要管理员权限"标题 + 两按钮（回到首页 + 联系管理员）；click 回到首页 → navigate `/`。
- `task-launcher-assignments.test.tsx`：提交时 assignments 透传后端；assignments userId 必填校验前端兜底（不让空提交）。
- `task-detail-no-permission.test.tsx`：GET 返 403 task-not-visible → 渲染 friendly page。
- `oidc-login-buttons.test.tsx`：click → window.location.assign(authorizeUrl)；端点错时不崩。
- `i18n-keys-symmetry.test.ts`：zh-CN / en-US 新增 keys 对称（与 RFC-025/032/035 一致风格）。

### 12.4 e2e (Playwright)

- `e2e/multi-user.spec.ts`：fixture seed admin alice + user bob + user carol →
  1. alice 登录 → 创建 OIDC provider（mock IdP 端点本地 stub）→ test connection OK；
  2. bob 用 username/password 登录 → 启动一个 task workflow `review-test`（含 1 review 节点），指派 carol 评审 + 加 alice collaborator；
  3. carol 登录 → inbox badge=1 → /reviews 列表显示该条 → 进 detail 决策 approve；
  4. dave（新用户）直访该 task URL → 403 friendly page；
  5. alice 在 /tasks scope=all 看到 task，owner=bob，collaborators 含 alice + carol（reviewer）。
- `e2e/oidc-login.spec.ts`：stub OIDC IdP（用本地 Bun 起小 HTTP server 模拟 discovery + authorize + token + JWKS）→ alice 配 provider → bob 第一次 OIDC 登录 auto-provision → 第二次直接 login → unlink → 第三次 login 拒绝（reject reason='not-invited' if provisioning='invite'）。

## 13. CLI 设计

`packages/backend/src/cli/user.ts`：

```bash
agent-workflow user create --username <name> [--role admin|user] [--display "Name"] [--email <em>] [--password <pw>]
agent-workflow user reset-password --username <name> --new-password <pw>
agent-workflow user list  # 短表格
agent-workflow user disable --username <name>
```

实现：直接 connect sqlite（与 daemon 同一文件），跑 service 层函数；不走 HTTP。`agent-workflow user create --admin --username alice` 等价 `--role admin`。

## 14. 监控 / 日志 / redaction

- 所有 user_id 在 log 里只打 `<id-prefix-8>`，避免日志泄漏全 ULID（与 RFC-024 redactGitUrl 风格一致）。
- OIDC client_secret 在所有 log path 都过 `redactSecret` （新 lib，复用 `redactSensitiveString`）。
- PAT raw token 仅在 generate response 返回一次，**绝不**写 log；DB 仅存 hash。
- session token 同 PAT。
- daemon log 标准结构 `{actor: {id, source}, action, resource, ms, status}` 让 future audit log RFC 可以直接转储。

## 15. 性能 / 限额

- session / PAT 查询走 token_hash UNIQUE index → O(log n)；
- user search LIKE 走 username/email/display_name 普通 index（不开 FTS5）；
- discovery 缓存 1h；JWKS 同；OIDC callback 路径在缓存命中时 < 50ms（不含 IdP token endpoint round-trip）；
- in-memory state map：5min TTL；预估上限 1k 并发 OIDC 登录 → ~256B × 1k = 256KB，可接受；
- WS 鉴权：upgrade 一次性校验 + cache actor 到 connection 对象，无需每帧重算。

## 16. 备份 / 升级

- 备份：sqlite + `~/.agent-workflow/secret.key` 必须同时备份（key 丢失 = 无法解 OIDC client_secret）。在 `agent-workflow backup` CLI 输出文件 + 文档显式提示。
- 升级：migration 0018/0019/0020 顺序运行；首启自动 seed `__system__`；users 仅含 `__system__` 时框架按"single-user mode"行为；admin 创建第一个真实 user 后系统自动切到 multi-user mode（无开关，由数据状态驱动）。
- 降级（unsupported, but）：用户若需回退到 P-1-02 行为，stop daemon + rename db.sqlite + start = 新空 DB，token 仍可用；旧数据保留可手动恢复。
