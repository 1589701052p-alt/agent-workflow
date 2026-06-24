# RFC-104 任务分解

单 PR 交付（后端 only，零前端）。commit 前缀：`feat(backend): RFC-104 内置资源只读锁`。

## 子任务

### RFC-104-T1 — 数据层：`builtin` 列 + 迁移
- `packages/backend/db/migrations/0049_rfc104_builtin_flag.sql`：给 `agents`/`workflows` 加 `builtin integer NOT NULL DEFAULT 0` + 回填两条内置行。
- `db/schema.ts`：两表加 `builtin` 布尔列。
- 依赖：无。

### RFC-104-T2 — 单一事实源：判别 + 守卫
- `services/systemResources.ts`：加 `isBuiltinRow` / `assertNotBuiltin('builtin-readonly')`；`excludeBuiltinAgents/Workflows` 改读 `builtin` 列；保留 name 常量供 seed。
- `services/resourceAcl.ts`：`AclRow` 加可选 `builtin?: boolean`。
- 依赖：T1。

### RFC-104-T3 — DTO / service 内部标志
- `services/workflow.ts`、`services/agent.ts`：行→DTO 映射带 `builtin`；`createWorkflow/createAgent` 接受内部 `builtin?: boolean` opt（默认 false）。
- shared `Workflow`/`Agent` 类型加 `builtin?: boolean`；`CreateXSchema` **不**含该字段。
- 依赖：T1。

### RFC-104-T4 — 播种自愈 + 取数去歧义
- `services/fusion.ts`：`seedFusionResources` 改"按 builtin 命中 + 漂移修复（底层 drizzle 修回 owner/visibility，必要时新建）"；创建时传 `builtin: true`。
- `fusionWorkflowId` 改按 `builtin && name` 命中。
- 依赖：T2、T3。

### RFC-104-T5 — 路由 / service 守卫接入
- agents/skills/mcps/plugins/workflows 各 mutation 路由（PUT/DELETE/rename/content/file/restore/check-update/upgrade）插 `assertNotBuiltin`。
- `routes/resourceAcl.ts` ACL PUT 插守卫（五类统一）。
- `routes/tasks.ts` JSON 启动分支 + `handleMultipartTaskStart` 启动分支插 `assertNotBuiltin('workflow', wf)`。
- `services/workflow.yaml.ts` overwrite 分支插守卫；`services/skill-zip.ts` overwrite 分支加内置拒绝。
- 依赖：T2、T3。

### RFC-104-T6 — 测试
- 新增 `tests/rfc104-builtin-readonly.test.ts`（design §8 的 1–9 全覆盖）。
- 更新 `tests/rfc101-builtin-list-hidden.test.ts` 为列驱动 + owner-漂移仍隐藏断言。
- 源码层文本锚点兜底。
- 依赖：T1–T5。

### RFC-104-T7 — 收尾
- `design/plan.md` RFC 索引置 Done；`STATE.md` 已完成表 +1 行、移除"进行中 RFC"。
- 依赖：T1–T6。

## PR 拆分建议
单 PR。T1→T2/T3→T4/T5→T6 顺序提交于同一分支（本仓 main 直推）。

## 验收清单（映射 proposal）
- [ ] 改/删/改名/技能写删/版本回退命中内置 → 403（含 admin/daemon）。
- [ ] ACL PUT 命中内置 → 403（owner/visibility/grants 全锁）。
- [ ] `POST /api/tasks` JSON + multipart 启动内置工作流 → 403。
- [ ] YAML overwrite 拒绝覆盖内置工作流；ZIP overwrite 拒绝覆盖内置技能。
- [ ] 融合端到端仍绿（service `startTask` 不被锁）。
- [ ] 漂移自愈：seed 修回 owner/visibility 或重建。
- [ ] 内置仍从列表隐藏。
- [ ] `typecheck + test + format:check` + binary smoke + e2e 全绿。
