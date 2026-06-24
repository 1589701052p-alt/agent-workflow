# RFC-104 内置资源只读锁（build-in resource read-only）

状态：Draft
作者：Claude（应用户要求）
日期：2026-06-24
关联：RFC-099（资源 ACL）、RFC-101（记忆→技能融合，引入了首批内置 DB 行）

## 背景

RFC-101 把两条**框架自有资源**作为真实 DB 行播种进库，供融合引擎以 id 驱动：

| 资源 | name | owner | visibility | 播种处 |
|---|---|---|---|---|
| Agent | `aw-skill-merger` | `__system__` | `public` | `services/fusion.ts:188`（`seedFusionResources`） |
| Workflow | `aw-skill-fusion` | `__system__` | `public` | `services/fusion.ts:211` |

它们是**基础设施**而非用户资产，目前只在用户列表里被 `excludeBuiltinAgents/Workflows` 隐藏（`services/systemResources.ts`）。但"隐藏"≠"锁定"：

1. **可被改/删**：`PUT/DELETE /api/{res}/:id` 只有 `requireResourceOwner` 守卫，admin（或 daemon `__system__` token）能改 body、删除、改名。
2. **可被改权限**：`PUT /api/{res}/:id/acl` 同样只 `requireResourceOwner`。把 `aw-skill-fusion` 的 **owner 转走**后，判别器 `isBuiltin = owner===__system__ && name∈集合` 立刻失效 → 工作流不再隐藏、变成可见可删的"普通"行——这正是上一轮用户担心的故障。
3. **可被手工执行**：内置工作流是 `public`，`POST /api/tasks` 只校 `canViewResource`，用户指定 `workflowId` 即可直接启动它（虽然列表里看不到，但 id 可从融合任务等处获得）。
4. **可被导入覆盖**：`POST /api/workflows/import?onConflict=overwrite` 能按 id 覆盖内置工作流定义；skill ZIP 导入的 overwrite 分支同理（当前无内置 skill，但机制需就位）。

合成、从不入库的系统资源（RFC-075 commit agent、RFC-050 memory distiller）不在本 RFC 范围——它们不是 DB 行、不进 ACL 表，无可锁对象。

## 目标

把所有**框架内置 DB 行**焊死为只读，使任何用户（含 admin / daemon token）都**不能**对其执行下列操作：

- **改**：`PUT` 更新 body / 定义 / 元数据；技能内容 / 文件写入与删除；版本回退；改名（rename）。
- **删**：`DELETE`。
- **改权限**：`PUT /acl`（owner 转让、visibility 切换、授权成员增删）。
- **手工执行**：用户经路由（`POST /api/tasks`，含 JSON 与 multipart）启动内置工作流。
- **导入覆盖**：YAML / ZIP 导入按 name/id 命中内置行时覆盖它。

同时：

- **框架内部使用照常**：融合引擎经 service 层 `startTask` 驱动 `aw-skill-fusion`、`seedFusionResources` 播种 / 修复——这些路径**不得**被锁。
- **判别要抗漂移**：即便有人此前已把 owner 改走，也要能可靠识别并自愈，不能让"改 owner"成为绕过只读锁的后门。
- **保持隐藏**：内置行继续从用户列表隐藏（用户已确认不需要"可见但只读"的 UI 形态）→ **本 RFC 零前端改动**。
- **机制通用**：判别 + 守卫对五类资源（agent/skill/mcp/plugin/workflow）统一接入；当前仅 agent+workflow 有内置实例，其余为面向未来的 no-op，新增内置时一行扩展即可覆盖。

## 非目标

- 不做"可见但只读"的前端（用户已选"保持隐藏 + 服务端焊死"）。
- 不锁合成 / 不入库的系统 agent（commit / distiller）。
- 不给 skill/mcp/plugin 三张表预先加内置实例或列（无内置则无需要）；只保证机制能一行扩展。
- 不改融合的产品行为，只堵其资源被外部篡改的口子。

## 用户故事

1. **作为运维 / admin**，我在任何界面或直接打 API 都无法删除、修改、改权限、手工启动 `aw-skill-fusion` / `aw-skill-merger`；尝试时得到清晰的 403「内置资源只读」错误，而不是悄悄改坏了基础设施。
2. **作为用户**，我导入一份 YAML 工作流 / ZIP 技能时，即便它的 id/name 撞上内置资源，也只会被拒绝覆盖（提示改名或新建），绝不会把框架内置定义冲掉。
3. **作为框架自己**，融合任务仍能正常播种并运行内置 agent/workflow——只读锁只挡"外部入口"，不挡 service 层内部调用。
4. **作为接手的开发者**，若历史数据里内置行的 owner/visibility 曾被改乱，daemon 启动时能自动把它修回 `__system__` / `public`（或重新播种一条干净的内置行），系统自愈。

## 验收标准

- [ ] `PUT` / `DELETE` / rename / 技能内容&文件写删 / 版本回退命中内置 agent/workflow → **403 `builtin-readonly`**（admin、daemon token 一并拒绝）。
- [ ] `PUT /api/{res}/:id/acl` 命中内置行 → **403 `builtin-readonly`**；owner / visibility / grants 一概改不动。
- [ ] `POST /api/tasks`（JSON 与 multipart 两条分支）以内置工作流为 `workflowId` → **403 `builtin-readonly`**。
- [ ] `POST /api/workflows/import?onConflict=overwrite` 命中内置工作流 → 拒绝覆盖；skill ZIP overwrite 命中内置技能 → 拒绝（当前无内置技能，机制就位即可）。
- [ ] 融合端到端仍绿：`createFusion` → 播种 → 经 service `startTask` 跑内置 workflow/agent → reconcile/approve 全流程不受守卫影响。
- [ ] 抗漂移：把内置行 owner/visibility 用底层写改乱后，daemon 启动（或下次 `seedFusionResources`）能识别并修回 / 重新播种；判别器不依赖 owner 是否仍为 `__system__`。
- [ ] 内置行仍从 `GET /api/{agents,workflows}` 列表隐藏（RFC-101 行为保持）。
- [ ] `typecheck + test + format:check + 单二进制 smoke + e2e` 全绿；新增回归测试覆盖上述每条向量。
