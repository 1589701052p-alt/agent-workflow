# RFC-099 — 技术设计

> 阅读顺序：proposal.md（决策登记 D1–D19）→ 本文 → plan.md。
> 现状锚点全部实证：schema.ts:14/95/127/205/233/287/1152/1179、permission.ts、actor.ts、
> permissions.ts:46 `resourcePermissionGate`、taskCollab.ts:25/163/244、reviews.ts:49-74/171、
> clarify.ts:73/98/189/212/245、tasks.ts:225-247/558、review.ts:2053、clarifyRounds.ts:328、
> ws/server.ts:281-321、memoryInject.ts、routes/users.ts:26。

## 1. 数据模型（migration 0045_rfc099_ownership_acl.sql）

**五资源表加列**（agents / skills / mcps / plugins / workflows）：

```sql
ALTER TABLE {t} ADD COLUMN owner_user_id TEXT;            -- FK users.id（应用层约束）
ALTER TABLE {t} ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';  -- 'private'|'public'
UPDATE {t} SET visibility = 'public',
  owner_user_id = COALESCE(
    (SELECT id FROM users WHERE role='admin' AND id != '__system__'
       ORDER BY created_at ASC LIMIT 1),
    '__system__');
```

**通用授权表**（一张表服务五类资源，避免 5 张孪生表）：

```sql
CREATE TABLE resource_grants (
  resource_type TEXT NOT NULL,         -- 'agent'|'skill'|'mcp'|'plugin'|'workflow'
  resource_id   TEXT NOT NULL,         -- 对应表主键 id
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by      TEXT NOT NULL,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (resource_type, resource_id, user_id)
);
CREATE INDEX idx_resource_grants_user ON resource_grants(user_id);
```

**其余**：

- `skill_sources` 加 `created_by TEXT`（同款 backfill）；扫描导入的 external 技能行
  `owner_user_id = source.created_by`、`visibility` 继承 source 既有技能策略——存量 public、
  新源导入 private（reconciler 写入点：services/skill-source.ts）。
- `review_comments` 加 `author_role TEXT`；`doc_versions` 加 `decided_by_role TEXT`；
  `clarify_rounds` 加 `submitted_by_role TEXT`、`answer_attributions_json TEXT`、
  `draft_answers_json TEXT`。全部 nullable，历史行 NULL = 渲染成「本地用户（历史）」。
- 指派移除：`INSERT OR IGNORE INTO task_collaborators (task_id,user_id,role,added_by,added_at)
  SELECT task_id,user_id,'collaborator',added_by,added_at FROM task_collaborators
  WHERE role IN ('reviewer','clarify_target');` → `DELETE` 这两类行 → `DROP TABLE
  node_assignments;`。drizzle 侧 `taskCollaborators.role` enum 收紧为
  `['owner','collaborator']`，删除 `nodeAssignments` 导出。

角色快照取值 `TaskActorRole = 'owner' | 'user' | 'admin'`（D7/D17）。
`answer_attributions_json: Record<questionId, { userId, role, updatedAt }>`。

## 2. 权限目录与 ACL 服务

**shared/permission.ts**：`agents:write / skills:write / mcps:write / plugins:write /
workflows:write` 五点移入 `USER_BASELINE`（D4：路由级 write 仅表示「可创建/可写自己有权的行」，
行级判定下沉 ACL 层）。`memory:approve / memory:archive / memory:delete / memory:edit` 同样移入
baseline，行级由 §6 的 `canManageMemory` 把关（D12）。ADMIN_ONLY 快照测试同步更新。
`resourcePermissionGate`（permissions.ts:46）保持不动——它仍是方法级粗闸。

**新 service `services/resourceAcl.ts`**（纯函数 + 最小 DB 读，全部直测）：

```ts
type AclResourceType = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow'
type AclRow = { id: string; ownerUserId: string | null; visibility: 'private' | 'public' }

canViewResource(db, actor, type, row)    // admin → true; owner → true; public → true; grant 查表
requireOwner(db, actor, type, row)       // owner 或 admin，否则 ForbiddenError
visibleIdsFilter(db, actor, type)        // 列表 SQL 谓词：visibility='public' OR owner=me OR id IN (grants)
resolveTaskRole(actor, task, isMember)   // D17: ownerUserId===me → 'owner'; isMember → 'user'; admin → 'admin'
```

详情路由对不可见资源回 **404**（D1——避免存在性探测），写操作对可见但非 owner 回 403。

**ACL 管理端点**（五资源同构，挂在各自 routes 文件）：

- `GET  /api/{res}/:id/acl` → `{ ownerUserId, visibility, users: PublicUser[] }`（资源可见者皆可读，D16）
- `PUT  /api/{res}/:id/acl` → `{ ownerUserId?, visibility?, userIds? }` 全量替换语义；
  owner/admin only；userIds 校验 active（复用 taskCollab.ts:174 的 active 校验模式）；
  转让 owner 后旧 owner 自动落入用户列表（避免自我锁死）。

## 3. 资源路由改造（行级过滤）

| 路由                                  | 改造                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| GET /api/{res}（5 类列表）            | 接 `visibleIdsFilter`；响应加 `ownerUserId/visibility`               |
| GET /api/{res}/:id                    | `canViewResource` 失败 → 404                                          |
| POST /api/{res}                       | 创建者写入 `owner_user_id=actor`，默认 private（D18）                |
| PUT/PATCH/DELETE /api/{res}/:id       | `requireOwner`                                                        |
| GET /api/skills（RFC-017 reconciler） | 扫描导入行带 owner（§1）                                              |
| workflows YAML import                 | 导入者即 owner；export 要求可见                                       |

**保存校验只查新增引用**（D15，纯函数 + wire）：

```ts
extractResourceRefs(workflowDef) → { agents: Set<string> }            // 节点 agentName 全集
extractAgentRefs(agentRow)       → { skills, mcp, plugins, dependsOn } // JSON 列四集合
diffNewRefs(oldRefs, newRefs)    → 新增项列表
```

PUT /api/workflows/:id 与 POST/PUT /api/agents：对 `diffNewRefs` 产物逐项
`canViewResource`（按名字解析行；名字不存在维持现有报错），缺失 → 422
`{ code: 'acl-missing-refs', missing: [{type, name}] }`；对编辑者不可见的资源在错误里只回
名字（他在定义里本来写得出名字，不回 id/描述）。存量引用不校验——「改不动自己工作流」的
死胡同不存在。**启动任务（POST /api/tasks）只校验工作流本身 `canViewResource`**（D3）；
runner / scheduler / opencode 注入零改动（daemon=`__system__` admin）。

## 4. 任务：成员管理 + 操作权放宽

- `POST /api/tasks`：保留 `collaboratorUserIds`（taskCollab.ts:163 已支持）；**删除
  `assignments` 字段**（shared StartTaskSchema 收紧，未知字段 zod strip 之外显式 422 提示
  迁移）。删除 `PATCH /api/tasks/:id/assignments/:nodeId`（tasks.ts:247）与
  `ensureValidAssignments / getNodeAssignment / isAssignedReviewer / isAssignedClarifyTarget /
  changeNodeAssignment`（taskCollab.ts）。
- 新端点：`PUT /api/tasks/:id/members` → `{ ownerUserId?, userIds? }`，owner/admin only；
  owner 转让写 tasks.ownerUserId + collaborators owner 行替换（单事务，txSync 模式）。
- **操作权放宽**（D13）：cancel / resume / retryNode / diagnose-repair / 留言（taskFeedback）
  的 gate 从「owner/admin」改为「任务成员（canViewTask 为真且非纯 read:all 旁观）」。实现：
  `requireTaskMember(db, actor, task)` = owner ∪ collaborator ∪ admin；任务删除与成员管理
  仍 owner/admin。tasks 列表/详情可见性闭包不动（tasks.ts:160-174/558）。

## 5. 评审/反问：成员门槛 + 归属记录 + 草稿

**门槛统一**：reviews.ts:49-74 与 clarify.ts:51-98 的三选一检查（assigned/owner/admin）替换为
`requireTaskMember`。错误文案同步（i18n key 复用）。

**归属写点**（全部带 `resolveTaskRole` 角色快照，成员身份优先）：

| 动作               | 写点                  | 新增                                            |
| ------------------ | --------------------- | ----------------------------------------------- |
| 评审意见 POST      | reviews.ts:171        | `authorRole`                                    |
| 评审决策           | services/review.ts 决策落库处（decidedBy 同行） | `decidedByRole`；多文档逐文档 selection 归提交决策者 |
| 反问提交           | clarify.ts:212/245（dual-write 仅权威表 clarify_rounds 加列） | `submittedByRole`；冻结 `answerAttributionsJson` |

**反问服务端草稿**（D8/D14）：

- `PUT /api/clarify/:nodeRunId/draft` body `{ roundId, questionId, value }`：成员 only；
  round 必须 `status='awaiting_human'`；逐题写 `draft_answers_json[questionId]` +
  `answer_attributions_json[questionId] = {userId, role, updatedAt}`（单事务读改写，SQLite
  单写者天然串行 → 逐题 last-write-wins）；广播 `clarify.draft.updated` 帧到
  `TASK_CHANNEL(taskId)`（TaskWsMessage union 加变体：`{ nodeRunId, roundId, questionId,
  editor: {userId, displayName, role}, ts }`，**WS 帧是 UI 面，允许带人名**）。
- 提交端点改造：以 body 答案为准（与现行为一致），但对「与草稿一致的题」保留草稿归属、
  「提交时被改的题」归属=提交人；冻结后清 `draft_answers_json`。kind='self' 与 'cross' 同一
  套（clarify_rounds 是两类的权威表）。前端打开反问页时 GET 返回草稿 + 逐题归属。

**Prompt 隔离**（D7 硬约束）：`renderCommentsForPrompt`（review.ts:2053）、
`buildPromptContext`（clarifyRounds.ts:328）、`buildClarifyPromptBlock`、
`buildReviewPromptContext` 不读任何新列。回归防护双层：(a) 单测——构造带归属的行，断言渲染
产物不含 userId/displayName/'owner'/'admin' 角色字样；(b) 源码层文本断言——上述函数所在
文件不得出现 `authorRole/answerAttributions/submittedByRole/decidedByRole` 标识符。

## 6. 记忆随权限（D12）

- 读：`GET /api/memories`（列表/详情/approval queue）按 scope 过滤——
  `scope_type='agent'` → join agents 行走 `canViewResource`；workflow 同理；repo/global 全员。
  实现为 `visibleMemoryFilter(db, actor)`（一次性取 actor 可见的 agent/workflow id 集，再
  SQL IN；规模小，v1 不做增量缓存）。
- 管理（approve/reject/edit/archive/delete + supersede）：`canManageMemory(db, actor, memory)`
  = admin ∨（scope 资源 owner）；repo/global → admin only。routes/memories.ts 各写端点接入。
- `/ws/memories` 逐帧过滤：帧带 memoryId → 查 scope →（per-connection 缓存）可见才发，复用
  ws/server.ts:281-313 tasks-list 的 cached 逐帧模式与「未知形状不发」的保守默认。
- 注入（memoryInject.ts）与 distiller、distill jobs 页面零改动；
  `routes-memories-patch` 既有 byte-equal 不变量测试保持绿。

## 7. WS：workflows 通道过滤

`/ws/workflows`（ws/server.ts:315-321 目前无过滤）：WorkflowsWsMessage 各变体都带
workflowId → 逐帧 `canViewResource`（per-connection `visibilityCache` 复用，ACL 变更时简单
失效：收到 `workflow.acl.updated` 帧种类时清缓存条目）。`PUT /api/{res}/:id/acl` 成功后向
对应通道广播 acl.updated（workflows 通道已有；其余四资源无 WS 通道，靠 React Query
invalidation，不新建通道）。

## 8. 前端

- **新公共组件**（按 CLAUDE.md §Frontend UI consistency 落 `components/`，复用 Dialog/Form/
  Select/ChipsInput/StatusChip 原语）：
  - `UserPicker.tsx`——`/api/users/search`（routes/users.ts:26）异步搜索 + debounce 200ms +
    多选 chips；启动器、成员面板、ACL 面板共用。
  - `AclPanel.tsx`——owner 行 + `.segmented` private/public 切换 + 成员 chips + 转让
    owner（Dialog 确认）；五资源详情页 + 任务详情页（成员变体）挂载；非 owner 非 admin
    渲染只读。
- 资源列表行加 owner 徽标；详情页加「权限」section；多用户未启用（RFC-036 gating）时整体隐藏。
- 画布：侧栏 agent 列表 = 可见集；节点引用不可见 agent 时 label 渲染 i18n 占位
  「无权限代理」（定义 JSON 不重写，见 proposal 非目标）。
- 启动器：任务名下方加「任务用户」UserPicker（可空）。
- 评审详情：意见行尾 + 决策历史显示「displayName（角色）」chip；历史 'local' 行渲染
  「本地用户（历史）」。
- 反问详情：逐题 footer「最后由 X（角色）修改 · 时间」；草稿 debounce 1s 自动保存；WS 帧到达
  时若本题非聚焦则直接刷新值 + 顶部 toast「X 刚刚更新了第 N 题」；已提交视图显示逐题归属 +
  「由 Y 提交」。
- 记忆页：列表自然被过滤；管理按钮按 `canManage`（API 响应带 `canManage: boolean`）显隐。
- i18n 中英对称新增 ~50 key。

## 9. 失败模式

- **owner 被禁用/失活**：资源不受影响（owner 判定纯 id 比对）；admin 可转让。grant 写入时
  校验 active，存量不回收。
- **授权被收回后的在途任务**：不受影响（启动时已过闸，runner 不查 ACL）。
- **名字唯一性探测**：创建重名 → 既有「name taken」错误会泄露隐藏资源名字的存在性——接受并
  在错误文案中不附加任何资源信息。
- **draft 与 submit 竞态**：submit 在事务内读最新 draft 合并归属；draft 写到已 answered 的
  round → 409 `clarify-round-not-awaiting`。
- **迁移幂等**：0045 对已加列重跑安全（house 风格 IF-NOT-EXISTS 探测 / 单次性由 migrator
  序号保证）；无 admin 亦无用户的纯 daemon 库 → owner 全部 `__system__`，行为与今天一致。
- **WS 缓存陈旧**：ACL 收紧后已连接用户最长在缓存生命周期内多看到帧——v1 接受（连接断开即
  失效；acl.updated 主动清 workflows 条目）。

## 10. 测试策略（必写清单）

- **shared**：permission 快照（baseline 扩容 + ADMIN_ONLY 收缩）；StartTaskSchema 拒
  assignments；新 zod schema（Acl/attribution/ws 变体）round-trip。
- **backend 纯函数**：`canViewResource` 矩阵（admin/owner/grant/public/none × 5 type）；
  `resolveTaskRole` 优先级（owner∧admin → owner 等 6 case）；`extractResourceRefs/
  extractAgentRefs/diffNewRefs`；`visibleIdsFilter` SQL 谓词。
- **backend 路由**：五资源 list 过滤 / detail 404 / 写 403 / ACL 端点（owner 转让旧 owner
  保留可见）/ 创建归属；保存新增引用 422 列缺失 + 存量引用宽限；启动仅查工作流；任务成员
  端点 + cancel/retry/resume 成员放行 + 非成员 404/403；评审/反问成员门槛（替换 assigned
  分支后旧 403 case 翻转）；归属写点角色快照（含 admin 介入、owner 兼 admin 记 owner）；
  draft API（LWW 双写序、award attribution、submit 冻结、answered 后 409）；memory 过滤 +
  manage 矩阵 + byte-equal 注入不变量保持；WS workflows/memories 逐帧 drop（含未知形状不发）；
  migration 0045 backfill 断言（fixture：有 admin / 无 admin 两库）。
- **Prompt 隔离**：§5 双层防护各 1 组。
- **frontend**：UserPicker（搜索/防抖/多选）；AclPanel（owner 视角可编辑 / 用户视角只读 /
  public 切换）；列表 owner 徽标；画布占位 label；启动器选人；任务成员面板；评审归属 chip
  （含 'local' 历史兼容）；反问逐题 footer + 自动保存 + WS toast + 提交人展示；memory 管理
  按钮显隐。
- **e2e**（1 spec）：admin 创建 user B → B 建 private agent + workflow → admin 看不到？
  （能，admin 全可见）→ 第三用户 C 看不到 → B 授权 C → C 启动任务挂 B/C 为成员 → 反问两人
  分题作答 + C 提交 → 界面显示逐题归属 → 评审 C 决策显示「C（用户）」。
