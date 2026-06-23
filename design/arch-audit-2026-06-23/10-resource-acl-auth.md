# 资源 ACL / 认证 / 授权 — 架构审计 (2026-06-23)

> 子系统 key=`10-resource-acl-auth`。范围：五资源 owner+visibility+grants 模型、引用闭包隐式授权、prompt 隔离不变量、OIDC/session/PAT/secretBox、权限/角色扩展性。
> 只读审计；所有 file:line 相对仓库根。与既有 `design/dedup-audit-2026-06-13.md` / `design/scheduler-audit-2026-06-10.md` 重叠处已标注。

## 0. 健康度一句话

**核心 ACL 判定确实是单一事实源（`services/resourceAcl.ts` 一处纯谓词），prompt 隔离有双层（运行时 + 源码文本）测试锁定，是本仓做得最干净的子系统之一**；但它建立在「五资源硬编码枚举 + 每路由各写一遍 load/gate 包装 + JS 全表后过滤」之上，加第 6 类资源 / 第 3 个角色 / 上规模会同时撞上扩展性与性能天花板，且认证侧存在 OIDic 开放重定向、登录无限暴力破解、link-identity 死代码三处实打实的洞。

## 1. 当前架构与职责

ACL 判定逻辑全部下沉在 `services/resourceAcl.ts`（319 行）：`isVisibleRow` / `canViewResource` / `isResourceOwner` 三个纯谓词 + `filterVisibleRows`（列表后过滤）+ `requireResourceView`（→404）/ `requireResourceOwner`（→403）两个 route gate + `getResourceAcl`/`updateResourceAcl`（ACL 管理端点逻辑）。认证是三轨中间件 `auth/session.ts multiAuth`（session token / PAT / daemon token → `Actor`），`Actor` 携带「已解析的权限集」（role 基线 ∩ PAT scopes，`auth/actor.ts:28`）。角色→权限映射在 `shared/src/schemas/permission.ts` 单点。OIDC 登录是 `auth/oidc/*`（discovery/flow/tokens）+ `routes/oidc-auth.ts`（公开流程）+ `routes/oidc.ts`（admin CRUD）+ `services/oidcProviders.ts`（client_secret AES-256-GCM 封存）。任务有**独立**的成员制授权（`services/taskCollab.ts`，不走 visibility，D20）。

关键文件：`services/resourceAcl.ts`、`services/resourceRefs.ts`、`services/taskCollab.ts`、`auth/{actor,session,sessionStore,patStore,permissions,token,secretBox,passwords}.ts`、`auth/oidc/{discovery,flow,tokens}.ts`、`routes/{resourceAcl,auth,oidc,oidc-auth,users}.ts`、`services/{users,userIdentities,oidcProviders}.ts`、`services/oidc/provisioning.ts`、`shared/src/schemas/permission.ts`、`services/systemResources.ts`（built-in 行判别）。

## 2. 设计问题（Design）

**[ACL-01] 列表可见性用 JS 全表后过滤，背离 design.md 钦定的 SQL 谓词** — 级别 P2｜类型 design/perf｜
证据：`design/RFC-099-ownership-acl/design.md:78` 明确写 `visibleIdsFilter(db, actor, type)` 为「列表 SQL 谓词：`visibility='public' OR owner=me OR id IN (grants)`」，§3 表格也写「GET /api/{res} 接 `visibleIdsFilter`」。实际实现是 `services/resourceAcl.ts:91 filterVisibleRows`，先 `listAgents`/`listSkills` 拉**全表**再 JS 过滤；`grep -rn visibleIdsFilter` 全仓零命中——该谓词从未落地。代码注释自辩「list endpoints load full tables — system scale is small」（`resourceAcl.ts:88-89`）。｜影响：每次列表请求把全部资源行读进内存（agents/skills/mcps/plugins/workflows 五表），随租户增长线性恶化；且与 RFC-101 已做的「列表窄投影下推 SQL」（commit 1b8c6ea）方向相反，是同一坐标系内的设计回退。窄投影下推后仍被 ACL 强制全量 materialize，下推收益被 ACL 抵消。｜建议：把 `visibleIdsFilter` 真正实现为 Drizzle `where`（`or(eq(visibility,'public'), eq(ownerUserId,me), inArray(id, grantSubquery))`），让 ACL 与窄投影下推在同一 SQL 里收敛；admin 短路保留。

**[ACL-02] 资源类型是五处硬编码枚举，没有「资源种类」注册表** — 级别 P2｜类型 design/extensibility｜
证据：`AclResourceType` 联合类型 + `ACL_TABLES`（`resourceAcl.ts:52-58` 五个 key）+ `resourcePermissionGate` 的 `resource` 参数联合（`auth/permissions.ts:63-65`，含 `repos` 但 repos 不在 ACL 模型里，见 ACL-05）+ `PERMISSIONS` 里五对 `:read`/`:write` 字面量（`permission.ts:8-23`）+ `mountAclEndpoints` 的 `param: 'name'|'id'`（`routes/resourceAcl.ts:25`，agents/skills/mcps 用 name、plugins/workflows 用 id）。｜影响：见 §4 ACL-08。这是结构性的——没有「resource descriptor」抽象把 table/loader/param/permission-pair 绑成一个对象。｜建议：见 §7 目标形态。

**[ACL-03] 任务授权与资源 ACL 是两套平行模型，共享谓词但不共享框架** — 级别 P2｜类型 design/coupling｜
证据：资源走 owner+visibility+`resource_grants`（`resourceAcl.ts`）；任务走 owner+`task_collaborators`（成员制，**无 visibility**，D20，`taskCollab.ts:30 canViewTask`）。两者各有一份 `getX/updateXMembers`（`taskCollab.ts:94/130` vs `resourceAcl.ts:199/239`），owner-transfer 时「旧 owner 自动留为可见」的规则在两处**逐字重复**（`taskCollab.ts:168-176` vs `resourceAcl.ts:281-290`），「校验引用用户均 active 且非 system」也重复（`taskCollab.ts:142-156` vs `resourceAcl.ts:248-263`）。`resolveTaskRole`（`resourceAcl.ts:168`）被 taskCollab 反向 import，暴露了分层的别扭。｜影响：membership 模型若要扩展（例如任务也加 visibility，或资源也要「成员角色」）必须改两份；owner-transfer 这类微妙规则漂移风险高。｜建议：抽出 `grantTable<Owner, Members>` 通用授权原语，资源 grants 与 task collaborators 都是它的实例（区别仅在「是否有 visibility 列」与「成员是否带 role」）。

**[ACL-04] visibility 仅二元 public/private，无团队/组织层** — 级别 P3｜类型 design/extensibility｜
证据：`ResourceVisibility = 'public'|'private'`（`resourceAcl.ts` 全程 `(row.visibility ?? 'public')`）；授权粒度只有「单用户 grant 行」。｜影响：要做「团队可见」「按部门」必须给每个团队成员逐人发 grant 行，N×M 膨胀；半年后多团队场景会逼出第三种 visibility 或 group 表。｜建议：v1 接受，但把 grant 主体类型预留为 `(principalType, principalId)` 而非裸 userId，给未来 group 留缝（见 §7）。

**[ACL-05] repos 在 ACL 模型之外，但和五资源一样进任务闭包** — 级别 P2｜类型 design/security｜
证据：`ACL_TABLES`（`resourceAcl.ts:52`）不含 repos；repos 表无 `ownerUserId`/`visibility`（`grep ownerUserId routes/repos.ts services/repo.ts` 零命中）；`resourcePermissionGate('repos')` 把 repos 写定为 admin-only（`permission.ts:75-76` 注释「repos:write stays admin-only」，user 基线只有 `repos:read`，`permission.ts:67`）。｜影响：(1) 所有 user 能读所有 repo（含 repo URL / 路径 / 凭据线索），没有隔离；(2) 任务启动只校验 workflow 可见（D3，`routes/tasks.ts:243`），repo 完全不在可见性闭包里——一个 user 启动任务时引用任意 repo 没有任何 ACL 闸门。这与五资源的隔离承诺不对称且无文档解释为什么 repo 可以全局可读。｜建议：要么把 repos 纳入 ACL 模型（第 6 类，正好检验 ACL-08 扩展性），要么在 design.md 显式记一条「repos 有意全局可读」的决策，否则这是默默的越权读面。

**[ACL-06] OIDC 整体可选（`secretBox?`），无 secretBox 时静默禁用而非显式降级** — 级别 P3｜类型 design/observability｜
证据：`AppDeps.secretBox?: SecretBox`（`server.ts:57`）；`routes/oidc.ts:11-15` 在 `!deps.secretBox` 时**静默 return**（admin 完全看不到 OIDC 配置页存在）；`oidc-auth.ts:23` 在无 box 时返回空 provider 列表。｜影响：运维若忘了挂 secretBox，OIDC 不是报错而是「整块消失」，排障困难。｜建议：把 secretBox 设为 daemon 启动必备（first-run 自动建 key，`secretBox.ts:22` 已支持），删掉 optional 分支；OIDC 表为空就是没配，而不是「能力不存在」。

## 3. 实现问题 / Bug（Impl）

**[ACL-07] OIDC `postLoginRedirect` 原样进 `c.redirect()`，开放重定向 + token 经 fragment 外泄** — 级别 P1｜类型 security｜
证据：`routes/oidc-auth.ts:36-37` 从请求 body 取 `postLoginRedirect`（无校验），存进 flow（`flow.ts:53`），callback 在 `oidc-auth.ts:184` 执行 `c.redirect(\`${flow.postLoginRedirect ?? '/'}#aw_session=${encodeURIComponent(token)}\`)`。｜影响：构造 `postLoginRedirect=https://evil.example/x` 即可让 IdP 回跳后把**带会话 token 的 fragment** 重定向到外站；fragment 不发服务器但目标页 JS 可读 `location.hash`，等于会话劫持。link 分支同理（`:123`）。这是登录态可被钓走的真实漏洞。｜建议：`postLoginRedirect` 必须做同源/路径白名单校验（只允许以 `/` 开头且非 `//` 的本地路径），拒绝绝对 URL。

**[ACL-08-bug] OIDC「link 追加身份」流程是死代码——无路由设置 `linkUserId`** — 级别 P1｜类型 impl-bug｜
证据：`flow.ts:15/52` 定义并透传 `linkUserId`；callback `oidc-auth.ts:111-124` 完整实现了 link 分支（`createIdentity` + 回跳 `/account?linked=`）；但 `grep -rn linkUserId packages/backend/src` 显示**唯一的 startFlow 调用点 `oidc-auth.ts:39` 不传 `linkUserId`**，且没有任何 `/login/start` 之外的「link/start」端点。`routes/auth.ts:189` 的 `DELETE /api/auth/identities/:id`（解绑）存在，但「绑定第二个 IdP」的入口缺失。｜影响：注释/RFC 声称的「`/account → Linked identities` 手动 link」（`userIdentities.ts:2`）后端不可用；用户无法把第二个 OIDC 身份绑到现有账号，整条 link 路径不可达。｜建议：补 `POST /api/auth/oidc/:slug/link/start`（需 `account:self`，把 `actor.user.id` 写进 `linkUserId`），或删除死分支并改 RFC。

**[ACL-09] 登录无速率限制 / 无暴力破解防护** — 级别 P1｜类型 security｜
证据：`routes/auth.ts:32 POST /api/auth/login` 直接 `verifyPassword` 比对，无失败计数 / 锁定 / 退避；`grep -rni "rate.?limit|lockout|attempt"` 全后端零命中（仅命中无关的 commitPush/rollback「attempt」）。`isPublicAuthPath`（`session.ts:35`）让 `/api/auth/login` 绕过 multiAuth，任何人可无限尝试。｜影响：argon2id（`passwords.ts`）每次校验 ~50-100ms，离线很慢但在线穷举弱口令仍可行；无监控、无告警。多用户部署下这是标准合规缺口。｜建议：加 per-username + per-IP 失败计数（内存 sliding window 即可，单进程）+ 指数退避；同 OIDC state 一样可用现成的 in-memory map 模式（`flow.ts`）。

**[ACL-10] `requireResourceOwner` 内部重复跑一遍 `canViewResource`，路由层已先查，双查** — 级别 P3｜类型 perf/coupling｜
证据：写路由模式是 `loadVisibleAgent`（内部 `canViewResource`，`agents.ts:37-43`）→ 紧接 `requireResourceOwner`（`agents.ts:90），而 `requireResourceOwner` 又调 `requireResourceView`→`canViewResource`（`resourceAcl.ts:157`）。granted 子查询因此每写跑两次。｜影响：纯多余 DB round-trip（非正确性）；但 owner 短路在 `canViewResource` 是第三个判断（`resourceAcl.ts:109-111`），常见 owner 写路径不触 grants 查询，影响有限。｜建议：`requireResourceOwner` 接受「已知可见」标志，或路由直接调 `isResourceOwner`（纯函数）跳过二次 view。

**[ACL-11] session sweep 的 where 子句把同一条件写两遍（无害但是 bug 气味）** — 级别 P3｜类型 impl-bug｜
证据：`sessionStore.ts:139-141`：`.where(and(lt(userSessions.expiresAt, now), lt(userSessions.expiresAt, now)))`——`and(X, X)`。注释（`:138`）说「hard-delete fully-expired rows that were already revoked」，但谓词里**完全没有 revoked 条件**，实际删的是所有过期 session（含未 revoke 的），与注释不符。｜影响：行为上「删所有过期」其实是对的（过期即无用），但注释撒谎 + 重复谓词说明这段没人 review 透；若哪天有人按注释加 revoked 过滤会改错。｜建议：删掉重复 `lt`，修正注释为「删所有过期 session」。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[CHOKE-1] 加第 6 类 ACL 资源（如 repos / prompt-template / dataset）要碰 ≥8 处硬编码** — 触发场景：把 repos 纳入 ACL（ACL-05），或新增「数据集」资源。
根因：没有「资源描述符」单点，资源种类的事实散在五处枚举（ACL-02）。
现在要碰：(1) `shared/permission.ts` 加 `:read`/`:write` 字面量 + 塞进 `USER_BASELINE`；(2) `resourceAcl.ts:52 ACL_TABLES` 加表；(3) `AclResourceType` 联合（shared）；(4) `auth/permissions.ts:63 resourcePermissionGate` 的 resource 联合；(5) `server.ts` 加两行 `app.use` gate；(6) 该资源 route 文件逐手抄 `loadVisibleX`/`filterVisibleRows`/`requireResourceOwner`/`assertNewRefsUsable`/`mountAclEndpoints`（参照 `agents.ts` 约 10 个调用点）；(7) `services/X.ts` create 加 `ownerUserId` 入参（参照 `agent.ts:30/92`）；(8) 若该资源被引用，`resourceRefs.ts` 加 `extractXRefs`；(9) 若有 memory scope，`memory.ts` 的 `filterMemoriesByScopeVisibility`（`memory.ts:757-797`）再 special-case 一个 scope 分支。
目标形态：单一 `RESOURCE_DESCRIPTORS: Record<AclResourceType, { table, keyParam, load, refExtractor? }>`，gate/列表过滤/详情 404/ACL 端点全部由描述符驱动的泛型 helper 生成；新增资源 = 加一条描述符 + 一对 permission 字面量。

**[CHOKE-2] 加第 3 个角色（auditor / viewer / team_lead）会撞上「权限点 vs 行级 owner」的双轨混乱** — 触发场景：产品要「只读审计员」或「团队负责人」。
根因：现在只有 admin（`role==='admin'` 在 `resourceAcl.ts:60` / `taskCollab.ts` / `permissions.ts:32 requireAdmin` 多处硬比）全量短路 + user 基线一份。`permission.ts:4` 注释吹「加角色只加 ROLE_PERMISSIONS 一个 key」，但实际 `isAdminActor`（按 `role==='admin'` 而非权限集）被 ACL/memory/taskCollab 当「看见一切 / 管理一切」的旁路用了十几处（`rg "role === 'admin'|isAdminActor"`）。第三个角色若需要「能审计看全部但不能改」，`isAdminActor` 的 all-bypass 语义会把它要么误当 admin 要么完全没特权。
现在要碰：所有 `isAdminActor` 调用点（ACL 可见性、memory 管理、task 可见、requireAdmin gate）都要重新判断该角色落哪一侧；`tasks:read:all` 这类「跨用户读」权限点目前只发给 admin，新角色要单独织。
目标形态：把「看见一切 / 管理一切」从 `role==='admin'` 改成显式权限点（`resources:read:all` / `resources:manage:all`），ACL 谓词 keyed on permission 而非 role string，新角色纯靠 `ROLE_PERMISSIONS` 配置即可——兑现注释承诺。

**[CHOKE-3] memory 的「scope→宿主资源 ACL」每加一种 scope 都要 special-case** — 触发场景：memory 支持新 scope（如 mcp-scoped / plugin-scoped memory）。
根因：`memory.ts` 把 scope 与 ACL 的桥接写成 if 链：`canViewMemory`（`memory.ts:735-740` 手列 repo/global→true，否则 `canViewResource(scope.scopeType, row)`）、`filterMemoriesByScopeVisibility`（`memory.ts:757-797` 为 agent/workflow **各开一个 `inArray` 查询块**）。新 scope = 再抄一个查询块 + 三处 if 分支。
现在要碰：`canViewMemory`/`canManageMemory`/`filterMemoriesByScopeVisibility` 三个函数各加分支，且 `filterMemoriesByScopeVisibility` 的「按 scopeType 分桶查表」模式与 CHOKE-1 的资源枚举耦合。
目标形态：scope→`AclResourceType` 映射做成数据（`SCOPE_ACL: { agent:'agent', workflow:'workflow', repo:null, global:null }`），过滤用 CHOKE-1 的描述符泛型批量解析，删掉 per-scope 手写查询块。已被 `dedup-audit` §4.1 `memory-scope-acl-resolution`（5 站）部分覆盖，此处给出根因为「缺资源描述符」。

**[CHOKE-4] prompt 隔离不变量靠「源码文本断言」守，不是结构性保证** — 触发场景：任何新增「会读 attribution 列的 prompt builder」。
根因：归属（userId / role / displayName）绝不进 agent prompt 是 RFC-099 目标 #6 的硬约束，但保证机制是 `rfc099-prompt-isolation.test.ts:182-221` 的**字符串扫描**（slice 出函数体 grep `answeredBy`/`submittedByRole`/`displayName` 等）。新写一个 prompt builder（例如未来 cross-agent feedback 渲染器）不在测试枚举的函数清单里就无人守；attribution 与正文同表同行（`clarify_rounds.answeredBy` 紧挨 `answersJson`），没有类型层把「可进 prompt 的字段」与「仅审计字段」分开。
现在要碰：每加一个读这些表的渲染函数，都要记得回去 `rfc099-prompt-isolation.test.ts` 加一条 slice 断言——纯靠人记。
目标形态：在 row→prompt 之间加一个 `PromptSafeProjection` 类型（只含可外泄字段），渲染函数只能吃投影、拿不到 attribution 列；编译期而非 grep 期阻断。文本断言降级为兜底。

**[CHOKE-5] 「launch 只校验 workflow，闭包隐式授权」让收回授权后无法阻断在途任务，也无法做引用级审计** — 触发场景：合规要求「撤销某 private agent 授权后立即停掉所有在跑的引用任务」。
根因：D3 设计明确 runner 不查 ACL（`design.md:208`「授权被收回后的在途任务不受影响」）；启动校验只在 `routes/tasks.ts:243/681` 查 workflow 可见性，agent/skill/mcp/plugin 闭包完全隐式授权。`resourceRefs.ts` 的 save-time check（D15）是唯一引用级闸门，且只查**新增**引用。
现在要碰：要做「撤销即停」必须在 runner 每个 node 启动前补 ACL 复查（设计明确拒绝过），或建「任务→引用资源」物化表供撤销时反查——目前两者都没有。
目标形态：v1 接受隐式授权，但落一张 `task_resource_refs`（任务启动时物化引用闭包）既供撤销反查也供审计，不改 runner 热路径。

**[CHOKE-6] OIDC provider 配置每请求重建 service + 每次 discovery 走进程内 Map 缓存，多实例/水平扩展即失效** — 触发场景：daemon 要支持多副本（即便单机多进程）。
根因：`createOidcProvidersService` 每个请求 new 一份（`oidc-auth.ts:24/30/63`）；discovery LRU（`discovery.ts:23 const cache = new Map`）、PKCE/state（`flow.ts:21 const pending = new Map`）、登录失败计数（若按 ACL-09 加）全是**进程内单例**。注释已自认「Single process; lives for the daemon's lifetime」（`flow.ts:3`）。
现在要碰：任何横向扩展都会让 OIDC 回调命中没有对应 state 的副本 → 登录随机失败；这是「单 daemon」架构假设在认证层的硬编码。
目标形态：若多副本进入路线图，state/PKCE 需落 DB（带 TTL 行）或共享存储；当前可接受但要在 design.md 显式钉「OIDC 绑定单进程」假设，避免后人误以为可水平扩。

## 5. 耦合 / 分层违规

**[ACL-12] `taskCollab.ts`（service）反向 import `resourceAcl.ts` 的 `resolveTaskRole`/`isAdminActor`** — 级别 P3｜类型 coupling｜
证据：`taskCollab.ts:17 import { isAdminActor, resolveTaskRole } from '@/services/resourceAcl'`。`resolveTaskRole`（`resourceAcl.ts:168`）本是任务概念却住在 resourceAcl，纯为复用 `isAdminActor`。｜影响：资源 ACL 与任务授权互相 import，模块边界模糊（CHOKE-1 重构时易循环依赖）。｜建议：`isAdminActor` / `resolveTaskRole` 提到 `auth/actor.ts` 或新 `auth/authz.ts`，让 resourceAcl 与 taskCollab 都依赖更底层而非互依。

**[ACL-13] 每路由各写一份 load-visible-or-404 + gate 包装（7+ 站）** — 级别 P2｜类型 coupling｜
证据：`loadVisibleAgent`（`agents.ts:37`）、`canViewResource` inline 检查在 `skills.ts:65`/`mcps.ts:40`/`plugins.ts:48`/`workflows.ts:37`/`tasks.ts:243,681` 逐处重写；`requireResourceOwner` 调用在每个写端点重复（agents 5 处、skills 6 处、mcps 多处…）。｜影响：404/403 契约靠人对齐（已知 task 侧已漂移，见 dedup §4.1）。｜**已被 `dedup-audit-2026-06-13.md` §4.1 `load-visible-resource-or-404`（30 号条目，7 站）与 `task-visibility-list-filter`（4 站）覆盖**；此处仅补充：它同时是 CHOKE-1 的成本来源，重构应一并做。

**[ACL-14] `actor.permissions` 既是「能否进路由」又被部分服务当「能否跨用户读」用，两种语义混在一个集合** — 级别 P3｜类型 coupling｜
证据：`requirePermission` 用 permissions 做粗 gate（`permissions.ts:13`）；而 `canViewTask` 用 `actor.permissions.has('tasks:read:all')`（`taskCollab.ts:35`）做行级 all-bypass，同时 ACL 资源侧却用 `isAdminActor`（role string，`resourceAcl.ts:79`）做同样的 all-bypass。｜影响：同一「看全部」能力，task 走权限点、资源走 role string，两套判据（CHOKE-2 的根）；PAT 收窄 scope 时，task 侧会因丢 `tasks:read:all` 真正降权，资源侧却因 role 不变照看全部（`resourceAcl.ts:8-11` 注释承认这是有意的「PAT 不翻 row visibility」）——这个不对称是设计选择但很反直觉，易踩。｜建议：统一到权限点判据（CHOKE-2 目标形态），消除 role-string 旁路。

## 6. 测试 / 可观测性缺口

**[ACL-15] 认证侧关键安全行为零测试** — 级别 P2｜类型 test-gap｜
证据：`tests/` 下有 `rfc099-resource-acl` / `resource-routes` / `prompt-isolation` / `task-members` / `ws-acl-filter`（ACL 覆盖充分），但**无** login 速率限制测试（因功能不存在，ACL-09）、**无** `postLoginRedirect` 校验测试（漏洞，ACL-07）、**无** link-identity 流程测试（死代码未被发现，ACL-08-bug）。OIDC 仅 `provisioning` 纯函数有测。｜影响：三个认证洞都没有红测试守，正说明测试只覆盖了「已实现的快乐路径」。｜建议：补 redirect 白名单负向测试、登录失败计数测试、link/start 端到端测试（实现后）。

**[ACL-16] ACL 判定无审计日志 / 无拒绝可观测性** — 级别 P3｜类型 observability｜
证据：`requireResourceView`→404、`requireResourceOwner`→403、`requirePermission`→403 直接 throw，无结构化 audit 事件（`grep -n "log\." resourceAcl.ts` 零命中）。owner-transfer（`updateResourceAcl`）是高敏操作也无审计行。｜影响：「谁在何时把资源转给谁 / 谁被拒了多少次」无法回溯，多用户合规场景缺审计轨。｜建议：在 `updateResourceAcl`/`updateTaskMembers`/登录失败处发审计事件（events 表已存在）。

**[ACL-17] OIDC client_secret 仅 AES-GCM 封存，secret.key 与密文同机同盘，且无密钥轮换** — 级别 P3｜类型 security/observability｜
证据：`secretBox.ts:4` key 存 `~/.agent-workflow/secret.key`（chmod 600），密文 `oidc_providers.clientSecretEnc` 在同一 sqlite；丢 key 即所有密文不可读（`secretBox.ts:4` 注释自认）。无 key 版本号、无轮换路径。｜影响：单点失密（拿到机器即拿到 key+密文）；轮换需手动重录所有 provider secret。可接受 for 单机自托管，但应在 design.md 标注威胁模型边界。｜建议：文档化「secret.key 与 DB 同机，威胁模型假设机器本身可信」；轮换留作 future RFC。

## 7. 目标形态（Target architecture）

1. **资源描述符单点驱动一切（解 CHOKE-1 / ACL-02 / ACL-13）**：
   `RESOURCE_DESCRIPTORS: Record<AclResourceType, { table, keyParam:'name'|'id', load, refExtractor?, scopeForMemory? }>`。
   `mountResourceAcl(app, descriptor)` 一次性生成 list-filter / detail-404 / write-gate / ACL 端点 / save-ref-check。新增资源 = 一条描述符 + 一对 permission 字面量，零路由手抄。
2. **授权判据统一为权限点，删 role-string 旁路（解 CHOKE-2 / ACL-14）**：
   引入 `resources:read:all` / `resources:manage:all`，`isVisibleRow`/`isResourceOwner`/`canViewTask` 全部 keyed on `actor.permissions`，admin 只是「拿全部权限点的角色」。新角色纯配置 `ROLE_PERMISSIONS`，兑现 `permission.ts:4` 的承诺。
3. **通用 grant 原语统一资源 grants 与 task collaborators（解 ACL-03）**：
   `principal = (type:'user'|'group', id)` 而非裸 userId（给 CHOKE-4 团队可见性留缝）；owner-transfer「旧 owner 留可见」「校验用户 active」收敛到一处。
4. **prompt 隔离上类型层（解 CHOKE-4）**：row → `PromptSafeProjection`（不含 attribution 列）→ 渲染函数；文本断言降为兜底。
5. **认证补全**：`postLoginRedirect` 同源白名单（ACL-07）、登录失败计数（ACL-09）、link/start 端点（ACL-08-bug）、ACL 变更审计事件（ACL-16）。
6. **列表过滤 SQL 化（解 ACL-01）**：`visibleIdsFilter` 真落 Drizzle where，与窄投影下推同 SQL。

## 8. Top 风险与建议优先级

| 优先 | ID | 标题 | 级别 | 类型 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| 1 | ACL-07 | OIDC postLoginRedirect 开放重定向 + token fragment 外泄 | P1 | security | 立即加同源白名单 |
| 2 | ACL-09 | 登录无速率限制/暴力破解防护 | P1 | security | 加失败计数+退避 |
| 3 | ACL-08-bug | link-identity 流程死代码（无端点设 linkUserId） | P1 | impl-bug | 补 link/start 或删分支 |
| 4 | ACL-05 | repos 在 ACL 之外、全 user 可读、不进任务闭包 | P2 | design/security | 纳入 ACL 或文档化决策 |
| 5 | CHOKE-1 | 加第 6 类资源碰 ≥8 处硬编码 | P2 | extensibility | 资源描述符单点 |
| 6 | CHOKE-2 | 加第 3 个角色撞 role-string all-bypass | P2 | extensibility | 判据改权限点 |
| 7 | ACL-01 | 列表 JS 全表后过滤，背离 design 的 SQL 谓词 | P2 | design/perf | 实现 visibleIdsFilter |
| 8 | ACL-03 | 任务授权与资源 ACL 两套平行模型 | P2 | design/coupling | 通用 grant 原语 |
| 9 | CHOKE-4 | prompt 隔离只靠文本断言非类型保证 | P2 | test-gap/design | PromptSafeProjection |
| 10 | ACL-15 | 认证侧安全行为零测试 | P2 | test-gap | 补三洞负向测试 |
| 11 | CHOKE-3 | memory scope→ACL 每加 scope special-case | P3 | extensibility | scope 映射数据化 |
| 12 | ACL-13 | load-visible-or-404 每路由各写一份 | P2 | coupling | 已被 dedup §4.1 覆盖 |
| 13 | ACL-11 | session sweep `and(X,X)` + 注释不符 | P3 | impl-bug | 删重复谓词修注释 |

### 待核验（无足够证据下断言）
- ACL-07 的实际可利用性取决于前端是否把任意外部 URL 传入 `postLoginRedirect`（需看前端 login-start 调用点）；即便前端不传，端点本身接受任意值已构成服务端漏洞，故仍列 P1。
- ACL-09 的「在线穷举可行性」依赖部署是否在公网暴露 `/api/auth/login`；自托管内网场景风险降级，但缺防护本身是事实。
