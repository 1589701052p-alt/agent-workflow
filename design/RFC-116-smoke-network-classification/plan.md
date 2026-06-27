# RFC-116 任务分解

## 子任务

- **RFC-116-T1（后端核心）**：`services/runtimeSmoke.ts`
  - `SmokeOutcome` 加 `'network-blocked'`。
  - 加 `NETWORK_SIGNATURES`（见 design §3）。
  - 分类链插 `networkHit` 分支，**置于 `authHit` 之前**。
  - network-blocked 的 `detail`（网络/代理指引）。
  - 更新 `:286-289` 注释。

- **RFC-116-T2（后端测试）**：`tests/runtime-smoke.test.ts`
  - 改造 `:155-174` 的 403 case 断言 → `network-blocked`（+ 注释链回本 RFC）。
  - 新增真鉴权 case（`Invalid API key`）→ `auth-missing`。
  - 新增纯网络 case（`fetch failed` / `ENOTFOUND`）→ `network-blocked`。
  -（可选）opencode stderr `ECONNREFUSED` → `network-blocked`。

- **RFC-116-T3（前端 + i18n）**：
  - `components/RuntimeList.tsx`：`outcome` union 加成员；`smokeChipKind` 把 `network-blocked` 归 `warn`。
  - `i18n/en-US.ts` + `i18n/zh-CN.ts`：`smoke` 类型 + 值加 `network-blocked`。
  - `tests/runtime-list.test.tsx`：渲染 + kind 断言。

- **RFC-116-T4（文档勘误 + 登记）**：
  - `runtimeSmoke.ts:205-211` / `tests/runtime-smoke.test.ts:148-154` 注释勘误（proxy-blocked → network-blocked）。
  - `design/plan.md` RFC 索引登记本条。
  - `STATE.md` 顶部「进行中 RFC」→ 完工改 Done + 已完成表加行。

## 依赖

`T1 → T2`、`T1 → T3`（类型先落）；`T4` 收尾。

## PR 拆分

**单 PR**（改动小且原子：后端分类 + 前端展示 + i18n + 测试一起才自洽，分开会留中间不一致态）。commit message 前缀：`feat(backend,frontend): RFC-116 runtime smoke 网络受阻分类 network-blocked`。

## 验收清单

- [ ] 后端 4 必写 case（design §6.1–6.4）全绿。
- [ ] 前端 network-blocked chip 渲染 + warn kind 测试绿。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] Codex 设计 gate（实现前）findings 全 fold。
- [ ] Codex 实现 gate（push 前）findings 全 fold。
- [ ] push 后 GitHub Actions（typecheck + backend test + frontend vitest + binary smoke + e2e）success。
- [ ] `STATE.md` 与 `design/plan.md` 索引更新。
