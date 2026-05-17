# RFC-029 — 任务分解

> 配套文件：[proposal.md](./proposal.md) / [design.md](./design.md)

## PR 拆分建议

实施顺序硬约束:本 RFC 前端区段挂载在 RFC-027 的 `SessionTab.tsx` 内部,因此:

- **如果 RFC-027 已合并** → **默认单 PR**:全部 12 个子任务一次落,预估总 diff +1500 行(含测试 +400 行、binary embed base64 ~30KB)。
- **如果 RFC-027 未合并** → **强制拆 PR-A / PR-B**:
  - PR-A:T1 ~ T8(shared schema / DB / dump plugin embed / runner 注入 / services / REST / backend 全部单测)。functional 已可用,inventory 已经落库,但 UI 没出。可在 RFC-027 之前先合。
  - PR-B:T9 ~ T12(前端 Session 顶部区段 / i18n / 样式 / e2e / design 同步)。**必须等 RFC-027 合并后再开 branch**;否则没有 SessionTab 可以挂。

若 reviewer 嫌单 PR 太大,即使 RFC-027 已合并也可主动拆,拆点同上。

## 子任务清单

### RFC-029-T1 — shared 层 schema + 纯函数

- 新建 `packages/shared/src/inventory.ts`:`InventorySnapshotSchema`(discriminated union)、4 个子 schema、`InventoryReasonCode`。
- 实现 `normalizeInventoryRaw(raw)`(把 dump plugin 原始 JSON 兜默认值)、`inventoryReasonCode(err, ctx)`。
- 在 `packages/shared/src/index.ts` 加 barrel re-export。
- 测试:`tests/inventory-schema.test.ts` 8 case + `tests/inventory-normalize.test.ts` 8 case + `tests/inventory-reason-code.test.ts` 7 case。

依赖:无。

### RFC-029-T2 — DB migration + drizzle schema

- 新 migration `packages/backend/db/migrations/0014_rfc029_node_runs_inventory.sql`:`ALTER TABLE node_runs ADD COLUMN inventory_snapshot_json TEXT;`
- `packages/backend/src/db/schema.ts` 加列 `inventorySnapshotJson: text('inventory_snapshot_json')`。
- 跑 `bun run db:generate`,手工校正 `_journal.json` 链 + `meta/0014_snapshot.json` 一并提交。**实际现有编号**:0010 RFC-026 / 0011 RFC-028 / 0012 RFC-027 / 0013 RFC-030(untracked in-flight)/ 0014 本 RFC-029。
- 测试:`tests/migration-0014-inventory.test.ts` 3 case(列存在 / 老行 NULL / 新行写入)。

依赖:T1(类型);若 RFC-027 / RFC-028 也在 in-flight 需协调 migration 编号。

### RFC-029-T3 — dump plugin 源码 + binary embed 构建脚本

- 新 `packages/backend/src/opencode-plugin/aw-inventory-dump.ts`(source-of-truth,带类型注解,使用 `@opencode-ai/plugin` 类型)。
- 新 `packages/backend/scripts/build-inventory-plugin.ts`:用 `Bun.build` 把 source 打成单文件 ESM `.mjs`,base64 编码后写入 `packages/backend/src/opencode-plugin/embedded.ts`(模板 `export const AW_INVENTORY_DUMP_MJS = ...`)。
- `package.json` 加 `"prebuild": "bun run scripts/build-inventory-plugin.ts"`(只在 `bun build` 前跑;开发模式 watch 也跑一次)。
- 把生成的 `embedded.ts` 纳入 git,但同时 commit 一份 `.gitattributes` 标注 `embedded.ts -diff`(避免 PR review 时全部展开 base64 数据)。
- 测试:`tests/inventory-plugin-embed.test.ts` 3 case + `tests/inventory-transcode.test.ts` 8 case(transcoder 纯函数 export 出来给测试 import)。

依赖:T1。

### RFC-029-T4 — runner.ts 注入 inventory plugin + env

- `services/runner.ts` 在 spawn 前调 `ensureInventoryPlugin(runDir)` + 把 `file://...` 加进 `inlineConfig.plugin` + 设 `childEnv.OPENCODE_AW_INVENTORY_OUT`。
- non-agent kind 守门:`if (opts.nodeKind !== 'agent') return` 直接 skip 该路径。
- 测试:`tests/runner-inventory-integration.test.ts` 4 case(happy path 注入 / non-agent 不污染 inline.plugin / inline.plugin 已有其他条目时正确追加 / OPENCODE_PURE 时仍注但 service 端会兜底)。

依赖:T3。

### RFC-029-T5 — `services/inventory.ts` readSnapshot

- 新 `services/inventory.ts` 实现 `readSnapshotFromRunDir`。
- runner 在 child.exited 之后调用,写 `node_runs.inventorySnapshotJson`。
- 测试:`tests/inventory-service.test.ts` 6 case。

依赖:T1 / T2 / T4。

### RFC-029-T6 — REST 端点 `GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory`

- 新 `routes/inventory.ts` + 注册到 backend app。
- 复用 `isPromptCapableKind` 同款 helper 判 410(input/output/wrapper/review/clarify 全部 410)。
- 测试:`tests/routes-inventory.test.ts` 5 case。

依赖:T2 / T5。

### RFC-029-T7 — WS invalidation 兼容

- 在前端 `hooks/useTaskSync.ts` 的 invalidator 表里加一行 `['tasks', taskId, 'node-runs', nodeRunId, 'inventory']`,由现有 `node.run.updated` 事件触发。
- 后端不需要改 WS;只是确认 `node.run.updated` 在 inventory 落库后会被推一次(`updatedAt` 同时更新)。
- 测试:复用现有 WS sync 测试增 1 case 验证 inventory query key 被 invalidate。

依赖:T6。

### RFC-029-T8 — backend 集成自检

- 把 mock-opencode 加一个**加性** env `MOCK_OPENCODE_WRITE_INVENTORY_FROM=<fixture-path>`:stub 在退出前把 fixture 文件 copy 到 `$OPENCODE_AW_INVENTORY_OUT`,模拟真实 plugin 行为。
- 测试:`tests/runner-inventory-integration.test.ts` 用此 env 把 happy path 跑通。
- backend 自检:跑一遍 `bun test` 确保 RFC-026 / RFC-027 / RFC-028 测试不退化。

依赖:T4 / T5。

### RFC-029-T9 — 前端 `<RuntimeInventorySection />` 挂到 SessionTab 顶部

> **前置硬依赖**:RFC-027 SessionTab 必须已合并;`components/node-session/SessionTab.tsx` 已存在。

- 新文件 `components/inventory/RuntimeInventorySection.tsx`、`AgentsTable.tsx`、`SkillsTable.tsx`、`McpsTable.tsx`、`PluginsTable.tsx`、`StatusBadge.tsx`。
- 修改 `components/node-session/SessionTab.tsx`:在 `<AttemptsSwitcher />` 之后、`<ConversationFlow />` / `sessionNotApplicable` 占位之前,插入 `<RuntimeInventorySection nodeRunId={selectedAttempt.nodeRunId} nodeKind={nodeKind} />`。
- **不动 StatsTab.tsx**(grep 锁会断言 StatsTab 不含 RuntimeInventorySection)。
- 折叠 / 展开状态用 `useState` 持久化到组件实例,attempts 切换不重置。
- 测试:`tests/session-inventory-section.test.tsx` 6 case + `tests/session-tab-inventory-layout.test.tsx` 2 case(DOM 顺序断言)+ `tests/inventory-tables.test.tsx` 6 case + `tests/inventory-grep.test.ts` 5 源代码层锁(含 SessionTab.tsx 必 import + StatsTab.tsx 不出现)。

依赖:T6 + **RFC-027 SessionTab 已合并**。

### RFC-029-T10 — i18n + 样式

- `packages/frontend/src/i18n/zh-CN.ts` & `en-US.ts` 加 §4.3 列出的 ~30 个 key,zh-CN Resources 接口同步扩展。
- `styles.css` 加 §4.4 的 ~60 行 CSS。
- 测试:`tests/i18n-inventory.test.ts` 4 case(双语完整性 + 双侧 key set 等长)。

依赖:T9。

### RFC-029-T11 — e2e

- `e2e/main.spec.ts` 增 1 case:跑一个 agent 节点(stub-opencode 用 T8 同款 env 写预制 inventory 文件)→ 打开 NodeDetailDrawer → 默认在 Session tab → 顶部 Runtime Inventory 折叠区可见(看到 mini chip `A·N S·N M·N P·N`) → 点击展开 → 断言 agent 行 / mcp 行 / plugin 行 / skill 行可见 + 中英两种 lang 各跑一遍 status badge 文案;再切换到第二个 attempt(用 RFC-011 attempts switcher)→ Inventory 区段保留展开状态 + 内容按新 nodeRunId 重拉。
- 新 `e2e/fixtures/inventory-fixture.json` 作为 stub 用的预制 inventory 内容(含 1 agent + 2 skill + 1 mcp connected + 1 mcp needs_auth + 2 plugin)。

依赖:T9 / T10。

### RFC-029-T12 — design 同步 + STATE / plan 收尾

- 在 `design/plan.md` RFC 索引把 RFC-029 状态从 Draft → Done。
- 在 `STATE.md` "进行中 RFC" 段把 RFC-029 行移到 "最近完成 RFC(已 push)" 段,描述带上 commit hash / CI run 链接(参考 RFC-026 同款记录密度)。
- 在 `design/design.md`(总设计)的 `Task lifecycle` / `node_runs` 字段表里追加一行 `inventory_snapshot_json` 说明(让"DB 是 SoT"的总图继续有效)。
- 如果 PR-A / PR-B 拆分,T12 在 PR-B 收尾;若单 PR,T12 在合并前一次性写完。

依赖:T1 ~ T11 全部。

## 验收清单

合并前必须全部勾掉:

- [ ] shared 测试 ≥ 23(T1 三个文件)
- [ ] backend 测试 ≥ 32(migration 3 + service 6 + transcode 8 + plugin embed 3 + runner integration 4 + routes 5 + WS 复用 +1 = 30,留 2 容差)
- [ ] frontend 测试 ≥ 23(Session Section 6 + layout 2 + Tables 6 + i18n 4 + grep 5)
- [ ] e2e 新 1 case 跑通
- [ ] `bun run typecheck && bun run test && bun run format:check && bun run lint` 本地全绿
- [ ] CI 六 job 全绿(Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary smoke × {macos, ubuntu} + Playwright e2e × {macos, ubuntu})
- [ ] 多人协作守则:不删 RFC-027 / RFC-028 工作树中他人未追踪文件 / 进行中代码;并发 migration 编号通过手动调整 journal 链规避冲突
- [ ] `STATE.md` 与 `design/plan.md` RFC 索引同步更新
- [ ] 本 RFC 落地后,RFC-028 (Agent MCP) 的 owner 可凭 Stats → Inventory 现场验证 inline mcp 合并;在 PR description 里点名邀 RFC-028 owner review
