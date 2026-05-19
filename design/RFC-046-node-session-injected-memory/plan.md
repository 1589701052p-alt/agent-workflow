# RFC-046 — 任务分解

单 PR 即可承载（无 WS schema / 无 distill / 无 scheduler / 无 frontend route 新增）。
若 reviewer 偏好拆分，自然切分点是 backend (T1-T4) / frontend (T5-T7) 两 PR；
本 plan 默认单 PR。

## 依赖

- 基线：RFC-041 PR3（已 merge）— `injectMemoryForRun` + `formatMemoryBlock` 在 `services/memoryInject.ts`。
- 基线：RFC-027（已 merge）— `SessionTab.tsx` + `ConversationFlow.tsx`。
- 基线：RFC-042（已 merge）— `opts.envelopeFollowup` 路径。
- 不依赖：RFC-043 / RFC-045（互相正交）。

migration 编号需协调：若 RFC-043 落地编号 0024、RFC-045 占 0025，本 RFC 用 0026；
若顺序变化按当时实际续号，仅文档调整。

## 子任务

### RFC-046-T1 — shared schema

- 新增 `packages/shared/src/schemas/memory.ts` `InjectedMemorySnapshotSchema` + 同名 type 导出。
- `packages/shared/src/schemas/nodeRun.ts` (或现存 NodeRunSchema 定义点) 加可选字段 `injectedMemories`。
- `packages/shared/src/index.ts` barrel re-export 两枚新符号。
- 测试 +5（见 design §5.1 S1-S5）。

### RFC-046-T2 — DB migration

- `packages/backend/src/db/schema.ts` `nodeRuns` 表加 `injectedMemoriesJson: text('injected_memories_json')`（nullable，无默认）。
- `packages/backend/migrations/0026_node_runs_injected_memories.sql`（编号按落地实际续）：`ALTER TABLE node_runs ADD COLUMN injected_memories_json TEXT;`
- 测试 +2（design §5.2 M1-M2）。

### RFC-046-T3 — memoryInject 改造

- 新增 `loadInjectableMemoriesEnriched`：SELECT 多 4 列（version / tags / sourceKind / approvedAt），JSON.parse tags 兜底 [] + warn。
- 新增内部 `formatMemoryBlockWithSnapshot(set, budget)` 返回 `{ block, clippedSnapshot }`；保留旧 `formatMemoryBlock` 作为 thin wrapper（保留 grep guard、不改 byte 级输出）。
- 改造 `injectMemoryForRun` 返回 `{ block, snapshot }`。
- 新增 `loadInjectedSnapshotFromFirstAttempt(db, ctx)`：SELECT attempt 0 行 + parse 兜底。
- 测试 +4 (design §5.2 B1-B4)。

### RFC-046-T4 — runner.ts 接入

- snapshot 接收 + envelope-followup 分支 + 最终 UPDATE 加列。
- 改造点都在 runner.ts:320-341 现有 inject 块及其下方的 `node_runs` 最终 UPDATE 语句区。
- 测试 +6（design §5.2 R1-R6），含字节级 grep guard 守卫 `formatMemoryBlock` 输出不漂移。

### RFC-046-T5 — REST 端点

- `routes/tasks.ts` `rowToNodeRun` 内 parse `injectedMemoriesJson` → `injectedMemories`，坏 JSON 回 null + warn 不 5xx。
- 测试 +4（design §5.2 A1-A4）。

### RFC-046-T6 — 前端组件

- 新 `packages/frontend/src/lib/injected-memories-card.ts`：4 个纯函数。
- 新 `packages/frontend/src/components/node-session/InjectedMemoriesCard.tsx`：组件 + 纯函数引用。
- `SessionTab.tsx` mount 新卡片在 attempts 切换器之后、ConversationFlow 之前。
- i18n 中英 +10 key 双侧。
- styles.css 加 `.injected-memories-card` 命名空间。
- 测试 +10（design §5.3 F1-F10）+ 1（M1）+ 1（M2 源码 grep）= **+12**。

### RFC-046-T7 — 收尾

- `STATE.md` 顶部"进行中 RFC"行移到"最近完成 RFC"段（带 commit / CI 链接）；plan.md RFC 索引 RFC-046 状态 Draft → Done。
- `design/RFC-041-platform-long-term-memory/design.md` 末尾 §Follow-up 段加一行指向 RFC-046（"runtime inject 落库 + UI 见 RFC-046"），不改 RFC-041 主体。
- 本地 `bun run typecheck && bun run test && bun run format:check` 三件套全绿后 push；按 `feedback_post_commit_ci_check` 推完查 GitHub Actions run。

## 验收 checklist

- [ ] shared `InjectedMemorySnapshotSchema` round-trip + NodeRunSchema 兼容
- [ ] migration 0026 创建后 `injected_memories_json` 存在 nullable
- [ ] `injectMemoryForRun` 返回 `{ block, snapshot }`，block 字节级未变
- [ ] runner 正常 agent 落 N 条 JSON；envelope-followup 复制 attempt 0；non-agent kind 不落
- [ ] `GET /api/tasks/:id` runs[] 含 `injectedMemories` 字段
- [ ] `<SessionTab>` 顶部出现 `<InjectedMemoriesCard>`；DOM 顺序断言通过
- [ ] 三态文案（captured / empty / pre-rfc046）+ followup 锚点 chip 渲染正确
- [ ] i18n 中英 key 双侧 round-trip
- [ ] 三件套 typecheck / test / format:check 本地全绿
- [ ] CI 六 jobs 全绿（Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary smoke × {macos, ubuntu} + Playwright e2e × {macos, ubuntu}）
- [ ] STATE.md / plan.md 状态同步

## PR 提交

- commit message：`feat(memory): RFC-046 persist + display injected memories per node_run`
- body 简述：T1-T7 涵盖范围；列出新文件 / 改文件 / 测试增量；零 WS schema / 零 scheduler / 零 runner 行为变更（仅落库）。
- 由 RFC-041 owner 在 review 时确认 `formatMemoryBlock` 字节级守恒（grep guard 锁）即可放行。
