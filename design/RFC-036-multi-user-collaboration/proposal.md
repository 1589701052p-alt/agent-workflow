# RFC-036 — 多用户协作 + 权限管理 + OIDC 单点登录（admin / user + 任务协作者 + 节点级评审 / 反问指派 + 个人访问令牌）

| 字段     | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号     | RFC-036                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 状态     | Draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 作者     | binquanwang                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 提交日期 | 2026-05-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 关联     | [P-1-02 token auth](../plan.md#p-1-02-token-鉴权--agent-workflowtoken), [RFC-005 human review](../RFC-005-human-review/proposal.md), [RFC-023 clarify](../RFC-023-agent-clarify/proposal.md), [RFC-026 clarify inline session](../RFC-026-clarify-inline-session/proposal.md), [RFC-032 nav redesign](../RFC-032-nav-redesign/proposal.md), [RFC-013 review historical versions](../RFC-013-review-historical-versions/proposal.md), [RFC-024 launch from git URL](../RFC-024-launch-from-git-url/proposal.md) |

## 1. 背景

agent-workflow 当前是**单用户本机工具**的形态：

- **鉴权**只有一根 `~/.agent-workflow/token`（P-1-02 / `packages/backend/src/auth/token.ts`），daemon 启动随机生成 64 hex chars，写 chmod 600；所有 `/api/*` 与 `/ws/*` 用 `Authorization: Bearer <token>` 或 `?token=` 校验，常量时间比对。**没有"用户"概念** —— 任何拿到 token 的人都拥有全部权限。
- 既有的"作者 / 决策者"字段 (`doc_versions.decidedBy` `clarify_sessions.answeredBy` `review_comments.author`) 全部硬编码 `'local'`（`services/review.ts:1080,1113`、`services/clarify.ts:198`），schema 注释明确写"v1 always 'local'; reserved"。
- 任务只能由"启动者本人"在本机看；同事拿不到自己的 token 就完全看不到他人发起的任务，更别说参与评审 / 反问。
- 团队场景越来越多：一台 daemon 主机要跑多人发起的 task，admin 管理 agent 库和 workflow 模板，研发同事只负责"按模板启动 + 看自己的任务 + 在被指派的节点上评审/回反问"，这套现状完全跑不动。
- **企业部署**：越来越多团队希望让用户用公司 SSO（GitHub Enterprise / Google Workspace / Microsoft Entra ID / Okta / Keycloak / Auth0 / 自建 Keycloak）登录，不要再多管一套独立密码。

需要把"用户"提升为一等概念，把现有 token-only 鉴权扩展为**多用户 + 角色 + 权限目录 + OIDC 联合 + 个人访问令牌**，并把"谁是这个节点的评审人 / 反问被问人"沿着 task 落库到节点级别。

## 2. 目标

1. **用户身份（三轨鉴权）**：
   - daemon token（保留，bootstrap + CLI break-glass，仅映射到内置 `__system__` admin）；
   - 本地用户名密码（`users.password_hash` 可为 NULL，仅 OIDC 用户）；
   - **OIDC 单点登录**（admin 配任意 spec-compliant OIDC IdP，issuer URL + client_id + client_secret + scopes，走标准 Authorization Code + PKCE flow）；
   - **per-user PAT**（用户在 /account 自创 personal access token，name + expires_at + 可选 scope；hash 落 DB；revoke 按钮）。
2. **角色 + 权限目录（v1 = admin + user）**：每个角色对应一组权限（`agents:write` / `tasks:launch` / `users:write` / `oidc:configure` 等）。**框架按权限点判定**而不是直接 `role === 'admin'`，让 future 引入 `auditor` `viewer` `team_lead` 等角色时**只改 role→permission 映射**，不改业务代码。
3. **admin 能力**：创建 / 改名 / 改角色 / 停用 / 重置密码用户；CRUD OIDC providers（issuer 配置、客户端凭据、provisioning 策略）；查看任意用户的所有任务；编辑 agent / skill / mcp / plugin / workflow / 全局设置。
4. **regular user 能力**：登录自己的 session（密码 OR OIDC）；**只读**地浏览 agent / skill / mcp / plugin / workflow 列表；**启动** workflow 创建 task；**只能看到自己 owner 的或被加为 collaborator 的任务**；对**指派给自己**的节点做评审决策 / 回答反问；改自己的 display name / 密码 / 已绑定的 OIDC 身份；创建 / 撤销自己的 PAT。**绝对不能进入 `/settings` 页面 / 不能调 `/api/config`、`/api/oidc/*`、`/api/users`（list/detail/create/edit/delete）、`/api/backup` 等任何 admin 专属接口**；任何越权访问后端必须返 403（前端隐藏只是首层防护，后端 `requirePermission` middleware 是权威）。**例外**：`/api/users/search` 公开字段端点 + `/api/auth/*` 自服务端点 + `/api/runtime/opencode` 状态探针（首页运行时点用），regular user 可调。
5. **任务级协作**：每个 task 有 `owner_user_id`（启动者 / 或 system）+ 一组 `task_collaborators (user_id, role in {owner, reviewer, clarify_target, collaborator})`；可见性查询基于这张表。
6. **节点级指派**：在**启动 task 时**，针对工作流定义里的每个 `review` 节点指定一名 reviewer，每个 `clarify` 节点指定一名 clarify_target（被反问人）；默认值都是启动者本人。指派结果落库到 `node_assignments`，runtime 校验当前操作人是不是该节点的指派人。
7. **OIDC 通用对接（admin 自助配置）**：
   - admin 在 `/settings → Authentication` 增删 OIDC providers；每个 provider 字段：`displayName` / `issuerUrl` / `clientId` / `clientSecret`（hash 存盘） / `scopes`（默认 `openid profile email`） / `provisioning: 'auto'|'allowlist'|'invite'` / `allowedEmailDomains?: string[]` / `iconUrl?` / `enabled`；
   - 框架走标准 OIDC discovery（`/.well-known/openid-configuration` 缓存 1h）+ Authorization Code + PKCE + JWKS 验签 id_token + 校验 nonce/iss/aud/exp；
   - **redirect URI** 优先用 admin 在 settings 显式配的 `publicBaseUrl`，否则从请求 Origin + X-Forwarded-Host 推导，拼接到 `/api/auth/oidc/{providerSlug}/callback`；
   - 用户登出**只**调本地 logout（v1 不调 IdP end_session_endpoint，避免 IdP 不支持时的兼容性问题）；
   - 新 OAuth 用户默认 role=user，admin 后续手动提权（v1 不解析 IdP groups/roles claim）。
8. **账户联合（identity linking，手动）**：
   - users 表 1:N user_identities (user_id, provider, subject UNIQUE per provider, email, linked_at)；password_hash 仍在 users 列上；
   - 用户在 `/account` 看到 "Linked identities" 列表，能"Link <provider>"主动发起 OIDC bind flow，能"Unlink"摘除某条；
   - **不**按 email 自动联合（避免 IdP email 被劫持后自动接管已有账号；email_verified 仍可作为 audit 字段）；
   - invite-only IdP 例外：admin 用 email 预创建 users 行（status='invited'），用户首次 OIDC 登录时 framework 按 email_verified=true 的 email 精确匹配并自动建 identity（替代手动 link，让 invite 流程完整）。
9. **所有用户输入栏支持搜索**：launcher 的指派下拉 / collaborators 多选 / admin /users 页 / 任意需要选用户的位置，都走统一 `<UserPicker>` 组件 + `GET /api/users/search?q=` debounced async search（按 username / display_name / email 前缀匹配，limit 20，excludeIds 支持）。
10. **审计兜底**：`doc_versions.decidedBy` `clarify_sessions.answeredBy` `review_comments.author` 之前硬编码 `'local'` 的字段，统一改为存真实 `user_id`（向下兼容旧 `'local'` 行：渲染时显示为"system / 历史"）。

## 3. 非目标

- **不**做密码强度策略 / 失败次数封禁 / 二步验证 / 短信验证（v1 用 argon2id 哈希存盘 + 默认 session 7d 滚动续期 + 立即 revoke 即可；策略后续 RFC）。
- **不**做 SAML / LDAP / RADIUS（v1 只支持 OIDC + 本地密码；SAML 留 future RFC）。
- **不**做 SCIM 用户同步（admin 在 UI 手动管理；future RFC）。
- **不**做 IdP groups/roles claim → role 映射规则引擎（v1 所有新 OIDC 用户默认 role=user，admin 手动提权；future RFC 可加规则引擎）。
- **不**做 RP-initiated single sign-out（v1 仅本地 logout；future RFC 视 IdP 兼容性需求决定）。
- **不**做按 email 自动账户联合（避免 email 劫持攻击 → 用户主动 link/unlink）。
- **不**做 device code flow / OAuth 2.0 Token Exchange（CLI 走 daemon token 或 PAT，v1 不引入 device flow）。
- **不**做"多人同时评审 / 共识投票"—— v1 一个 review 节点只能指派**一名** reviewer；clarify 节点同理一名 clarify_target。Multi-reviewer 的多签 / quorum 场景留后续。
- **不**做 per-resource ACL（不允许"这个 agent 只能给 alice 用 / 那个 workflow 只能 bob 看"）。v1 用全局 read 权限：所有用户都能看所有 agent / skill / mcp / plugin / workflow 列表，**写权限**只 admin 有。Per-resource ACL 是 v2 话题。
- **不**改 daemon token 文件位置 / 生成时机 / 失效语义；token 文件依然是 `~/.agent-workflow/token`，依然 chmod 600，依然在 daemon 第一次启动随机生成。
- **不**改 opencode 子进程的 cwd / env / inline JSON 注入；本 RFC 是控制面（CRUD + auth + launch），不下沉到 runner / scheduler 业务逻辑。
- **不**强制现有部署"立刻必须创建 admin 用户才能继续用"。**升级 zero-touch**：装了新版本但没创建任何 user，框架按"single-user with daemon token"行为继续跑（与今天完全等价）。
- **不**重新设计 review / clarify 节点的产品形态（保持 RFC-005 / RFC-023 / RFC-026 语义不变；只是在它们上层加"谁可以提交"的访问检查）。
- **不**做"workflow 编辑权限粒度"（v1 = 所有 workflow 都只能 admin 编辑；future RFC 可以加 workflow owner 概念）。
- **不**做团队 / 组织 / 工作区抽象（v1 只有 flat users 列表）。
- **不**做 audit log / 事件流（用户行为只在已有 `node_run_events` + DB 字段里能看，不另立审计表；future RFC）。
- **不**加密 OIDC client_secret / PAT hash 之外的字段（v1 用 chmod 600 sqlite file + argon2id PAT hash + AES-256-GCM with key from `~/.agent-workflow/secret.key` 包裹 client_secret 即可；future RFC vault 集成）。

## 4. 用户故事

### US-1 — admin 初始化部署 + 加同事

> Alice 是这台 daemon 主机的 admin。她第一次升级到带 RFC-036 的版本，启动 daemon —— 行为与之前完全一样，token 仍然 work。她登录前端，看到右下角 settings → Users 菜单（新），点进去发现只有一个内置 `__system__` 用户。她按 "Create user" 按 username = `alice`、role = admin、临时密码 `xxxxx`，保存。退出当前 token 登录，用 `alice / xxxxx` 登录。在 Users 页继续添加 `bob`（role = user）+ `carol`（role = user），把临时密码贴给同事。

### US-2 — admin 接入企业 GitHub Enterprise OIDC

> Alice 想让全公司用 GitHub Enterprise 单点登录。她在 `/settings → Authentication` 点 "Add OIDC provider"，填 `displayName='GitHub Enterprise'` / `issuerUrl='https://github.corp.com'` / `clientId='Iv1.xxx'` / `clientSecret='yyy'` / `scopes='openid profile email read:user'` / `provisioning='allowlist'` / `allowedEmailDomains=['@corp.com']`，保存。框架立即拉一次 `/.well-known/openid-configuration` 验证 discovery 可达，OK 后启用。登录页 `/auth` 出现新按钮 "Login with GitHub Enterprise"。Bob 用 GHE 账号 `bob@corp.com` 点该按钮 → 跳 GHE → 授权 → 回调，框架按 allowlist 接受 email，自动创建 `bob`（role=user，identity 列表里有一行 `github-enterprise: <subject>`）。Carol 用个人邮箱 `carol@gmail.com` 试登录 → 框架拒绝："email domain not allowed; please contact admin"。

### US-3 — regular user 启动任务 + 节点级指派

> Bob 登录后看到侧栏：可见 Agents / Skills / MCPs / Plugins / Workflows / Tasks / Repos，但所有非 Tasks 类目都是**只读**（New / Edit 按钮 disabled，有 tooltip 解释"需要 admin 权限"）。他在 Workflows 列表选 `code-review-and-fix`（含 1 个 review 节点 + 1 个 clarify 节点 + 若干 agent 节点），点 Launch。launcher 表单除了既有的 repo / inputs，新加一段 "Per-node assignments"：
>
> - `review:final-doc` reviewer 默认是 `bob`，可下拉换；他打字 `car` 自动搜出 `carol`，选上。
> - `clarify:agent-Q` clarify_target 默认 `bob`，他保留自己（自己回答反问最快）。
> - Collaborators 区他还可以多选加 `alice`（让 admin 也能看）。
>
> 提交。任务被创建，owner = bob，reviewer = carol，clarify_target = bob。Bob 在 /tasks 列表可见这条；Carol 不在 collaborators 但是被指派为 reviewer，所以也可见（且任务进 awaiting_review 时她那边的 inbox badge 会鼓泡）。

### US-4 — 被指派的 reviewer 评审

> Carol 收到通知（Inbox drawer 红点 +1）。点进 /reviews 列表看到一条 task `xxx` 的 review 节点，进 detail 页，做出 reject 决策 + 写评论 + 提交。后端校验"当前用户 = 此节点指派的 reviewer 或者 task owner 或者 admin"——Carol 是 reviewer，通过。`doc_versions.decidedBy` 写入 `carol` 的 user_id。Bob 在自己的 Inbox 看到 review 已决策，agent 自动 iterate 重生。

### US-5 — 非指派人尝试越权

> Dave（user 角色，非该 task 的任何参与方）拿到了 task detail 页 URL 直接访问。`GET /api/tasks/:id` 返回 403 + `code: 'task-not-visible'`，前端弹"无权访问"卡片 + 返回任务列表按钮。即使 Dave 拿到了 review nodeRunId，`POST /api/reviews/:nodeRunId/decision` 也返 403 + `code: 'not-reviewer'`，UI 提示"不是该节点的指派人"。

### US-6 — 反问被问人回答

> Bob 启动的 task 跑到 clarify 节点，agent 反问"需要保留旧 API 兼容吗？"。clarify_target = Bob，他在 /clarify/$id 看到问题，选 "是"。`POST /api/clarify/:sessionId/answer` 通过（Bob 是 clarify_target），`clarify_sessions.answeredBy` 写 bob 的 user_id。

### US-7 — admin 看全 / regular user 看自己

> Alice 在 /tasks 看到 bob / carol / 自己启动的所有任务（scope filter 默认 "All"）。Bob 在 /tasks 默认 scope = "Mine"（owner = bob OR collaborator 包含 bob），看不到 alice 启动且没拉他进协作的任务。Carol 切到 "Shared with me" 能看到 Bob 拉她做 reviewer 的那条。
>
> 同样，inbox drawer 里 reviews / clarify 的待处理项只会列出"当前用户被指派的"。

### US-8 — admin 禁用 / 重置密码

> 同事 Dave 离职。Alice 在 /users 找 dave 行，点 "Disable"，dave 的现有 session + 所有 PAT + 所有 identity 立即失效（下次请求 401）；新建的 task 不能再指派给 dave（picker 隐藏 disabled 用户）；已存在的任务里 dave 留下的 collaborator/reviewer 行**保留**（历史记录），但渲染时灰显 + "已停用"标签。
>
> Carol 忘了密码。Alice 在 /users/carol 点 "Reset password"，输入新临时密码 + tick "force change at next login"。Carol 下次登录直接弹"请修改密码"对话框，改完才能进主界面。

### US-9 — 用户搜索

> 在任何"填用户"的位置（launcher 的 reviewer / clarify_target 单选 + collaborators 多选 + admin 创建用户后再让用户改自己 display_name 的搜索辅助 …），都是同一个 `<UserPicker>` 组件 —— 输入框 debounce 200ms → `GET /api/users/search?q=...&limit=20&excludeIds=...` → 列表显示 `display_name <username>` + role chip + disabled 灰显。键盘上下 + Enter 选中；选中后变 chip 显示。零硬编码下拉。

### US-10 — Bob 主动 link GitHub 账号

> Bob 已用密码登录，他想之后用 GitHub Enterprise 免密登录。他在 `/account → Linked identities` 看到 "GitHub Enterprise: Not linked" + "Link" 按钮，点 → 跳 OIDC flow → 回调，框架检测到当前 session 已登录，于是把这次回调的 `(provider='github-enterprise', subject='gh-bob-123')` 写到 `user_identities` 表，并跳回 /account 显示 "Linked"。下次 Bob 在登录页点 "Login with GitHub Enterprise" → 框架按 (provider, subject) 在 user_identities 表里找到 Bob，免密登录。

### US-11 — Bob 为 CI 脚本创建 PAT

> Bob 有个 CI 脚本想用自己的身份启动 task。他在 `/account → Personal Access Tokens` 点 "Generate"，填 name='ci-launcher'、expires='90 days'、scope='tasks:launch'，框架生成 `aws_pat_xxxxxxxxx...`（只显示一次，复制按钮），DB 只存 `sha256(token)` + 字段 metadata。Bob 把 PAT 配到 CI 环境变量。CI 跑 `curl -H 'Authorization: Bearer aws_pat_xxx' …` 启动 task，runner 走 PAT 鉴权识别 actor=bob，任务 owner=bob，与 Bob 亲手启动等价。任意时点 Bob 在 /account 列表点 "Revoke" 立刻失效。

### US-12 — admin 改 OIDC 配置 / 关闭某 IdP

> Alice 想把 `provisioning='auto'` 换成 `'invite'`，她在 `/settings → Authentication → GitHub Enterprise` 行点编辑，改字段，保存。框架立即按新策略走（已有用户不受影响）。她也可以临时 `enabled=false` 关掉该 provider 让登录页隐藏按钮。她不能删除还有 identity 绑定的 provider；要删先 "Force unlink all"（confirm）→ 所有用户的该 identity 行 deleted；用户密码仍可登录，无密码用户被 force lockout 直到 admin 重置密码或加新 identity。

## 5. 验收标准

### 5.1 数据模型

新增 7 张表 + 1 列 + 默认数据 `__system__` 用户：

1. **`users`**：`id ULID PK, username TEXT UNIQUE NOT NULL, email TEXT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NULL, role TEXT NOT NULL CHECK in ('admin','user'), status TEXT NOT NULL CHECK in ('active','disabled','invited'), force_password_change INTEGER NOT NULL DEFAULT 0, created_by TEXT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER NULL, schema_version INTEGER NOT NULL DEFAULT 1`
2. **`user_sessions`**：`id ULID PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT UNIQUE NOT NULL, user_agent TEXT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER NULL`
3. **`user_pats`**：`id ULID PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, scopes_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER NULL, expires_at INTEGER NULL, revoked_at INTEGER NULL`
4. **`oidc_providers`**：`id ULID PK, slug TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, issuer_url TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_enc TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT 'openid profile email', provisioning TEXT NOT NULL CHECK in ('auto','allowlist','invite'), allowed_email_domains_json TEXT NOT NULL DEFAULT '[]', icon_url TEXT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER, updated_at INTEGER`
5. **`user_identities`**：`id ULID PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider_id TEXT NOT NULL REFERENCES oidc_providers(id) ON DELETE RESTRICT, subject TEXT NOT NULL, email TEXT NULL, email_verified INTEGER NOT NULL DEFAULT 0, linked_at INTEGER NOT NULL, UNIQUE (provider_id, subject)`
6. **`task_collaborators`**：`task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, role TEXT NOT NULL CHECK in ('owner','reviewer','clarify_target','collaborator'), added_by TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (task_id, user_id, role)`
7. **`node_assignments`**：`task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, node_id TEXT NOT NULL, kind TEXT NOT NULL CHECK in ('reviewer','clarify_target'), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, assigned_by TEXT NOT NULL, assigned_at INTEGER NOT NULL, PRIMARY KEY (task_id, node_id, kind)`

新增列：

- **`tasks.owner_user_id`** TEXT NULL REFERENCES users(id) ON DELETE SET NULL（NULL = legacy / system-launched task）

种子数据：daemon 首次启动若 `users` 空，自动 seed `__system__` admin 行：`username='__system__', display_name='System', password_hash=NULL, role='admin', status='active', created_by=NULL`。**该行不可改 / 不可删 / 不可停用**，仅作为 daemon token 鉴权时的逻辑 actor。

### 5.2 鉴权三轨

`auth/session.ts` middleware 解析 `Authorization: Bearer <token>` + `?token=` query：

- 以 `aws_s_` 开头 → session token，用 `sha256(token)` 在 `user_sessions` 表查找，校验未 revoked / 未 expired，命中后 `last_used_at = now`，actor = users 行；
- 以 `aws_pat_` 开头 → PAT，同形查 `user_pats`，actor = users 行；
- 其它 → 走旧 daemon token 比较（`crypto.timingSafeEqual`），命中后 actor = `__system__` 用户（满 admin 权限）；
- 三种都失败 → 401。

中间件最终把 `Actor { user, source: 'session'|'pat'|'daemon' }` 写到 `c.set('actor', actor)`，下游用 `actorOf(c)` 取。

### 5.3 权限目录

`packages/shared/src/schemas/permission.ts` 导出 `PERMISSIONS` 字符串字面量联合 + `ROLE_PERMISSIONS: Record<Role, Permission[]>` 映射 + 纯函数 `hasPermission(role, perm)`。v1 列表（**admin 专属点显式隔离，不漏给 user**）：

- 资源读（admin + user）：`agents:read` `skills:read` `mcps:read` `plugins:read` `workflows:read` `repos:read` `runtime:read`
- 资源写（admin only）：`agents:write` `skills:write` `mcps:write` `plugins:write` `workflows:write` `repos:write`
- 用户管理（admin only）：`users:read` `users:write`
- 用户搜索（admin + user）：`users:search` —— `/api/users/search` 端点专用，只返公开字段 `{id, username, displayName, role, status}`，**绝不**含 email / lastLoginAt / linkedIdentities
- 全局设置（admin only）：`settings:read` `settings:write`
- OIDC 配置（admin only）：`oidc:read` `oidc:configure`
- 备份恢复（admin only）：`backup:run`
- task：`tasks:launch` `tasks:read:own` `tasks:read:all` `tasks:cancel:own` `tasks:cancel:all`
- 自服务（admin + user）：`account:self` （改自己 password / display_name / PAT / identity）
- 占位（v2 不用）：`admin:impersonate`

role 映射：

- `admin`：全部勾选（不含占位）；
- `user` = 资源读全集 + `tasks:launch` + `tasks:read:own` + `tasks:cancel:own` + `account:self` + `users:search`。**明确不含 `*:write` / `users:read` / `settings:*` / `oidc:*` / `backup:run`**；
- 内部 daemon-token actor（映射到 `__system__`）= admin 全集。

### 5.4 API 表面

#### auth / 用户自服务

- `POST /api/auth/login` body `{username, password}` → `{sessionToken, user, mustChangePassword}`；写 `user_sessions` 行；rate-limit 默认 5 req / 60s / IP（in-memory）；用户 status='disabled' / password_hash IS NULL 直接 401。
- `POST /api/auth/logout`（带当前 session token）→ `204`，session revoked。
- `POST /api/auth/change-password` → 改自己密码（旧密码校验 OR force_password_change=true 时跳过）；成功后 revoke 自己其它 session（保留当前）+ 所有 PAT 不动。
- `GET /api/auth/me` → 当前 actor `{user, permissions, source, linkedIdentities[], pats[]}`（替代 `/api/whoami` 旧返回 ok+pid，老返回向下兼容继续工作 200）。
- `POST /api/auth/sessions/:id/revoke` → revoke 当前用户的任意 session（用于 "Sign out all other devices"）。
- `POST /api/auth/pats` body `{name, scopes?, expiresAt?}` → `{token: 'aws_pat_xxx', metadata}`，token 仅本次返回；DB 存 hash。
- `DELETE /api/auth/pats/:id` → revoke 自己的 PAT。
- `GET /api/auth/identities` → 当前用户已绑定的 identity 列表。
- `POST /api/auth/identities/:providerSlug/link/start` → 返回 `{authorizeUrl}` 让 UI 跳转，state 写 in-memory map 含 `userId` 让回调知道是 link flow。
- `DELETE /api/auth/identities/:id` → unlink。

#### OIDC login flow

- `GET /api/auth/oidc/providers` → 公开（**未登录** UI 也要拉），返 `{providers: [{slug, displayName, iconUrl}]}` 仅 enabled。
- `POST /api/auth/oidc/:providerSlug/login/start` → 公开；返 `{authorizeUrl, stateToken}`，框架算 PKCE code_verifier、生成 nonce、写 in-memory state map（5min TTL）。
- `GET /api/auth/oidc/:providerSlug/callback?code&state` → 公开；交换 code → tokens → 校验 id_token → 按 (provider, subject) 在 user_identities 查 user；
  - 命中 + status='active' → 写 session，redirect 到 publicBaseUrl 或 `/`；
  - 未命中 + provisioning='auto' → 创建 users 行 (role=user) + identity → 写 session；
  - 未命中 + provisioning='allowlist' → 检查 email 域名匹配 allowedEmailDomains → 匹配则 auto-create；不匹配返 403 friendly page；
  - 未命中 + provisioning='invite' → 按 email_verified=true 找 status='invited' 的 users → 命中则 status='active' + 创建 identity + 写 session；未命中返 403 friendly page；
  - state 在 link flow（map 内含 userId）→ 仅创建 identity 绑到该 user，跳回 /account。
- 错误处理：discovery 失败 / id_token 验证失败 / state 过期 / nonce 不匹配 → 503 / 400 friendly page，不泄漏内部细节。

#### admin users / OIDC providers CRUD

- `GET /api/users?q&role&status&limit&cursor` → admin only；列表 + 简单分页。
- `GET /api/users/search?q&limit=20&excludeIds=` → `requirePermission('users:search')`（admin + user 都有该权限点）；只返公开字段 `{id, username, display_name, role, status}`，**不含** email / hash / last_login_at / linkedIdentities；与 `/api/users`（admin only `users:read` 端点）字段差异锁在 zod schema 与端点 handler 各一道，防止后续误把私有字段泄漏到公开端点。
- `POST /api/users` admin only，body `{username, displayName, email?, role, password?, sendInvite?: boolean}` → 201；password 可空（status='invited'）。
- `PATCH /api/users/:id` admin only，可改 `displayName, email, role, status, forcePasswordChange`；不能改自己 role 除非有第二个 admin（拒 422 `last-admin-protection`）。
- `POST /api/users/:id/reset-password` admin only，body `{newPassword, force}`；revoke 该 user 所有 session + 所有 PAT 不动（PAT 是用户自留 secret，admin 不应清掉）；可选 `revokePats: true` 选项。
- `DELETE /api/users/:id` admin only —— **不允许真删**（防 FK 雪崩 + 历史评论会变孤儿），转为 `PATCH status='disabled'`；返 200 + warning code `'user-deletion-soft'`。`__system__` 行不能改 / 不能停用 / 不能删。
- `GET /api/oidc/providers` admin only；返完整字段（含 client_id，但 client_secret 总返 redacted `"***"`）。
- `POST /api/oidc/providers` admin only，body 完整字段 → 201；保存前后端调用 `oidcDiscovery(issuerUrl)` 验证 metadata + JWKS 可用，失败返 422 + 错误详情。
- `PATCH /api/oidc/providers/:id` admin only；client_secret 字段：发空串 = 不改，发新值 = 覆盖。
- `DELETE /api/oidc/providers/:id` admin only；若仍有 user_identities 绑定返 409 `provider-still-linked`；可选 query `force=true` 强删（cascade 删 identities，影响的用户改为 disabled 防孤儿）。
- `POST /api/oidc/providers/:id/test` admin only → daemon 拉一次 discovery 不创建任何记录，仅返 `{ok, issuer, authorizationEndpoint, tokenEndpoint, jwksUri, scopesSupported}` 或 `{ok:false, error}`，让 admin 调通前先测。

#### 任务可见性 + 节点指派

`GET /api/tasks` 接受 `scope=mine|shared|all` 查询参；默认 `mine`（admin 默认 `all`）。

内部 SQL：

```sql
SELECT * FROM tasks
WHERE deletedAt IS NULL
  AND (owner_user_id = :actor OR EXISTS (
    SELECT 1 FROM task_collaborators WHERE task_id = tasks.id AND user_id = :actor
  ))
```

admin 走 `scope=all` 时跳过过滤；旧 NULL-owner 行视为 "system task"，admin 可见，regular user 看不见。

`GET /api/tasks/:id`、`/api/tasks/:id/node-runs`、所有 `/api/reviews/*` `/api/clarify/*` 子路径，都先跑同样的 visibility 检查，越权返 403 + `code: 'task-not-visible'`。

WS `/ws/tasks/:id` 同样在 upgrade 时做可见性 gate。

#### POST /api/tasks 扩展

body 加 `assignments: [{nodeId, kind: 'reviewer'|'clarify_target', userId}]` + `collaboratorUserIds: string[]`；都是可选，缺省时：

- `assignments[]`：每个 `review` 节点 reviewer 默认 = actor；每个 `clarify` 节点 clarify_target 默认 = actor；
- `collaboratorUserIds`：空数组；
- admin / launcher 自己自动写一行 task_collaborators role='owner'。

校验：assignments 里每个 `userId` 必须存在 + status='active'；`nodeId` 必须在 workflow 定义里存在且节点 kind 与 assignments.kind 兼容（review→reviewer 必填，clarify→clarify_target 必填，其它节点出现指派直接拒）；返 422 `invalid-assignment`。

`PATCH /api/tasks/:id/assignments/:nodeId` body `{kind, userId}` → 修改 (task owner | admin 可调)；revoke 旧指派 + 加新指派；幂等。

#### review / clarify 决策权校验

- `POST /api/reviews/:nodeRunId/decision` → 取出 `nodeRunId` 反查 `node_assignments(taskId, nodeId, kind='reviewer')` 的 user_id；当前 actor 必须 ∈ {assigned, task owner, admin}；否则 403 `not-reviewer`；通过后 `doc_versions.decidedBy = actor.id`。
- `POST /api/clarify/:sessionId/answer` 同形：必须 ∈ {assigned clarify_target, task owner, admin}；通过后 `clarify_sessions.answeredBy = actor.id`。

### 5.5 历史字段兼容

现有 `doc_versions.decidedBy='local'` `clarify_sessions.answeredBy='local'` `review_comments.author='local'` 行**保留原值**；前端渲染时判断 `=== 'local'` 显示为"system / 历史"chip。新写入一律真实 user id。

### 5.6 UI 组件

#### `<UserPicker>` 共享组件

- 单选 + 多选两种用法（props `multiple: boolean`）；
- debounce 200ms；首次 focus 即拉前 20 条默认列表（按 last_used_at desc）；
- 键盘 ↑↓ navigate + Enter 选中 + Esc close；
- 显示 `display_name • username` + role chip + disabled 灰显 + `(已停用)` 标签；
- 选中后单选变 chip / 多选追加 chip + 退格删除；
- 已 disable 的用户可保留在已选 chip 里（历史指派编辑场景）但搜索结果中过滤；
- 所有使用位置走同一个组件 + 同一个 `/api/users/search` 端点。

#### admin-only 路由 gate（统一约定）

`/users` `/users/$id` `/settings` 及其所有子页（`/settings/appearance` / `/settings/runtime` / `/settings/authentication` / `/settings/backup` / `/settings/network` / 等）= **admin only**。统一行为：

- **侧栏不渲染入口**：regular user 看不到设置齿轮（`<SettingsGearButton>`）、看不到 `<UserMenu>` 里的 "管理用户" 条目；
- **直访路由 → 友好拦截**：用户硬粘 URL 直访 → 路由组件先调 `usePermission('settings:read' | 'users:read')` 判定；为假则渲染 `<NoPermissionEmpty>`（图标 + "需要 admin 权限"标题 + Home 按钮 → navigate `/`），**不**做 404（保留 RFC-032 nav 一致性 + 让用户知道页面存在但无权进）；
- **后端权威**：UI 隐藏是**第一层防护**，**第二层**是后端 `requirePermission` middleware —— 任何 `/api/config` `/api/oidc/providers` `/api/users`（list/detail/create/edit/delete）`/api/backup` 调用，actor 缺权限直接 403 + `code: 'forbidden'` + 错误体含具体缺失权限点（让 admin 排错时一眼看清）；
- 适用页面清单：`/users` 列表 / `/users/$id` 详情 / `/settings` 入口（任 hash 子页都先过 gate）/ admin 段任何挂在 settings tabs 之内的新页（OIDC / Backup / Authentication 等）。

#### `/users` admin 页

- 列表（username / display_name / role chip / status chip / last_login_at 相对时间 / 操作下拉），按 username asc；
- "New" 按钮弹对话框 = `<Dialog>` 复用 RFC-035 共享组件；
- 行操作：编辑 / 重置密码 / 停用-启用 切换；
- admin 自己不能在自己行上 disable / 改 role（按钮 disabled + tooltip）；
- 路由 gate 走"admin-only 路由 gate"统一约定（见上）。

#### `/settings → Authentication` admin 段

- OIDC providers 列表 + Add / Edit / Delete / Test buttons；
- Add/Edit 弹 `<Dialog>` form：displayName / issuerUrl / clientId / clientSecret / scopes / provisioning radio (`auto`/`allowlist`/`invite`) / 条件可见 allowedEmailDomains（仅 allowlist 时）/ iconUrl / enabled toggle；
- 保存前底部"Test connection" 按钮调 `/test` 端点，测通才能 Save；
- 列表头 publicBaseUrl 显式配置块（empty=auto-derive 提示）。
- 整个 /settings 由 admin-only gate 兜底；regular user 直访 `/settings/*` → `<NoPermissionEmpty>`。

#### `/account` 用户自服务

- "Profile" 段：display_name / email 编辑；
- "Password" 段：change password 表单（旧 / 新 / 确认）；
- "Linked identities" 段：每个 enabled OIDC provider 一行，显示绑定状态 + "Link"/"Unlink" 按钮；
- "Personal Access Tokens" 段：列表（name / scopes / created_at / last_used_at / expires_at / revoke 按钮）+ "Generate" 按钮弹 `<Dialog>` 含 name / scopes 多选 / expires 下拉；生成后显示一次性 secret with copy 按钮；
- "Sessions" 段：active sessions 列表（user_agent / last_used_at / IP if captured）+ "Revoke" / "Revoke all others"。

#### 登录页 `/auth` 扩展

- 三个登录入口：
  1. 用户名 + 密码表单（v1 主入口）；
  2. 各 enabled OIDC provider 按钮（"Login with <displayName>"，按 displayName asc）；
  3. "Use daemon token" 折叠区（保留 legacy token 输入，admin 维护用）；
- 切换"以 admin 创建第一个用户"分支：未配 users 时显式提示。

#### 侧栏 / 首页 RFC-032 兼容

- sidebar footer：
  - LanguageSwitch 维持现状（所有登录用户可见 + 可切，写 localStorage；admin 同时 sync 到 `/api/config`，非 admin 仅本地）；
  - **新增 `<UserMenu>` dropdown**：显示 avatar + username，点开列表 = `["我的账户" → /account, "退出登录" → POST /api/auth/logout]`；**admin** 多两条 `["管理用户" → /users, "系统设置" → /settings]`；
  - **`<SettingsGearButton>` 仅 admin 渲染**（regular user 完全看不到齿轮 icon —— 没有 disabled 状态、没有 tooltip 替代，**直接不在 DOM**）；
  - regular user 想改主题 / 语言：sidebar footer LanguageSwitch + 主题 toggle（如启用）仍可点，本地生效；想改密码 / 看 PAT → 走 UserMenu → /account。
- homepage `<HomepageGreeting>` 问候语 i18n key 加 username（`Good morning, {{name}}`）；runtime 行不变（`/api/runtime/opencode` 走 `runtime:read`，admin + user 都有）。
- inbox drawer reviews / clarify list 隐式按 actor 过滤（后端 query 已经 scope）。

#### launcher 表单 "Per-node assignments" 段

- workflow 定义里抽出所有 `kind === 'review'` 和 `kind === 'clarify'` 的节点，按 node id asc 列出；
- 每行：节点 id + label（取 `node.title || node.id`）+ kind chip（review/clarify）+ `<UserPicker single>`，默认值 = 当前 actor；
- 段头有 "Reset all to me" 按钮一键清空回默认；
- 表单底部 collaborators 多选 picker 排在 "Submit" 上方；
- 校验失败的 row 行内显示 422 message。

### 5.7 i18n / CLI / CI

- **i18n**：zh-CN / en-US 文案对称；新页面 / 组件 / 错误提示 / 工具提示全部走 i18next，无硬编码字符串。
- **CLI**：保留现有 `agent-workflow start` zero-touch（不强制创建 admin）；新增 `agent-workflow user create --username --role --password` 让用户用 daemon token 走 HTTP（或本地 sqlite 直写）创建初始 admin；幂等：同名存在返 409。新增 `agent-workflow user reset-password --username --new-password` break-glass。
- **CI 三件套**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions e2e 通过。

### 5.8 测试

细规见 design §测试策略，下方仅高层：

- shared：permission catalog 静态 snapshot + `hasPermission` 矩阵；schema 边界；OIDC provisioning policy 决策树纯函数。
- backend：auth 三轨 middleware 单测（daemon token / session token / PAT / 全部失败 / 失效 session / 过期 PAT）；service 层 users CRUD 含禁止自降级 / 软删 / 重置密码 revoke session；OIDC discovery / token exchange / id_token verify mock；provisioning 三策略覆盖；task visibility SQL 闭包；review / clarify 决策权 403 case；launcher API 422 invalid-assignment。
- frontend：`<UserPicker>` debounce / 键盘 nav / disabled 隐藏 / 多选 chip；/users admin 行操作；launcher 段抽节点列表；登录页 + change-password 弹框；OIDC 按钮渲染按 enabled providers；/account 各段；nav 角色 gated render（user 角色看不到 New/Edit）。
- e2e：seed admin alice + user bob + user carol → bob 启动 task 指派 carol 评审 → carol 登录后能在 inbox 看到 + 提交决策 + decidedBy 持久化校验 → dave 直接访问该 task URL 拿 403 friendly screen；另一条 case：admin 配 mock OIDC provider → mock IdP callback → auto-provision user → 验证 session 写入 + identity 持久化。

## 6. 风险与回退

- **R1 — daemon token 双轨期歧义**：session token 用 `aws_s_` 前缀、PAT 用 `aws_pat_` 前缀显式区分；daemon token 64 hex chars 无前缀 → 永不冲突。
- **R2 — bootstrap 死锁**：装了新版本但忘了创建 admin → 用户找不到登录入口。**对策**：daemon 启动时若 users 表无 non-system 行 → log 一行 "首次多用户使用？运行 `agent-workflow user create --admin --username <name>`"；前端 /auth 页"Use daemon token" 折叠区保留 break-glass 路径。
- **R3 — admin 自己锁死**：admin Alice 在 UI 把自己 role 改成 user。**对策**：API 422 拒绝 self-role-change 除非有第二个 admin（`last-admin-protection`）；UI 同样 disabled；测试覆盖"最后一个 admin 不能停用 / 不能降级"。
- **R4 — session token 泄漏**：localStorage 失窃 = 别人冒充。**对策**：session 默认 7 天 expires + 滚动 renew（每次请求 last_used_at 更新）；user 在 /account 看 active sessions 列表 + 一键 revoke all；logout 立即 revoke。本 RFC 不引入 IP binding / device fingerprint（v2）。
- **R5 — 密码丢失**：admin 自己忘密码 + 没有其它 admin。**对策**：CLI `agent-workflow user reset-password --username` 直写 sqlite（要求本地访问 `~/.agent-workflow/db.sqlite`），等价 break-glass。
- **R6 — 现有部署升级**：一个团队部署的 daemon 升级到带 RFC-036 的版本。**对策**：migration 0018 只加表 / 加列，不动业务；users 表只含 `__system__` → 行为 100% 等价旧版（token 继续 work，所有人都是 admin）；只有 admin 主动创建第一个真实 user 后系统才"开关"为 multi-user 模式。
- **R7 — review/clarify 历史责任人字段 `'local'` 字符串**：与 ULID user_id 同列；查询和渲染要兼容。**对策**：DB 层不改字段类型 / 不做 backfill；renderer 层 `if (decidedBy === 'local') return '系统 / 历史'`；service 层新写入一律 user_id；测试锁守这层约定。
- **R8 — picker N+1**：launcher 表单可能列 10 个节点 × 拉 10 次 user search。**对策**：picker 内部 React Query key cache，同一 query 字符串只发一次；默认 list 也共享缓存；后端 search 走 LIKE + indexed username/display_name。
- **R9 — disabled 用户残留指派**：admin 停用 dave 后，已有 task 里 dave 仍是 reviewer。**对策**：review/clarify 提交校验时若 actor.status='disabled' 直接 401（session 已 revoke）；UI 显示 "已停用 reviewer" 提示 task owner 重新指派（通过 PATCH `/api/tasks/:id/assignments/:nodeId` 修改，admin / owner 可改）。
- **R10 — OIDC IdP downtime**：IdP 不可达 → 所有 OIDC 用户无法登录。**对策**：每个 user 仍可走密码登录（若 password_hash 非 NULL）；纯 OIDC 用户依赖 admin 手动 reset password。
- **R11 — OIDC client secret 泄漏**：DB 备份 / 同步可能泄漏 client_secret。**对策**：用 AES-256-GCM + `~/.agent-workflow/secret.key`（chmod 600，daemon 首启随机生成）加密 client_secret 写 DB 列 `client_secret_enc`；备份脚本明确警告 secret.key 不应外流。
- **R12 — provisioning='auto' + 公开 OIDC IdP 被滥用**：admin 误把 Google 配成 auto 全开 → 任何 Google 账号能登。**对策**：UI 默认值 = `invite`；选 `auto` 时弹 confirm dialog 说明风险；文档明确 admin 责任。
- **R13 — id_token replay**：单 nonce 复用攻击。**对策**：state map 进程内 in-memory + 5min TTL + 一次性消费（取走即删）；nonce 嵌进 state 一并校验。
- **R14 — redirect_uri 伪造**：恶意 X-Forwarded-Host 伪造重定向。**对策**：publicBaseUrl 优先；推导路径下校验 Host header 必须 ∈ admin 维护的可信 hosts 白名单（settings.json 新增 `trustedHosts: string[]`，empty=接受任意，admin 可锁定）；OIDC 注册时也要把 redirect_uri 加进 IdP 端 allowlist 防御深度。
- **回退路径**：若发现 dual-track auth 引入误判，临时开关 `settings.json` 增 `multiUserEnabled: false` —— 关掉后整个 multi-user 子系统短路，鉴权回到 P-1-02 行为；前端按 feature flag 隐藏 /users + login 表单。v1 默认 `auto`：detect users 表 non-system 行非空时打开。

## 7. 备选方案（已否决）

- **A. 完全用 daemon token + 在 token 文件里多行 `user:token` 列表**：保留无数据库。否决：没法做角色 / 节点指派 / collaborator / 重置密码 / 失效；同事改 token 文件能直接提权；与本 RFC 的核心目标对不上。
- **B. 抛弃 daemon token，强制必须先创建 admin**：升级即破坏 zero-touch。否决：违反"upgrade is a no-op"承诺；现有 CI / 脚本拿 token 直跑会全挂。
- **C. 只内置 GitHub / Google / Microsoft 按钮**：硬编码 3 provider。否决：用户答复明确选通用 OIDC；锁死供应商；企业自建 Keycloak/Auth0/Okta 反而被排除。
- **D. SAML / LDAP / RADIUS**：传统企业身份协议。否决：v1 90% 用户是 SaaS IdP（OIDC 原生支持）；SAML 库重 + XML 解析坑深；留 future RFC 单独做。
- **E. 按 email 自动账户联合（auto-link）**：IdP email 匹配 users.email 就自动绑。否决：email 劫持 → 别人 OIDC 登录可接管已有账号；v1 走手动 link 更安全；invite-only IdP 例外（admin 显式预创建 = 信任 admin 输入的 email）。
- **F. RBAC 用 Casbin / similar engine**：通用规则引擎。否决：v1 权限模型小到 20 个点，纯字面量映射 + map lookup 完全够用；引入引擎反而把简单事件搞成复杂依赖。
- **G. IdP groups claim → role 自动映射**：v1 直接做规则引擎。否决：claim path 多变（OIDC spec 不强制 groups 字段格式）；规则 DSL 设计成本高；admin 手动提权对小团队足够；future RFC 单独做。
- **H. 拆"组织 / 团队 / 工作区"**：层次化命名空间。否决：v1 没人提这个需求；过早抽象会污染所有 schema；future RFC 在 users 表外加 `teams` + `team_members` 即可。
- **I. per-resource ACL**：每个 agent / workflow / repo 都有 owner + 共享列表。否决：实现复杂度 4×，与 v1 用户故事不匹配（user 故事是"所有人共享 agent 库，启动任务后才出现私有/共享"）。
- **J. clarify_target / reviewer 改成多选**：多人评审 / 多人会答。否决：违反 RFC-005 / RFC-023 的现有 "single decision" 假设。
- **K. 用户搜索改全文索引（FTS5）**：v1 用户量 100 量级。否决：LIKE prefix 足够。
- **L. 引入 device code flow 给 CLI**：headless 标准 OAuth flow。否决：v1 用 PAT 已经满足"个人脚本身份"；device code 增加用户教育成本；future RFC 视需求加。
- **M. RP-initiated single logout 调 IdP end_session_endpoint**：v1 即支持。否决：IdP 兼容性参差（GitHub 不支持，Google 不在 discovery 公示，Okta 行为各异）；v1 做本地 logout 已足够，future RFC 视需求扩。

## 8. 待办

- 等待用户批准本 proposal。
- 进入 design.md 决定具体字段长度 / 密码哈希参数 / session token 长度 / PAT scopes 枚举 / OIDC discovery 缓存策略 / state map TTL / picker 接口契约。
- 进入 plan.md 拆 PR1..PR5（schema+三轨 auth / RBAC enforce / OIDC + identity / 节点指派 + 协作 / UI）。
