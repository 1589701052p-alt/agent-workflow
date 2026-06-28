# RFC-121 任务分解

> 单 PR（纯前端、零迁移、改动面集中）。子任务按依赖排序，便于审阅。

## 子任务

- **RFC-121-T1 收件箱去 fusion + memory**（D1+D2）
  `components/shell/InboxDrawer.tsx`：`InboxTab`/`InboxItem.kind` 收窄到 review|clarify；删 memoryQuery/fusionsQuery/canSeeMemory/memoryActionKey；删 items 两分支 + 错误行 + 导航分支 + 行内特判；tab 固定三项；删死 import。
  依赖：无。

- **RFC-121-T2 收件箱徽标去 fusion**（D3）
  `components/shell/InboxFooterButton.tsx`：删 fusions 查询，total/allFailed 收窄。
  依赖：无。

- **RFC-121-T3 记忆页「融合」tab + 列表组件**（D4+D9）
  新 `components/memory/MemoryFusionList.tsx`（复用 EmptyState/LoadingState/ErrorBanner，行点击 → `/fusions/$id`，15s 轮询）；`routes/memory.tsx` 加 `'fusion'` 到 `MemoryTab`/`TABS`/`tabLabel` + 渲染分支。
  依赖：T7（i18n 键）。

- **RFC-121-T4 侧栏记忆徽标计入融合**（D5）
  `components/shell/MemoryPendingBadge.tsx`：候选查询仍 admin-only；新增融合 pending-count 查询（全员 enabled）；total = 候选 + 融合；total>0 才渲染。
  依赖：无（`/api/fusions/pending-count` 已存在）。

- **RFC-121-T5 `/fusions/*` 分组高亮归记忆组**（D6）
  `lib/nav.ts`：`resolveActiveNav` fallback 加 `/fusions` → `memory`。
  依赖：无。

- **RFC-121-T6 测试**（随 T1–T5 落地）
  改 `inbox-drawer.test.tsx`、`inbox-footer-button.test.tsx`、`inbox-pending-memory-group.test.tsx`（转回归）、`nav.test.ts`；新 `memory-fusion-tab.test.tsx`、`memory-pending-badge.test.tsx`（如无）、`inbox-drawer` 源码文本断言。
  依赖：T1–T5。

- **RFC-121-T7 i18n 增删对称**（D7）
  `i18n/zh-CN.ts` + `i18n/en-US.ts`：增 `memory.tab.fusion` + `memory.fusion.*`；删死的 `nav.inbox.{tabFusion,fusionTitle,fusionSubtitle,errorFusion,memoryItemSubtitle}`（删前 grep 确认无引用）。
  依赖：T1（确认 inbox 键确已无引用方）。

## 验收清单

- [ ] 收件箱只 all/reviews/clarify 三 tab；fusion/memory 数据不泄漏进 drawer（含 all）。
- [ ] 收件箱 footer 徽标 = reviews + clarify。
- [ ] 记忆页有「融合」tab；列 awaiting_approval；行点击进详情；空/错/loading 三态正确。
- [ ] 侧栏记忆徽标 = 候选(admin) + 融合(admin/owner)；非 admin owner 有融合时出现。
- [ ] `resolveActiveNav('/fusions/x').activeGroup === 'memory'`。
- [ ] i18n zh/en 对称，所有 parity/symmetry 测试绿；无悬挂键引用。
- [ ] `bun run typecheck` 零错误；前端 vitest 全绿；`bun run format:check` 净。
- [ ] Codex 设计 gate（落档后）+ 实现 gate findings 全 fold。
- [ ] CI 全绿（lint+typecheck+test ×2 OS + binary smoke + Playwright e2e）。

## PR 拆分

单 PR：`feat(frontend): RFC-121 记忆/融合待办移出收件箱、归并记忆页面`。改动面=前端 5 文件 + 1 新组件 + i18n×2 + 测试，原子提交。
