# RFC-030 — 任务分解

> 子任务前缀 `RFC-030-T*`。默认单 PR；若 diff > ~1500 行可按 §"PR 拆分建议" 拆 2 个。

## 任务列表

### RFC-030-T1 — shared schema + 类型导出
- **What**：新文件 `packages/shared/src/schemas/mcpProbe.ts`，导出 `McpToolInfoSchema` / `McpResourceInfoSchema` / `McpResourceTemplateInfoSchema` / `McpPromptInfoSchema` / `McpProbeErrorCode` / `McpProbeSchema`；在 `packages/shared/src/index.ts` 出口。
- **Tests**：`packages/shared/tests/mcp-probe-schema.test.ts`：
  - tool 必填 `name`；title/description/inputSchema 可选。
  - errorCode 枚举外的值 → reject。
  - probe schema 接受 nullable + strict（多字段断言）。
- **Deps**：—
- **Size**：S

### RFC-030-T2 — DB schema + migration
- **What**：`packages/backend/src/db/schema.ts` 末尾新增 `mcp_probes` 表（`mcpId` UNIQUE + FK + ON DELETE CASCADE）。`drizzle-kit generate` 生成 `db/migrations/00NN_rfc030_mcp_probes.sql`（编号续 RFC-029 实际占用的之后；落地时 grep `_journal.json` 取下一可用编号）。
- **Tests**：`packages/backend/tests/migration-00NN-mcp-probes.test.ts`：
  - migration 跑完后表存在 + 列与索引齐。
  - 插入一行 probe，删父 mcp → probe 行自动消失（CASCADE 锚）。
- **Deps**：T1
- **Size**：S

### RFC-030-T3 — 后端依赖引入
- **What**：`packages/backend/package.json` 加 `@modelcontextprotocol/sdk`，版本对齐 opencode 仓库当前锁定的同名 dep（grep `/Users/wangbinquan/Documents/code/opencode/bun.lock` 取）。`bun install`。
- **Tests**：`packages/backend/tests/deps-mcp-sdk-present.test.ts` —— 仅 import 几个核心类（`Client` / `StdioClientTransport` / `StreamableHTTPClientTransport`）确保 resolution 通过；防止 lockfile 漂移导致引入失败。
- **Deps**：—
- **Size**：S

### RFC-030-T4 — services/mcpProbe.ts 核心（含 in-flight 守卫 + redact + 隔离）
- **What**：新文件 `packages/backend/src/services/mcpProbe.ts`。导出 `probeMcp(db, mcp): Promise<ProbeRowOut>` + 内部 `inflight` Map。
  - stdio: 用 `StdioClientTransport`，env = minimal (`PATH`/`HOME`/`LANG`) + `mcp.config.env`；**禁止**继承 daemon 任何凭据 env。
  - http: 用 `StreamableHTTPClientTransport`，失败 4xx 时 fallback `SSEClientTransport`（与 opencode mcp/index.ts:332/795 同语义）。
  - timeout：单 list 调用走 `mcp.config.timeoutMs ?? 30_000`；整体 probe 60s 硬上限 + AbortController。
  - 错误归一化：六种 code（按 design §6 表）。
  - finally：transport.close + stdio child kill（unref 后再 SIGTERM，避免僵尸）+ 从 inflight 摘除。
  - 写入：调 `services/mcpProbeStore.upsertProbe`。
- **Tests**：`packages/backend/tests/services/mcpProbe.test.ts`（**密度高**）：
  - mock SDK 注入：成功完整 → status=ok + tools/resources/resourceTemplates/prompts 全有。
  - listResources rejected → status=ok + errorCode=partial + resourcesJson=null + errorDetail.partialFailures 含 method。
  - initialize 超时（fake timer） → handshake-failed + handshakeMs ≈ 30000。
  - SDK `UnauthorizedError` → auth-required。
  - http 401 mock → auth-required。
  - http 5xx mock → connect-failed。
  - mcp.enabled=false → throw `mcp-disabled` 且**无 transport 实例被构造**（spy 断言）。
  - 总超时 → timeout + transport.close 至少调一次。
  - in-flight 复用：并发两次 probeMcp(same mcp) → 第二次返回与第一次同 Promise；mock transport 工厂只被调一次。
  - **redact 锚**：errorDetail.stderr 输入 `"PG_URL=postgresql://user:secret@h/db"` → 入库 errorDetailJson 不含 `secret`。
  - **隔离锚**：mock 注入 `process.env.SOME_FAKE_TOKEN='x'` 后断言 spawn env **不含** `SOME_FAKE_TOKEN`。
  - **字段名兜底**：从 mcp.config 读 `env` / `timeoutMs`（DB 字段名），**不读** opencode wire 名 `environment` / `timeout`（防回归把读/写两端搞混）。
- **Deps**：T1, T2, T3
- **Size**：L

### RFC-030-T5 — services/mcpProbeStore.ts
- **What**：新文件 `packages/backend/src/services/mcpProbeStore.ts`：`listProbes(db)`（LEFT JOIN mcps，输出 mcpName）/ `getProbe(db, name)` / `upsertProbe(db, mcpId, result)`。INSERT ... ON CONFLICT(mcp_id) DO UPDATE。
- **Tests**：`packages/backend/tests/services/mcpProbeStore.test.ts`：
  - upsert idempotent，二次 probe 覆盖（latencyMs 变化可观察）。
  - getProbe 缺失 → null。
  - listProbes 输出按 mcpName 排序稳定。
- **Deps**：T2
- **Size**：S

### RFC-030-T6 — routes/mcps.ts 扩展
- **What**：`packages/backend/src/routes/mcps.ts` 增三条：
  - `GET /api/mcps/probes` → listProbes。
  - `GET /api/mcps/:name/probe` → getProbe | 404。
  - `POST /api/mcps/:name/probe` → probe + 200（含 status=error 情况）；mcp-disabled / mcp-not-found 走 422 / 404。
- **Tests**：`packages/backend/tests/routes/mcps-probe.test.ts`：
  - GET probes 空 → []。
  - GET 单 probe 缺失 → 404。
  - POST disabled → 422。
  - POST mcp 不存在 → 404。
  - POST probe 失败（mock service throw probe-internal）→ **200 + status=error**（关键回归锚：不抛 5xx）。
  - POST 鉴权：缺 token → 401（与现有 mcps 路由一致）。
- **Deps**：T4, T5
- **Size**：S

### RFC-030-T7 — 集成测：mock stdio + mock http server
- **What**：
  - `packages/backend/tests/fixtures/mock-mcp-stdio.ts`：用 `@modelcontextprotocol/sdk/server` 起最小 server，bin shim 通过 `process.argv` 选择 "正常"/"超时"/"crash" 三种 mode。
  - `packages/backend/tests/fixtures/mock-mcp-http.ts`：Bun.serve 起最小 streamable http endpoint。
  - `packages/backend/tests/mcp-probe-stdio-integration.test.ts`：起真实子进程 → probe → 断言 tools.length===4 + 第一个 tool 的 inputSchema 字段。
  - `packages/backend/tests/mcp-probe-http-integration.test.ts`：起 http server → probe → 断言全程 < 5s。
- **Tests**：（本任务就是 tests）
- **Deps**：T4
- **Size**：M

### RFC-030-T8 — 前端 list 页改动 + Probe chip + 行展开
- **What**：
  - `packages/frontend/src/components/McpProbeStatusChip.tsx` —— 四态 chip + 颜色 + aria-label。
  - `packages/frontend/src/lib/mcp-probe-query.ts` —— `useMcpProbes` / `useMcpProbe(name)` / `useProbeMcpMutation(name)`；mutate 完 invalidate `['mcps','probes']` + `['mcps',name,'probe']`。
  - 改 `packages/frontend/src/routes/mcps.tsx`：列表 fetch 改用 `useMcps + useMcpProbes` 合并；新增三列；行内 ▶ 展开（受控 state，本次会话级，不持久化）；展开块 chip 列出最多 12 个 tool 名 + "+N more"；右侧 "重新探测" / "查看完整接口"。
- **Tests**：
  - `packages/frontend/tests/mcp-probe-status-chip.test.ts`：四态 class + aria-label。
  - `packages/frontend/tests/mcps-list-probe-columns.test.tsx`：列渲染 + 行展开 + 工具 chips 截断 + 重新探测按 mutate。
  - `packages/frontend/tests/locks/mcps-list-no-hardcoded-i18n.test.ts`：源码不含硬编码状态文案（防回归到非 i18n）。
- **Deps**：T6
- **Size**：M

### RFC-030-T9 — 前端 detail 页 Inventory 面板
- **What**：
  - `packages/frontend/src/components/mcps/McpInventoryPanel.tsx`：顶部 chip + 最近探测 + 延时 + 重新探测按钮；Tools / Resources / Prompts / Capabilities 四折叠段；错误态错误框可展开 errorDetail JSON viewer。
  - `packages/frontend/src/components/mcps/McpToolRow.tsx`：tool 行 + description + inputSchema 折叠 `<pre><code>`（不引新库）。
  - `routes/mcps.detail.tsx` 在 `<McpFields />` 下渲染 `<McpInventoryPanel />`，挂 `#inventory` 锚点。
- **Tests**：
  - `packages/frontend/tests/mcp-inventory-panel.test.tsx`：tools / resources / prompts 三段渲染；error 态错误框可展开 detail。
  - `packages/frontend/tests/mcp-tool-row.test.tsx`：inputSchema 折叠 / 展开。
  - `packages/frontend/tests/locks/mcp-inventory-panel-i18n.test.ts`：源码不含硬编码中英文字串。
- **Deps**：T8
- **Size**：M

### RFC-030-T10 — i18n key 同步
- **What**：`packages/frontend/src/i18n/zh-CN.ts` / `en-US.ts` 同步新增 §design 4.4 列出的所有 key。
- **Tests**：`packages/frontend/tests/i18n-key-parity.test.ts`（若已有）扩展 → mcps.probe.* 完全对齐；缺一即红。无该测试则新建。
- **Deps**：T8, T9
- **Size**：S

### RFC-030-T11 — e2e + 文档同步
- **What**：
  - `packages/frontend/tests/e2e/mcp-probe.spec.ts`（见 design §7.5 四步）。
  - `design/plan.md` RFC 索引行：新增 RFC-030 条目（Draft → 落地后改 Done）。
  - `STATE.md` 顶部"进行中 RFC"加一行指向本 RFC；完工后追加到已完成表。
  - 视情更新 `packages/backend/README.md` 一句话提到 "MCP 接口探测见 /mcps 列表"。
- **Tests**：e2e 通过；CI 三件套全绿。
- **Deps**：T1–T10
- **Size**：M

## 依赖图

```
T1 ── T2 ── T5
T1 ── T3 ── T4 ──┬── T6 ── T7
                 │
                 └── T8 ── T9 ── T10
T1..T10 ── T11
```

## PR 拆分建议

默认**单 PR**（commit message：`feat(mcp): RFC-030 MCP 接口探测与能力清单`）。原因：

- 后端无前端入口时纯 API 没意义；前端无后端会全部跑 404；分两 PR 反而长尾。
- 单 PR 易回滚（一次 revert 全删，含 `mcp_probes` migration 的反向）。

**若 diff > ~1500 行**才拆：

1. PR-A：T1–T7（shared + DB + service + route + 集成测），前端不暴露入口（feature gate 用 i18n key 是否落地区分，缺则隐藏新列）。
2. PR-B：T8–T11（前端 + e2e + 文档），落地后清 flag。

## 验收清单（PR 合并前 self-check）

- [ ] T1–T11 全部完成，每条都有对应 commit + 测试。
- [ ] `bun run typecheck` ✅
- [ ] `bun run test` ✅（含新增单测 + 集成测）
- [ ] `bun run format:check` ✅
- [ ] e2e `mcp-probe.spec.ts` ✅
- [ ] zh-CN / en-US i18n key 同步，无 missing key warning。
- [ ] `design/plan.md` RFC 索引行新增并状态正确。
- [ ] `STATE.md` 同步（进行中 / 已完成两处）。
- [ ] PR 描述列出新 API、UI 截图（list 行展开 + detail 面板）、回滚路径（drop `mcp_probes` 表 + 反向 migration）。
- [ ] 推完后按 `[feedback_post_commit_ci_check]` 立刻查 GitHub Actions 状态，红的修绿再走。
- [ ] **凭据 redact 锚测试**确实跑过（保证 stderr 入库不留 token）。
- [ ] **隔离锚测试**确实跑过（保证 spawn env 不继承 daemon 凭据）。
