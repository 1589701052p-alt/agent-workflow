# RFC-036 — 实施计划

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。本文件把 RFC 拆成可独立 PR 的 5 段任务清单，每段自带验收 checklist + 回退路径。

## 拆分原则

- **PR1 = 基础 schema + 三轨鉴权**：纯后端 + shared，不动现有 UI，让 daemon token 老路径保持 100% 兼容；落地后 multi-user 子系统 dormant（users 表只有 `__system__`）。
- **PR2 = 权限点强制 + 任务可见性**：把所有写操作 + 任务列表/详情套上 `requirePermission` + visibility filter；不影响 daemon token actor（满 admin 权限）；regular user 此时还登不进来（PR3+4 才有 UI），所以 PR2 单纯是"为后续解锁做准备"，对当前用户零行为变化。
- **PR3 = OIDC 落地**：新 oidc_providers + user_identities + login flow + admin CRUD + test connection；本身只是控制面，PR4 才接入登录页。
- **PR4 = 任务级协作 + 节点指派**：扩展 POST /api/tasks body；taskCollab service；review/clarify 决策权校验；PATCH assignments 端点；这是真正让 multi-user 跑起来的 PR。
- **PR5 = 完整 UI**：登录页扩展、UserPicker、users admin（含 `<NoPermissionEmpty>` gate）、**`/account` 用户自服务（独立路由，不挂 /settings 下）**、`/settings` 整页 admin-only gate（含 authentication tab）、launcher assignments 段、sidebar UserMenu（admin/user 两版条目，user DOM 中无齿轮）、homepage greeting；i18n 中英对称；e2e 含 admin-only gate spec。

## 依赖

```
PR1 → PR2 → PR3
         ↘
          PR4 → PR5
PR3 ─────↗
```

PR1 必先；PR2 / PR3 可并行（PR2 不涉及 OIDC、PR3 不涉及权限点）；PR4 依赖 PR1/PR2；PR5 依赖全部前置（但 UI 内部可分模块并行）。

---

## PR1 — schema + 三轨鉴权 + bootstrap

**目标**：DB 加 7 张表 + 1 列 + seed `__system__`；middleware 支持 daemon token / session token / PAT 三轨；不改任何业务 route；老 daemon token 路径无感。

### Tasks

- **RFC-036-T1**：写 migration 0018 (`packages/backend/db/migrations/0018_rfc036_users.sql`)：users / user_sessions / user_pats / user_identities (无 FK to oidc_providers) + indexes + seed `__system__` row。注意 `email UNIQUE` 在 SQLite 允许多个 NULL。
- **RFC-036-T2**：写 migration 0019 (`0019_rfc036_oidc_providers.sql`)：oidc_providers 表 + 把 user_identities 重建加 provider_id FK。
- **RFC-036-T3**：写 migration 0020 (`0020_rfc036_task_collab.sql`)：tasks.owner_user_id ALTER ADD + task_collaborators + node_assignments + indexes。
- **RFC-036-T4**：drizzle schema (`packages/backend/src/db/schema.ts`) 同步加 6 个 sqliteTable + 1 列。运行 `bun run drizzle-kit generate` 生成对应 .sql 与上手写一致（不一致时以手写为准修 schema.ts）。
- **RFC-036-T5**：shared zod schemas（`permission.ts` `user.ts` `oidcProvider.ts` `taskCollab.ts`），exports + barrel re-export 加到 `packages/shared/src/index.ts`。**包括 PERMISSIONS 常量 + ROLE_PERMISSIONS + hasPermission 函数**。
- **RFC-036-T6**：`auth/passwords.ts` argon2id wrapper（`argon2` npm 包，参数 `memoryCost=19456, timeCost=2, parallelism=1`，与 OWASP 2024 推荐一致）。
- **RFC-036-T7**：`auth/secretBox.ts` AES-256-GCM 包/解；`ensureKeyFile(~/.agent-workflow/secret.key)` daemon 首启随机 + chmod 600。
- **RFC-036-T8**：`auth/sessionStore.ts` create / lookup by hash / revoke / sweepExpired；`patStore.ts` 同形。
- **RFC-036-T9**：`auth/session.ts` 三轨 `multiAuth(deps)` middleware + `Actor` 类型 + `actorOf(c)` helper；保留 `auth/token.ts` legacy 函数但 server.ts 改挂 multiAuth。
- **RFC-036-T10**：`server.ts` 把 `app.use('/api/*', tokenAuth(deps.token))` 改成 `multiAuth(deps)`；`/api/whoami` 返 `{user, source}` 替代旧 `{ok, pid}`（兼容字段同时返回）。
- **RFC-036-T11**：CLI `agent-workflow user create / reset-password / list / disable` (`src/cli/user.ts`)，直连 sqlite + 调 users service（先写最小 service，PR2 完善）。
- **RFC-036-T12**：daemon 启动日志：若 users 表只有 `__system__` 行，log "首次多用户使用？运行 `agent-workflow user create --admin --username <name>`"。
- **RFC-036-T13**：单测一次过：
  - `auth-session.test.ts`（三轨正反路径）
  - `secret-box.test.ts`（round-trip + tag tamper）
  - `password-hash.test.ts`（verify roundtrip + wrong password）
  - `sessions.test.ts` / `pats.test.ts`（create/lookup/revoke/expire）
  - `users-cli.test.ts`（CLI 子命令）
  - shared `permission.test.ts` / `user-schema.test.ts` / `oidc-provider-schema.test.ts` / `task-collab-schema.test.ts`

### Acceptance checklist（PR1）

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] 老 daemon token 走 `Authorization: Bearer <64-hex>` 仍返 200（手测 + e2e 不动）
- [ ] 数据库 migrate 后 users 表含 `__system__` 行；无其它行
- [ ] `agent-workflow user create --admin --username alice --password xxx` 成功 + 二次跑返 409
- [ ] `agent-workflow user reset-password --username alice --new-password yyy` 后 alice session 全 revoke
- [ ] secret.key 文件 chmod 600 + 内容随机；删后下次启动重新生成 + log warning（OIDC client_secret 解密失败提示）
- [ ] 无 UI 改动；前端测试套件零退化

### Rollback

PR1 反复 commit 即可（DB migrations 无破坏性 ALTER，纯 ADD）；secret.key 文件保留无害；users 表数据不会被任何业务读取（PR2 才接入）。

---

## PR2 — 权限点强制 + 任务可见性

**目标**：所有写操作路由套 `requirePermission(*:write)`；GET 路由套 `*:read`；任务列表 + 详情 + reviews/clarify 子路径加 visibility filter；daemon token actor（满 admin 权限）行为 100% 不变；为 PR3+PR4 解锁。

### Tasks

- **RFC-036-T14**：`services/permissions.ts` `requirePermission(perm)` factory + `ForbiddenError(perm)` 派生 4xx；`util/errors.ts` 加 `Forbidden` 错码。
- **RFC-036-T15**：retrofit 写路由（按 design §7 表）：agents / skills / mcps / plugins / workflows / repos / cached-repos —— 共约 25 个 endpoint，加 `requirePermission(*:write)`。
- **RFC-036-T15a**：**admin-only 端点显式加 gate**：`/api/config` GET → `settings:read` + PUT → `settings:write`；`/api/backup` POST → `backup:run`（新权限点）；`/api/oidc/providers` 全 CRUD → `oidc:configure`（write） / `oidc:read`（GET）；`/api/users` list / detail / POST / PATCH / DELETE / reset-password → `users:read` / `users:write` 区分（已经在 users.ts，但要确保不是 `account:self`）。每条 endpoint test 覆盖 user-token 路径直接 403。
- **RFC-036-T16**：retrofit 读路由：runtime / agents GET / 等，加 `requirePermission(*:read)`；`/api/users/search` 单独加 `users:search` 权限。
- **RFC-036-T16a**：写 `admin-only-gate.test.ts` 集成测：seed 1 admin + 1 user session token，遍历 16 个 admin-only endpoint 各发一次请求验 403 + 错误体含 `requiredPermission`；遍历 user 应可调的端点（/api/users/search / /api/auth/me / /api/runtime/opencode）验 200；`/api/users/search` response shape 锁 5 字段（snapshot 不含 email / lastLoginAt）。
- **RFC-036-T17**：`services/taskCollab.ts` 最小骨架：`canViewTask(actor, task)` `hasMembership(taskId, userId)`；先无 launcher 写入路径（PR4 加），但 visibility 已可读 task_collaborators 表（空查询返 false）。
- **RFC-036-T18**：`routes/tasks.ts` GET list 加 scope 查询参 + visibility SQL；GET detail 加 `canViewTask` gate；GET node-runs 同；DELETE / cancel 加 owner-or-admin 校验。
- **RFC-036-T19**：`routes/reviews.ts` GET 列表按 actor 过滤；POST decision 加临时 owner-or-admin 校验（PR4 才完整加 reviewer 校验，PR2 阶段所有 owner / admin 仍可决策）；同形 `routes/clarify.ts`。
- **RFC-036-T20**：WS `/ws/tasks/:id` upgrade gate 加 visibility check（不可见返 403 close）。
- **RFC-036-T21**：测试：
  - `agents-permission.test.ts`（user-token 写 agents → 403 / read → 200）
  - `tasks-visibility.test.ts`（admin scope=all / user scope=mine 含 owner+collab / 第三方直访 403）
  - `reviews-decision-pr2.test.ts`（owner ✓ / admin ✓ / 第三方 ✗）
  - 全套既有 backend 测试零退化（admin / daemon token 行为不变）

### Acceptance checklist（PR2）

- [ ] CI 三件套全绿
- [ ] daemon token 调任意写路由仍 200（actor → __system__ admin）
- [ ] 创建一个 user role=user + 走其 session token：GET /api/agents 返 200，POST /api/agents 返 403
- [ ] **`admin-only-gate.test.ts` 全 16 endpoint 通过**：user-token 调 `/api/config` GET/PUT、`/api/oidc/providers` 全 CRUD、`/api/users` list/detail/POST/PATCH/DELETE/reset-password、`/api/backup` POST/restore 全部 403 + 错误体含 `requiredPermission`
- [ ] user-token 调 `/api/users/search?q=alice` 200 + 返回体只含 5 公开字段（snapshot 锁）
- [ ] user-token 调 `/api/runtime/opencode` 200（homepage runtime dot 依赖）
- [ ] 老 e2e 全部跑通（任务 visibility 默认 ownerUserId NULL → admin 走 scope=all 也能看）
- [ ] 任务 visibility SQL 不退化（list query plan 用 idx_tasks_owner / idx_task_collab_user）

### Rollback

把 `multiAuth` 临时切回 `legacyDaemonTokenAuth` 即可；`requirePermission` middleware 自动 short-circuit（actor.source='daemon' 永远满足）。

---

## PR3 — OIDC providers + 登录 flow + identity linking

**目标**：admin 可在 `/api/oidc/providers` CRUD provider；OIDC discovery + token exchange + id_token verify 跑通；新用户按 provisioning 策略自动建/拒；现有 user 可主动 link/unlink identity。**不**改前端登录页（PR5）。

### Tasks

- **RFC-036-T22**：`services/oidcProviders.ts` CRUD + `testDiscovery(issuerUrl)`（返 metadata 不落盘）。client_secret 经 secretBox 加密落 DB；read 路径返 redacted。
- **RFC-036-T23**：`auth/oidc/discovery.ts` discovery 拉 + 1h LRU cache；JWKS 同步拉 + cache。
- **RFC-036-T24**：`auth/oidc/flow.ts` in-memory state map + PKCE codeVerifier 生成 + 5min TTL + 一次性 consume + hourly GC ticker（复用 `cli/start.ts`）。
- **RFC-036-T25**：`auth/oidc/tokens.ts` 用 jose 验 id_token（sig + iss + aud + nonce + iat/exp）；exchange code → tokens（POST token endpoint）。
- **RFC-036-T26**：`services/oidc/provisioning.ts` 纯函数 `decideProvisioning`，6 path。
- **RFC-036-T27**：`services/userIdentities.ts` create / lookup by (provider, subject) / unlink。
- **RFC-036-T28**：`routes/oidc.ts` admin CRUD `/api/oidc/providers` + `/test` 端点。
- **RFC-036-T29**：`routes/oidc-auth.ts` 公开端点：`GET /api/auth/oidc/providers` + `POST /api/auth/oidc/:slug/login/start` + `GET /api/auth/oidc/:slug/callback`；含 4 path provisioning 处理。
- **RFC-036-T30**：`routes/auth.ts` user-scoped identities 子端点：GET / POST link/start / DELETE unlink。
- **RFC-036-T31**：config schema 加 `publicBaseUrl` `trustedHosts`；`auth/oidc/redirect.ts` resolve 函数。
- **RFC-036-T32**：测试：
  - `oidc-providers-crud.test.ts`（create + edit clientSecret 空保持 / 非空覆盖 + delete with identities 409 + force cascade）
  - `oidc-discovery.test.ts`（mock fetch + 1h cache + bypass on TTL）
  - `oidc-flow.test.ts`（state TTL + 一次性 + PKCE / nonce 验证）
  - `oidc-tokens.test.ts`（jose sign + verify + 各错位 → fail）
  - `provisioning.test.ts`（6 path）
  - `oidc-callback.test.ts`（4 path 端到端走 mock IdP）
  - `redirect-uri.test.ts`（publicBaseUrl 优先 / X-Forwarded-* 推导 / trustedHosts 校验）
  - `identities-crud.test.ts`（link / unlink / disable user cascade）

### Acceptance checklist（PR3）

- [ ] CI 三件套全绿
- [ ] admin 用 daemon token 经 `/api/oidc/providers` 创建一个 mock IdP provider → 立即可见
- [ ] 走 mock IdP 跑通完整 callback 流（auto / allowlist 命中 / allowlist 拒 / invite 命中 / invite 拒）
- [ ] discovery 5xx → 503 friendly；id_token 错签 → 400 friendly；state 过期 → 400 friendly
- [ ] secret.key 旋转后 OIDC client_secret 解密失败 → log error + provider 行 enabled 状态由 admin 在 UI 手动修；后端不自动 disable
- [ ] 前端零改动

### Rollback

把 oidc-auth 路由 mount 注释掉即可；DB 表保留无害。

---

## PR4 — 任务级协作 + 节点指派 + review/clarify 权限校验

**目标**：POST /api/tasks 接受 `assignments[]` + `collaboratorUserIds[]`；事务持久化；review decision / clarify answer 加 reviewer/clarify_target 校验；PATCH assignments 端点；audit 字段 `decidedBy` / `answeredBy` 从 'local' 切到真实 user_id。

### Tasks

- **RFC-036-T33**：`taskCollab.ts` 完整 service：`ensureLauncherCollaborator` `recordAssignments` `recordCollaborators` `changeAssignment` `isAssignedReviewer` `isAssignedClarifyTarget` `ensureValidAssignments`（纯函数版可单测）。
- **RFC-036-T34**：`shared/schemas/task.ts` 扩展 `CreateTaskBodySchema` + `TaskSchema` + `ListTasksQuerySchema`。
- **RFC-036-T35**：`routes/tasks.ts` POST 增加 assignments / collaborators 解析 + 事务（与 task INSERT 同事务，保证一致性）+ assignment 校验 422 path。同时把指派人也写到 task_collaborators（PR2 visibility 已读这表）。
- **RFC-036-T36**：`PATCH /api/tasks/:id/assignments/:nodeId` 端点（owner / admin 可调）。
- **RFC-036-T37**：`services/review.ts` decideReview 函数加 `actor` 入参，先 isAssignedReviewer 校验 → 通过则写 `decidedBy = actor.user.id`；旧 `'local'` 历史行不动。`services/clarify.ts` submitAnswer 同形 `answeredBy`。
- **RFC-036-T38**：`routes/reviews.ts` / `routes/clarify.ts` 决策 / 答复路径换成新 service 签名。
- **RFC-036-T39**：测试：
  - `task-launch.test.ts`（assignments 422 + 事务原子 + 默认值填充 + admin scope=all 看到 owner=actor 行）
  - `task-collab-service.test.ts`（纯函数 ensureValidAssignments 8 case）
  - `review-decision-auth.test.ts`（reviewer ✓ / owner ✓ / admin ✓ / 第三方 ✗ / reviewer disabled → 401）
  - `clarify-answer-auth.test.ts`（同形）
  - `decided-by-audit.test.ts`（新决策写 user_id；历史 'local' 行渲染显示"system / 历史"）
  - `assignments-patch.test.ts`（owner / admin 可改；他人 403；不存在 nodeId 404）

### Acceptance checklist（PR4）

- [ ] CI 三件套全绿
- [ ] e2e: bob 启动 task 指派 carol 评审 → 数据库 task_collaborators 含 (task, carol, 'reviewer') + (task, bob, 'owner') + node_assignments (task, node, 'reviewer', carol)
- [ ] carol 用她的 session token 决策 review → 200 + decidedBy=carol.id；dave 同操作 → 403 not-reviewer
- [ ] daemon token 启动 task → owner_user_id = '__system__'
- [ ] 老 review 历史 doc_versions.decidedBy='local' 行能正常读 + 渲染（PR5 才接入文案）

### Rollback

把 POST /api/tasks 解析 assignments 段注释（默认行为 = 全归 actor），review / clarify 校验回到 PR2 路径（owner / admin 仍可决策）；指派表数据可保留。

---

## PR5 — 完整 UI（登录 / users admin / account self-service / OIDC config / launcher assignments / sidebar UserMenu）

**目标**：用户/管理员能在网页上完成所有 multi-user 操作；OIDC 登录按钮；UserPicker；i18n 中英对称；Playwright e2e 全套。

### Tasks

- **RFC-036-T40**：`components/UserPicker.tsx` 共享组件 + `hooks/useUserSearch.ts`（React Query 包 `/api/users/search`，key=q+excludeIds）。
- **RFC-036-T41**：`hooks/useActor.ts` 拉 `/api/auth/me`（含 permissions Set）；`usePermission(perm)` 单 hook 让组件按权限隐藏按钮。
- **RFC-036-T42**：`stores/auth.ts` 扩展三种 token 存盘（localStorage key 区分）+ 401 时清除并跳 /auth?redirect。
- **RFC-036-T43**：`components/user/LoginForm.tsx` 三入口布局（username/password + OIDC buttons + daemon token 折叠）；`OidcLoginButtons.tsx` 拉公开 providers 端点。
- **RFC-036-T44**：`routes/auth.tsx` 扩展挂载新 LoginForm；保留 `redirect` query 行为；mustChangePassword 时跳 `ChangePasswordDialog`。
- **RFC-036-T45**：`components/user/ChangePasswordDialog.tsx`（复用 RFC-035 `<Dialog>`）。
- **RFC-036-T46**：`routes/users.tsx` admin 列表 + Create dialog + 行操作 dropdown；用 `usePermission('users:read')` 入口判定，假则渲染 `<NoPermissionEmpty>`。
- **RFC-036-T47**：`routes/users.detail.tsx` 详情：basic info / reset password / disable toggle / linked identities (admin readonly) / sessions (admin 可 revoke)；同 `<NoPermissionEmpty>` gate。
- **RFC-036-T48**：**新 `routes/account.tsx`** 用户自服务（`/account` 路由，不挂在 /settings 下）：Profile / Password / Linked identities / PAT / Sessions 五段；admin + user 都可访问（仅需 `account:self`）。
- **RFC-036-T49**：`components/settings/AuthenticationTab.tsx` admin 段（settings tabs 内）：publicBaseUrl 字段 + providers 列表 + Add/Edit/Delete/Test connection；不单独做 admin gate（settings 整页已 gated）。
- **RFC-036-T49a**：**`routes/settings.tsx` 全页 admin gate**：组件入口加 `if (!usePermission('settings:read')) return <NoPermissionEmpty />`；hash 子页（appearance / runtime / authentication / backup / network）都走同一 gate；snapshot 测试 user actor 不渲染 tab list。
- **RFC-036-T50**：`components/tasks/AssignmentsField.tsx` + `CollaboratorsField.tsx` 接入 launcher 表单 (`routes/workflows.launch.tsx`)；onChange 拼到 POST /api/tasks body。
- **RFC-036-T51**：`components/user/UserMenu.tsx` sidebar footer 头像 dropdown；admin/user 两版条目（admin 4 条 / user 2 条，差 "管理用户" + "系统设置"，通过 `usePermission('users:read')` / `usePermission('settings:read')` 条件渲染）；调整 RFC-032 footer 布局：LanguageSwitch + UserMenu 两件 + `<SettingsGearButton>` **仅 admin 渲染**（regular user DOM 中完全不存在该 button）。
- **RFC-036-T51a**：`components/NoPermissionEmpty.tsx` 共享组件（复用 RFC-035 `<EmptyState>`），lock icon + 标题 + 副标题 + 两按钮（回首页 + 联系管理员）；i18n key 5 条。
- **RFC-036-T52**：homepage `<HomepageGreeting>` 接入 actor.displayName（i18n key 加 `home.greet.morningWithName`）。
- **RFC-036-T53**：i18n 中英 +约 130 keys：login form / change password / users page / users detail / settings authentication / **account page (/account)** / OIDC provider dialog / PAT dialog / sessions / linked identities / assignments field / collaborators field / sidebar user menu (admin 4 条 + user 2 条文案) / **NoPermissionEmpty 5 keys（标题 / 副标题 / 回首页按钮 / 联系管理员按钮 / icon alt）** / errors（403 task-not-visible / not-reviewer / not-clarify-target / **forbidden（含 requiredPermission 占位）** / email-domain-not-allowed / not-invited / state-expired / discovery-failed / verify-failed / last-admin-protection / system-user-immutable / cannot-disable-self）；Resources interface zh-CN.ts 扩展。
- **RFC-036-T54**：测试：所有 frontend testsuite（design §12.3 列表）。
- **RFC-036-T55**：Playwright e2e：
  - `e2e/multi-user.spec.ts`（alice admin + bob user + carol user 全链路）
  - `e2e/oidc-login.spec.ts`（本地 stub IdP server + 4 path 验证）

### Acceptance checklist（PR5）

- [ ] CI 三件套 + Playwright e2e 全绿
- [ ] frontend 全套测试无退化（既有 ~1380 case + 新增 ~85 case）
- [ ] zh-CN / en-US key 对称（i18n-keys-symmetry.test.ts 守卫）
- [ ] /auth 页未登录访问任意 /api/* 路由跳转回 /auth?redirect=...
- [ ] sidebar footer 在不同 viewport 不溢出 + UserMenu dropdown 居左展开
- [ ] launcher 表单的 assignments 段默认显示当前 actor + Reset all 按钮可用
- [ ] OIDC login 流（mock IdP）e2e 通过
- [ ] **e2e admin-only gate**：seed user bob login → 验证 sidebar 完全无齿轮 icon DOM 节点 + UserMenu dropdown 只有 2 条 → 硬粘 URL `/settings` `/settings/authentication` `/users` `/users/{adminId}` 全部渲染 `<NoPermissionEmpty>` + 不发起任何 admin-only API 请求（network panel 验）；同 admin alice 登录验证齿轮可见、UserMenu 4 条、四 URL 全渲染正常内容
- [ ] regular user 走 sidebar LanguageSwitch 切语言：localStorage 写入但 `/api/config` 请求被前端 hook 短路（不发出 PUT，network panel 验）

### Rollback

UI feature flag `multiUserUiEnabled: false`（默认 true）。关闭后侧栏隐藏 UserMenu + 显示齿轮（即使 user）+ /settings 路由不做 gate，登录页只显示 daemon token 入口，users / account / authentication tab 不渲染；backend 仍按权限 gate（用户即使骗过 UI 也被后端 403 兜底，不退化安全）。

---

## 跨 PR 风险 + 缓解

- **风险 A**：PR3 OIDC discovery 引入 jose 依赖 → 单二进制 build 体积。**缓解**：jose 是 pure ESM 小包（< 50KB minified）；P-5-05 单二进制构建已支持 ESM tree-shake。
- **风险 B**：PR4 事务 + visibility filter 性能。**缓解**：design §15 索引设计；提前在 PR1 加 idx_tasks_owner / idx_task_collab_user / idx_node_assign_task；e2e 跑大库压测（fixture 1k tasks）。
- **风险 C**：PR5 UI 巨量改动 + 旧 e2e 退化。**缓解**：PR5 内部按组件单测先全绿再跑 e2e；feature flag 提供逐部分 enable；保留 daemon token 入口为兜底。
- **风险 D**：argon2 npm 包在 Bun 兼容性。**缓解**：用 `@node-rs/argon2`（pure Rust + napi，Bun 长期跑通）；先在 PR1 跑 hash/verify roundtrip 测试锁兼容。

## 验收清单（整 RFC）

- [ ] 全部 5 PR push 落 origin/main + CI 全绿
- [ ] 验收 8 个 user story（proposal §4）逐条手测通过
- [ ] 所有 design §10 失败模式 e2e/unit 至少 80% 覆盖
- [ ] STATE.md 移除 "进行中 RFC: RFC-036"；plan.md RFC 索引 RFC-036 行状态从 In Progress → Done
- [ ] 老 e2e + 老 backend / frontend / shared 测试 0 退化
- [ ] 文档：README.md 加 "多用户 & OIDC 接入" 段（最小 quickstart）；secret.key 备份注意事项
