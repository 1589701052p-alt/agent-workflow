# Codex 核验：资源 ACL / 认证 (10-resource-acl-auth)

> 对应报告：`design/arch-audit-2026-06-23/10-resource-acl-auth.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **ACL-07 属实，P1 合理**：`postLoginRedirect` 从 body 直接进入 flow，callback 拼成 `Location: <postLoginRedirect>#aw_session=...`，无同源/相对路径校验；外部 URL 可拿到 fragment token。证据：`packages/backend/src/routes/oidc-auth.ts:35-42`, `packages/backend/src/routes/oidc-auth.ts:181-184`。
- **ACL-08-bug 属实，但更像 P2/P1 之间**：`linkUserId` 只有类型、flow 与 callback 分支，没有任何 start 路由传入；前端 account 只展示 linked identities，无绑定入口。证据：`packages/backend/src/auth/oidc/flow.ts:14-17`, `packages/backend/src/routes/oidc-auth.ts:111-123`, `packages/backend/src/routes/oidc-auth.ts:39-42`, `packages/backend/src/routes/auth.ts:189-197`。
- **ACL-09 属实，P1/P2 取决于部署暴露面**：`/api/auth/login` 是 public path，登录只查用户并 `verifyPassword`，无失败计数、退避、锁定或告警。证据：`packages/backend/src/auth/session.ts:35-42`, `packages/backend/src/routes/auth.ts:32-48`。
- **ACL-01 属实，P2 合理**：RFC 要 `visibleIdsFilter` SQL 谓词，实际五资源列表先查全表再 `filterVisibleRows` 内存过滤。证据：`design/RFC-099-ownership-acl/design.md:76-79`, `design/RFC-099-ownership-acl/design.md:91-99`, `packages/backend/src/services/resourceAcl.ts:85-99`, `packages/backend/src/routes/agents.ts:45-50`。
- **ACL-02 / CHOKE-1 属实，P2 合理**：资源类型散在 `ACL_TABLES`、permission 字面量、route gate、ACL endpoint param 等处。证据：`packages/backend/src/services/resourceAcl.ts:51-58`, `packages/shared/src/schemas/permission.ts:8-23`, `packages/backend/src/auth/permissions.ts:63-65`, `packages/backend/src/routes/resourceAcl.ts:22-29`。
- **ACL-03 / ACL-12 属实，P3 更合适**：task 成员制与 resource grants 重复 owner transfer、active user 校验，且 `taskCollab` 反向 import `resourceAcl`。证据：`packages/backend/src/services/taskCollab.ts:17`, `packages/backend/src/services/taskCollab.ts:130-176`, `packages/backend/src/services/resourceAcl.ts:239-290`。
- **ACL-05 属实，P2 合理但报告还不够具体**：repos 不在五资源 ACL；`repos:read` 在 user baseline，`/api/repos/*` 只走粗权限；任务启动只校验 workflow。证据：`packages/shared/src/schemas/permission.ts:61-75`, `packages/backend/src/server.ts:114-117`, `packages/backend/src/routes/repos.ts:12-33`, `packages/backend/src/routes/tasks.ts:237-249`。
- **ACL-10 / ACL-11 属实，P3 合理**：写路由已 `loadVisibleAgent` 后又 `requireResourceOwner`，后者再 view check；session sweep 有 `and(X,X)` 且注释说 revoked 但谓词没有 revoked。证据：`packages/backend/src/routes/agents.ts:88-90`, `packages/backend/src/services/resourceAcl.ts:151-158`, `packages/backend/src/auth/sessionStore.ts:134-142`。
- **CHOKE-2 / ACL-14 属实**：permission catalog 注释说业务不按 role string，但 ACL/memory/taskCollab 多处 `isAdminActor(role==='admin')`；task 又用 `tasks:read:all`。证据：`packages/shared/src/schemas/permission.ts:1-4`, `packages/backend/src/services/resourceAcl.ts:60-61`, `packages/backend/src/services/taskCollab.ts:35`, `packages/backend/src/services/memory.ts:734-765`。
- **CHOKE-3 / CHOKE-4 / ACL-15 / ACL-16 基本属实**：memory scope 只手写 agent/workflow；prompt 隔离有输出测试+源码文本断言但非类型隔离；OIDC redirect/link/rate-limit 无对应测试；ACL 拒绝与 ACL 变更无结构化 audit。证据：`packages/backend/src/services/memory.ts:728-802`, `packages/backend/tests/rfc099-prompt-isolation.test.ts:195-220`, `packages/backend/tests/auth-routes.test.ts:69-83`, `packages/backend/src/services/resourceAcl.ts:130-159`, `packages/backend/src/services/resourceAcl.ts:239-315`。

## REFUTED / 伪问题（给反证 file:line）

- **ACL-06 部分夸大**：`AppDeps.secretBox?` 与 routes 静默 skip 确实存在，但普通 daemon 启动路径总是 `createSecretBox` 并传入 `createApp`，不是典型运维“忘挂就消失”。更准确说是测试/自定义嵌入路径的可观测性问题。反证：`packages/backend/src/cli/start.ts:187-201`；可选分支证据：`packages/backend/src/routes/oidc.ts:10-15`, `packages/backend/src/routes/oidc-auth.ts:21-30`。
- **CHOKE-5 不应列为漏洞**：启动只校验 workflow、runner 不复查 ACL 是 RFC-099 明确接受的失败模式；它是审计/合规能力缺口，不是实现偏离。反证：`design/RFC-099-ownership-acl/design.md:102-115`, `design/RFC-099-ownership-acl/design.md:206-208`。
- **CHOKE-4 严重级偏高**：报告说“只靠源码文本断言”不完整；现有还有运行时输出断言。仍建议类型化投影，但更像 P3 架构硬化。反证：`packages/backend/tests/rfc099-prompt-isolation.test.ts:28-50`, `packages/backend/tests/rfc099-prompt-isolation.test.ts:124-147`, `packages/backend/tests/rfc099-prompt-isolation.test.ts:195-220`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **cached repo 原始 URL 含凭据却全量返回 — High — `packages/backend/src/services/gitRepoCache.ts:181-186`, `packages/backend/src/services/gitRepoCache.ts:547-558`, `packages/shared/src/schemas/cachedRepo.ts:5-10`, `packages/backend/src/routes/cached-repos.ts:25-29` — 所有有 `repos:read` 的普通用户可通过 API 读到 `url` 原文；注释已承认 may contain credentials，前端只显示 `urlRedacted` 不能弥补 API 泄漏。**
- **登录“constant-time”注释不成立，可枚举账号/状态 — Medium — `packages/backend/src/routes/auth.ts:38-45`, `packages/backend/src/auth/passwords.ts:21-24`, `packages/backend/tests/auth-routes.test.ts:69-83` — 未知用户/禁用/无密码直接 401，错误密码才跑 Argon2 verify；和无速率限制叠加，可通过耗时区分有效本地密码账号。**
- **OIDC public prefix 过宽，会绊倒报告建议的 link/start — Medium — `packages/backend/src/auth/session.ts:35-49` — `/api/auth/oidc/` 整段绕过 multiAuth；若按报告补 `POST /api/auth/oidc/:slug/link/start` 且需要当前 actor，不能直接挂在该前缀下依赖全局 auth，必须手动鉴权或收窄 public matcher。**
- **OIDC redirect_uri 信任 Forwarded Host/Proto — Low/Medium — `packages/backend/src/routes/oidc-auth.ts:196-211` — 未配置 `publicBaseUrl` 时客户端可影响 callback origin；多数 IdP 会因 redirect_uri 不匹配而失败，但反向代理部署下应只信任受控配置或可信 proxy。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的“资源描述符”方向是对的，但不要一次性生成所有 route 行为；更稳的是先做只读的 `visibleWhere(type, actor)` 与 `loadVisibleResource(descriptor, key)` 两个底层 helper，保留现有 route 显式业务逻辑，逐步消除五处重复。这样不碰任务状态机 CAS，也不碰 opencode env 合并路径。

“role-string 旁路改权限点”方向也对，但必须保留 RFC-099 当前不变量：PAT scope 收窄只影响 route permission，不应悄悄改变 admin 的行可见性，除非明确修改安全模型。更优解是新增独立 row-level capability，如 `resources:read:all`，并在 `buildActor` 中显式决定 PAT 是否可收窄它，而不是简单把所有 `isAdminActor` 替换为 `actor.permissions.has(...)`。

“通用 grant 原语 + principalType”可以做，但别把 task collaborators 和 resource grants 过早合表。任务成员有 role、启动快照、操作权语义；资源 ACL 是 visibility+grant。建议先抽共享校验/owner-transfer helper，等 group/team 真实出现再迁移 schema。

认证优先级应高于架构重构：先修 OIDC redirect 白名单、登录节流、登录 timing dummy hash、cached repo API 去掉原始 `url` 或改 admin-only，再补 link/start。link/start 若放在 `/api/auth/oidc/*` 下，必须同步修 public path matcher。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：核心高风险判断基本成立，但少数设计项把“明确接受的不变量”说成问题，且漏掉了 cached repo 原始凭据 URL 与登录 timing side-channel 两个更直接的安全面。
