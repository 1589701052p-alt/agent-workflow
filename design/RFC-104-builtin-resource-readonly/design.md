# RFC-104 技术设计

## 1. 核心抉择：用不可变 `builtin` 列做身份锚，取代 owner+name 启发式

### 现状判别器的软肋

`services/systemResources.ts:46`：

```ts
function isBuiltin(names, row) {
  return row.ownerUserId === SYSTEM_USER_ID && names.has(row.name)
}
```

它把"是不是内置"绑定在 **owner 仍为 `__system__`** 上。于是：

- **owner 一被改走，判别即失效** → 隐藏失效、只读锁（若也基于此判别）失效。"改 owner"成了绕过一切内置保护的后门。
- `workflows.name` 非唯一，靠 name 区分需要叠加 owner 条件，逻辑脆。
- 衍生 bug：`fusion.ts:264` 的 `fusionWorkflowId` 用 `wfs.find(w => w.name === NAME)` **纯按 name** 取，若库里同时存在用户自建同名工作流，可能选错。

### 方案：加一列 `builtin INTEGER NOT NULL DEFAULT 0`

给 `agents`、`workflows` 两张表加不可变布尔列 `builtin`：

- 仅由 `seedFusionResources` 在创建内置行时置 1；**任何 API 写路径都不写它**（不在 `createAgent/createWorkflow/updateX` 的可写字段里，Zod schema 不暴露）。
- 判别变成 `row.builtin === true`——**与 owner / name 完全解耦**，抗漂移。
- daemon-token 创建的普通用户 agent（owner 也是 `__system__`）天然 `builtin=0`，不再误判（这正是旧判别要叠 name 集合的原因，现在自然消解）。
- `fusionWorkflowId` / `seedFusionResources` 改为按 `builtin=1` 命中，彻底消除 name 歧义。
- 用户**仍可**自建名为 `aw-skill-fusion` 的工作流（`builtin=0`，正常可见可改，框架忽略它）——保留 RFC-101 既有许可，且不再有歧义。

> **取舍**：代价是一张迁移 + 回填 + 判别器换实现 + 触及 DTO 映射。收益是抗漂移、单一事实源、顺带修掉 `fusionWorkflowId` 歧义 bug。轻量替代见 §9 OQ-1（仅加守卫、保留 owner+name 启发式），但它对"owner 已被改走"的历史漂移无法自愈，不推荐。

### 迁移 `0049_rfc104_builtin_flag.sql`

```sql
ALTER TABLE `agents`    ADD COLUMN `builtin` integer NOT NULL DEFAULT 0;
ALTER TABLE `workflows` ADD COLUMN `builtin` integer NOT NULL DEFAULT 0;
-- 回填现存的两条内置行（正常未漂移场景）
UPDATE `agents`    SET `builtin` = 1 WHERE `name` = 'aw-skill-merger' AND `owner_user_id` = '__system__';
UPDATE `workflows` SET `builtin` = 1 WHERE `name` = 'aw-skill-fusion' AND `owner_user_id` = '__system__';
```

drizzle `db/schema.ts` 的 `agents` / `workflows` 表定义同步加 `builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false)`。

> 漂移场景（owner 早被改走，回填 UPDATE 命不中）：交由 §3 的播种自愈——`seedFusionResources` 发现"无 `builtin=1` 的内置行"会**新建**一条干净内置行；被改乱的旧行退化为普通用户行，因一切以 `builtin` 为准而互不干扰，无数据丢失。

## 2. 单一事实源：`systemResources.ts`

```ts
// 身份判别（列驱动，类型无关）
export function isBuiltinRow(row: { builtin?: boolean | null }): boolean {
  return row.builtin === true
}

// 通用守卫：任何写 / 执行 / 覆盖入口命中内置行即拒
export function assertNotBuiltin(
  type: AclResourceType,
  row: { builtin?: boolean | null },
): void {
  if (isBuiltinRow(row)) {
    throw new ForbiddenError(
      'builtin-readonly',
      `${type} is a built-in framework resource and is read-only`,
    )
  }
}
```

- `excludeBuiltinAgents/Workflows` 改为基于 `isBuiltinRow`（不再吃 name 集合）。
- `BUILTIN_AGENT_NAMES` / `BUILTIN_WORKFLOW_NAMES` / `SKILL_*_NAME` 常量**保留**，仅供 `seedFusionResources` 播种 / 自愈定位用，不再参与运行时判别。
- `ForbiddenError('builtin-readonly')` → HTTP 403（沿用 `util/errors.ts` 既有 Forbidden→403 映射）。

## 3. 播种改为"按 builtin 命中 + 漂移自愈"

`services/fusion.ts` `seedFusionResources`：

- **存在性判据**从"按 name 存在"改为"存在 `builtin=1` 且匹配该内置 name 的行"。
- 不存在 → `createAgent/createWorkflow(..., { ownerUserId: SYSTEM_USER_ID, builtin: true })` 新建（需让这两个 service 接受内部 `builtin` 标志，仅 seed 调用方传，HTTP 层 schema 不含此字段）。
- 存在但 **owner/visibility 漂移** → 用底层 drizzle `update` 修回 `owner_user_id='__system__'`、`visibility='public'`（**直接走 drizzle，不经 `updateResourceAcl`**，从而绕过 §4 的只读守卫——这是框架内部的合法修复，不是外部篡改）。
- 调用时机不变：daemon boot（`cli/start.ts:175`）+ 每次 `createFusion` 前（`fusion.ts:333`）。

`fusionWorkflowId`：`listWorkflows(db)` 后 `find(w => w.builtin && w.name === SKILL_FUSION_WORKFLOW_NAME)`，命中唯一内置行；找不到则（理论不可达，因调用前已 seed）抛错。

## 4. 守卫接入点（全部加 `assertNotBuiltin`）

> 统一在**已加载行之后、真正写之前**插入。对 admin 同样生效（守卫不看 role）。
> skill/mcp/plugin 当前无内置行 → 守卫为 no-op，但接入保证未来内置即覆盖。

| 入口 | 文件:行 | 备注 |
|---|---|---|
| Agent PUT | `routes/agents.ts:88` 后 | 更新 body |
| Agent DELETE | `routes/agents.ts:134` 后 | |
| Agent rename | `routes/agents.ts:150` 后 | |
| Skill PUT | `routes/skills.ts:161` 后 | no-op（今） |
| Skill DELETE | `routes/skills.ts:168` 后 | |
| Skill content PUT | `routes/skills.ts:188` 后 | |
| Skill file PUT / DELETE | `routes/skills.ts:217 / 232` 后 | |
| Skill version restore | `routes/skills.ts:266` 后 | |
| MCP PUT / DELETE / rename | `routes/mcps.ts:87 / 96 / 112` 后 | no-op |
| Plugin PUT / DELETE / rename / check-update / upgrade | `routes/plugins.ts:97 / 110 / 126 / 138 / 157` 后 | no-op |
| Workflow PUT | `routes/workflows.ts:88` 后 | |
| Workflow DELETE | `routes/workflows.ts:103` 后 | |
| **ACL PUT（五类统一）** | `routes/resourceAcl.ts:51` 后（`updateResourceAcl` 前） | **核心**：堵死 owner/visibility/grants 篡改 |
| **手工执行 JSON** | `routes/tasks.ts:271` 的 `canViewResource` 通过后 | `assertNotBuiltin('workflow', wf)` |
| **手工执行 multipart** | `handleMultipartTaskStart` 内解析出 workflow、`canViewResource` 之后（tasks.ts:~713） | 同上 |
| **YAML 导入覆盖** | `services/workflow.yaml.ts:122`（overwrite 分支，`requireResourceOwner` 前） | `assertNotBuiltin('workflow', existing)` |
| **ZIP 导入覆盖** | `services/skill-zip.ts:267` 旁（与 external/owner 检查并列） | 命中内置技能则 `outcome.failed.push({code:'skill-builtin-readonly'})`；no-op（今） |

为让 `assertNotBuiltin` 在 ACL 路由可用：`resourceAcl.ts` 的 `AclRow` 接口加可选 `builtin?: boolean`；`getWorkflow`/`getAgent` 返回的 DTO 带上 `builtin`（见 §5），其余 `getSkill/getMcp/getPlugin` 不带 → `undefined` → 判为非内置。

### 框架内部豁免（**不加守卫**）

- service 层 `startTask`（`task.ts:431`）：融合靠它跑内置 workflow，**保持无 ACL/builtin 校验**。只读锁是**路由层**的事。
- `seedFusionResources` 的 drizzle `update` 修复路径：绕过 `updateResourceAcl`，合法。
- scheduler 推进已启动任务的节点：不新启 workflow，无关。

## 5. DTO 暴露 `builtin`

- `services/workflow.ts` 的行→DTO 映射加 `builtin: row.builtin`；`services/agent.ts` 同。
- shared 类型 `Workflow` / `Agent` 加 `builtin?: boolean`（可选，fixture 向后兼容）。
- 前端不消费它（用户已选保持隐藏）；暴露只为后端守卫 / 列表过滤读取，且无害。
- `createAgent/createWorkflow` 的内部 opts 增加 `builtin?: boolean`（默认 false，仅 seed 传 true）；HTTP `CreateAgentSchema/CreateWorkflowSchema` **不含** `builtin`，杜绝外部置位。

## 6. 失败模式与错误码

| 场景 | 行为 |
|---|---|
| 改 / 删 / 改名 / 改权限 / 手工执行内置 | `ForbiddenError('builtin-readonly')` → 403，message 指明资源类型只读 |
| YAML overwrite 命中内置工作流 | 同上 403（在 service 抛，路由透传） |
| ZIP overwrite 命中内置技能 | 该候选项进 `outcome.failed`，code `skill-builtin-readonly`，其余候选继续 |
| 非内置同名资源（用户自建 `aw-skill-fusion`，builtin=0） | 一切操作正常放行 |
| daemon 启动遇 owner/visibility 漂移的内置行 | 静默修回 `__system__`/`public`；无内置行则新建 |

## 7. 与现有模块耦合点

- **RFC-099 ACL**：`assertNotBuiltin` 置于 `requireResourceOwner` 同侧但**优先级更高**（内置 → 直接 403，不再看 owner）。既有"非 owner→403 / 不可见→404"语义不变。内置行是 public，人人可见，无 D1 存在性泄漏风险。
- **RFC-101 隐藏**：判别换列后，`rfc101-builtin-list-hidden.test.ts` 需改用 `builtin` 列构造，但行为（列表隐藏 + 用户同名行存活）不变。
- **prompt 隔离**：`builtin` 是后端列，绝不进 agent prompt；不影响 rfc099-prompt-isolation。

## 8. 测试策略（必写用例）

新增 `packages/backend/tests/rfc104-builtin-readonly.test.ts`：

1. **改/删/改名**：admin 对内置 agent/workflow PUT、DELETE、rename → 403 `builtin-readonly`。
2. **改权限**：admin PUT `/api/workflows/:id/acl` 改 owner / visibility / users 命中内置 → 403（上一轮 footgun 的回归锁）。
3. **技能写入族**（用临时置一条 `builtin=1` 的 managed skill 行做夹具）：PUT content / file、DELETE file、restore version → 403。
4. **手工执行**：`POST /api/tasks` JSON 分支 + multipart 分支以内置 workflowId 启动 → 403。
5. **导入覆盖**：YAML overwrite 命中内置工作流 → 拒绝；ZIP overwrite 命中内置技能 → `failed[].code='skill-builtin-readonly'`。
6. **框架内部不被误锁**：`createFusion` → service `startTask` 跑内置 workflow → 任务正常进入 awaiting_human/running（复用 `fusion-engine.test.ts` 夹具，断言不抛 builtin-readonly）。
7. **抗漂移自愈**：底层 drizzle 把内置行 owner 改成某用户 / visibility 改 private → 调 `seedFusionResources` → 断言修回 `__system__`/`public`（或新建出 `builtin=1` 行）。
8. **find-by-builtin 不歧义**：库里同时存在用户自建 `aw-skill-fusion`(builtin=0) 与内置(builtin=1) → `fusionWorkflowId` 命中内置那条。
9. **非内置放行**：用户自建同名工作流可正常 PUT/DELETE/launch。

更新 `rfc101-builtin-list-hidden.test.ts`：改用 `builtin` 列；补一条"owner 被改走但 builtin=1 仍隐藏"的断言（旧判别会漏，新判别要锁住）。

源码层兜底锚点（巨型 route 难直接覆盖处）：断言 `assertNotBuiltin` 出现在各 mutation 路由 + ACL PUT + tasks 启动分支（文本断言防回归删除）。

运行门槛：`bun run typecheck && bun run test && bun run format:check` 全绿；CI 另跑单二进制 smoke + e2e（迁移加列须过 binary smoke）。

## 9. 开放问题（OQ）

- **OQ-1（替代方案）**：不加列，仅在上述守卫点用现有 `isBuiltin(owner+name)` 启发式。省一张迁移，但对"owner 已被改走"的历史漂移无法自愈、`fusionWorkflowId` 歧义不修。**不推荐**，列入备选供用户在批准时取舍。
- **OQ-2（列的覆盖面）**：本 RFC 只给 agent+workflow 加 `builtin` 列（仅此二者有内置实例）。skill/mcp/plugin 守卫为 no-op；未来若加内置技能，需补一张迁移给 `skills` 加列 + 在 seed 置位——已是一行扩展。
- **OQ-3（reserved name 是否全局保留）**：当前**不**禁止用户创建 `aw-skill-*` 同名资源（列驱动判别已无歧义，保留 RFC-101 许可）。若日后希望连名字也独占，可另开 RFC 加创建期 name 保留校验，与本锁正交。

## 10. Codex 设计 gate 复审（needs-rework）→ 已 fold 的修订

落档后经 Codex 设计 gate 复审（base 提交前），判 **needs-rework**，5 项发现已全部 fold 进实现：

- **[P1 阻断] 回填/自愈歧义**——`name+owner='__system__'` 对非唯一的 `workflows.name` 会误标 daemon-token 同名普通行，对 owner 已漂移的 agent 又漏标、"新建"撞唯一名。**修法（已实现）**：
  - 迁移 `0049` 回填改**确定性**：agent 按唯一名（安全）；workflow 只标 `id = (SELECT id … WHERE name AND owner='__system__' ORDER BY id ASC LIMIT 1)`（最旧 ULID = 框架首播种行），并加 `CREATE UNIQUE INDEX … ON workflows(name) WHERE builtin=1` 做 DB 级「每名 ≤1 内置」backstop。
  - `seedFusionResources` 改 **repair-or-adopt-or-create**（`fusion.ts`）：agent 按唯一名 repair 既有行（不盲建，避免唯一名冲突）；workflow 先找 `builtin=1` 行（repair owner/visibility 漂移），无则 adopt 最旧 `__system__` 同名行，再无则新建——全部走底层 drizzle、绕过只读锁（框架内部合法）。
- **[P2 阻断/范围] 技能守卫前后矛盾**——`skills` 表无 `builtin` 列，却在 §4/§8 写了 skill 守卫与 builtin 夹具。**修法（已实现）**：范围**收窄到 agent+workflow**（唯二有内置实例者，与 §1/OQ-2 一致）。守卫只接 agent/workflow mutation + 通用 ACL PUT（对 skill/mcp/plugin 天然 no-op）+ 任务启动两分支 + workflow YAML overwrite；**不接** skill/mcp/plugin 专属路由（避免「部分覆盖=假保护」）。**§8 勘误：删除原 test-3「技能写入族 builtin 夹具」**（无内置技能、无列，无法构造）。未来加内置技能须：给 `skills` 加列 + 守卫其**全部**写路径（ZIP/source-conflict 导入、reconcile、`commitSkillVersion` 融合批准）——已在 `systemResources.ts` 头注记为前置义务。
- **[P3] 守卫顺序**——固定为 `loadVisible/canView(404) → assertNotBuiltin(403) → requireResourceOwner(403) → write`（已在各路由实现；内置公开、无 D1 泄漏）。测试以「actor-blind 的 `assertNotBuiltin` 单测 + admin token 路由 403」双向覆盖。
- **[P3] Resume/Retry 策略**——启动守卫保证**用户发起的任务永不引用内置工作流**（launch 403），故无可续跑的用户内置任务；fusion 内部任务经 service `startTask` 创建、合法续跑。**结论：resume/retry 不加守卫**（续跑既有快照），已在测试注释与本节文档化。
- **[P3] 迁移元数据/二进制嵌入**——本仓自 `0012` 起**停用 drizzle-kit generate、改手写迁移**（snapshot 冻结在 0012、`migrate()` 只读 `_journal.json`+`.sql`）。故 `0049` 为手写 SQL + 注册 `meta/_journal.json` idx48。binary 嵌入走迁移目录 glob（T7 binary smoke 验证 `0049` 被嵌入+应用）。

> §1/§4/§8 以本节为准（设计演进记录保留原文）。Codex 总评：核心只读锁思路正确，阻断项为迁移/回填歧义 + 范围矛盾，二者均已按「收窄 + 确定性自愈」修订。
