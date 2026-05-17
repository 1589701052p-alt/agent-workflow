# RFC-035 — UX 一致性专项 · 任务分解

> **参考**：[`proposal.md`](./proposal.md) 产品视角 + [`design.md`](./design.md) 技术设计 + [`../ux-audit.md`](../ux-audit.md) 权威背景。
>
> **PR 拆分原则**：每个 PR 自洽可独立 revert / 自带测试 / 单 commit message 前缀 `feat(ux): RFC-035 PR{N} — 标题`。
>
> **依赖序**：等 RFC-032 全 3 PR 落到 origin/main 后再启动 RFC-035 PR1，避免与 RFC-032 PR3 Homepage 同时改 `styles.css` 大段冲突。RFC-035 PR1 → PR2 → PR3 按顺序推，每个 PR push 后等 CI 全绿（按 `[feedback_post_commit_ci_check]` 规则）。

---

## 总览

| PR | 标题 | 主要交付 | 估测试增量 | 估代码增量 |
| --- | --- | --- | --- | --- |
| PR1 | Foundation — tokens + ghost/xs + StatusChip 收敛 | 设计 token + `.btn--ghost/--xs` CSS + `<StatusChip>` 组件 + 4 个分散组件 retrofit | ~30 case | styles.css +60 / -10；新组件 +60 行；4 retrofit 各 -10 +10 |
| PR2 | Form / Tabs / Table 推广 | `.tabs --modifier` 收敛 + `.data-table` 推广 + `<Form>` 7 路由迁移 | ~25 case | styles.css +30 / -0；7 路由各 ~30-80 行 jsx 改写 |
| PR3 | Dialog / EmptyState / LoadingState / DetailLayout 抽出 + 内联 style 清理 | 4 个新共享组件 + retrofit 4 dialog / 9 empty-loading / 2 detail-layout + settings 内联 style 清理 | ~40 case | 新组件 +200 行；retrofit 净 -300 行（旧 dialog 结构删大半）；styles.css +120 / -0（旧类作 fallback） |

合计 ~95 测试用例；styles.css 净 +210 行（cleanup PR 后预估 -500 行）。

---

## PR1 — Foundation

> 依赖：RFC-032 全 3 PR 全部落到 `origin/main` + CI 绿。
> 单 PR 内顺序：T1 → T2 → T3..T6 平行 → T7..T9 串行 → T10 测试 → T11 文档收尾。

### T1 — 引入设计 token + .stack utility

- 文件：`packages/frontend/src/styles.css`
- 改动：
  - `:root` 块顶部追加 `--space-1..6` / `--font-xs..xl` / `--radius-sm..pill` / `--shadow-sm..lg` / `--success` / `--success-bg` / `--warn` / `--warn-bg` / `--info` / `--info-bg`
  - `:root[data-theme='dark']` 块同步覆写 `--success` / `--warn` / `--info`（dark 取值 `#3fb959` / `#f0a020` / `var(--accent)`）+ shadow 复用 light 值（视觉差异小，本 RFC 不深调）
  - `@media (prefers-color-scheme: dark) :root:not([data-theme])` 兜底块同步
  - 新增 `.stack--sm` / `.stack--md` / `.stack--lg` / `.stack-top--sm` / `.stack-top--md` / `.stack-top--lg`
- 测试：`packages/frontend/tests/styles-tokens.test.ts`
  - 读 styles.css 文本 + 每个 token name 存在 + 暗色覆写命中

### T2 — 补 .btn--ghost / .btn--xs

- 文件：`packages/frontend/src/styles.css`
- 改动：在 `.btn--armed` 之后追加 `.btn--ghost{,:hover}` / `.btn--ghost.btn--danger{,:hover}` / `.btn--xs` 共 ~20 行
- 测试：
  - `tests/btn-variants-styles.test.ts`：`.btn--ghost {` / `.btn--xs {` 在 styles.css 各出现 1 次
  - `tests/btn-variants-callsite.test.ts`：9 处 callsite 出现（路径 + 类名清单见 design.md §2）

### T3 — 新增 <StatusChip> 组件

- 文件：`packages/frontend/src/components/StatusChip.tsx` 新建（~50 行）
- API 见 design.md §3.1
- 测试：`tests/status-chip.test.tsx` 10 case：
  - 5 kind × 2 size 渲染 className 锚
  - `withDot=true` 渲染 dot
  - `aria-label` + `title` 路径 + `role="status"` 触发
  - `data-testid` 路径

### T4 — styles.css 中 .status-chip 改造（保留 5 旧 alias）

- 文件：`packages/frontend/src/styles.css`
- 改动：
  - `.status-chip` 主块改用 `--font-sm` / `--radius-lg` / `--space-1` token
  - 新增 5 个语义 modifier（`--success` / `--warn` / `--danger` / `--info` / `--neutral`）
  - 现有 5 个旧 modifier（`--gray` / `--blue` / `--green` / `--red` / `--amber`）改为 alias，颜色源走新语义 token
  - 新增 `.status-chip--sm` / `.status-chip--md` / `.status-chip__dot`
- 测试：在 T3 测试里同时锚 `.status-chip--{kind}` CSS 存在

### T5 — retrofit <TaskStatusChip>

- 文件：`packages/frontend/src/components/TaskStatusChip.tsx`
- 改动：用 `<StatusChip kind={KIND[status]}>` 替代直接 className 拼接；KIND 表见 design.md §3.3
- 测试：`tests/task-status-chip.test.tsx` 修改（不是新建）—— 用 `kind` prop 锚 + 8 status × kind 映射

### T6 — retrofit <StatusBadge>（inventory）

- 文件：`packages/frontend/src/components/inventory/StatusBadge.tsx`
- 改动：`<span className={`status-badge status-badge--${bucket}`}>` → `<StatusChip kind={mapBucket(bucket)}>`；bucket → kind 直映射
- 测试：`tests/inventory-status-badge.test.tsx` 修改 —— 用 `<StatusChip>` 锚 + bucket 路径

### T7 — retrofit <McpProbeStatusChip>

- 文件：`packages/frontend/src/components/McpProbeStatusChip.tsx`
- 改动：用 `<StatusChip kind={...} withDot={status==='probing'}>` 替代；保留 `data-testid=mcp-probe-status-${status}`
- 测试：`tests/mcp-probe-status-chip.test.tsx` 修改 —— 4 status × kind 映射

### T8 — retrofit homepage task-row__status

- 文件：`packages/frontend/src/components/home/task-row.tsx`
- 改动：内联 `<span className={`task-row__status task-row__status--${task.status}`}>` 改为 `<StatusChip size="sm" kind={KIND[task.status]}>`；KIND 表共享 T5 TaskStatusChip 映射（提到 `lib/task-status.ts` 公共 helper 或重复声明二选一——本 RFC 选**提取** `lib/task-status.ts`，让两个调用点导入同一映射表）
- 新增 `packages/frontend/src/lib/task-status.ts`：
  ```tsx
  export const TASK_STATUS_KIND: Record<TaskStatus, StatusChipKind> = { … }
  ```
- TaskStatusChip + task-row 都 import 这个表
- 测试：`tests/task-status-kind.test.ts`（纯函数测试）+ `tests/homepage-task-row-status.test.tsx`（修改既有：用 `<StatusChip>` 锚 + 映射正确）

### T9 — 删除旧 .mcp-probe-chip / .status-badge inline 视觉（CSS 保留）

- 文件：`packages/frontend/src/styles.css`
- 改动：仅删除"业务文件实际不再用"的 inline CSS 标记（保留 fallback class 定义本身，等 cleanup PR 删）；本 PR 不动 styles.css 中这两块
- 测试：`tests/status-chip-grep.test.ts`：
  - `<StatusChip` 在 `TaskStatusChip.tsx` / `StatusBadge.tsx` / `McpProbeStatusChip.tsx` / `task-row.tsx` 各 ≥ 1 次
  - `status-badge {` `mcp-probe-chip {` 在 styles.css 仍存在（fallback 保留）

### T10 — 集成测试 + 类型检查

- `bun run typecheck` 三 package
- `bun run --filter frontend test`：1340+30 ≈ 1370 case 全绿
- `bun run format:check` clean
- `bun run lint` clean

### T11 — 文档收尾

- `STATE.md` 顶部"进行中 RFC"块的 RFC-035 行从"Draft 已展开"改为"PR1 落地"
- `design/plan.md` 索引把 RFC-035 状态从 Draft → In Progress（PR2/PR3 后改 Done）
- commit message：`feat(ux): RFC-035 PR1 — design tokens + btn--ghost/--xs + <StatusChip> 收敛`
- push + 按 `[feedback_post_commit_ci_check]` 立刻查 CI 状态

### PR1 验收 checklist

- [ ] T1..T11 全部完成
- [ ] `tests/styles-tokens.test.ts` 全绿
- [ ] `tests/btn-variants-{styles,callsite}.test.ts` 全绿
- [ ] `tests/status-chip.test.tsx` 10 case 绿
- [ ] `tests/{task-status-chip,inventory-status-badge,mcp-probe-status-chip,homepage-task-row-status}.test.tsx` 修改后全绿
- [ ] `tests/status-chip-grep.test.ts` 4 个 retrofit 组件均出现 `<StatusChip>`
- [ ] CI 六 job 全绿（Lint+Typecheck+Test × 2 OS + Build smoke × 2 + Playwright × 2）
- [ ] 视觉抽样验证（本地启 dev server）：`/agents` 列表 status chip / `/mcps` 列表 probe chip / `/` 首页 task-row chip 视觉对齐

---

## PR2 — Form / Tabs / Table 推广

> 依赖：PR1 落地 + CI 绿 + token 在 origin/main 可用。
> 单 PR 内顺序：T12 → T13..T15 平行（tabs）→ T16..T18 平行（data-table）→ T19..T25 串行（form 7 路由）→ T26 测试 → T27 文档。

### T12 — .tabs --modifier CSS

- 文件：`packages/frontend/src/styles.css`
- 改动：在 `.tabs__tab--active` 之后追加 `.tabs--inline` / `.tabs--inspector` / `.tabs--segment` 三个 modifier 块
- 测试：`tests/tabs-modifier.test.tsx` 渲染 3 modifier × `--active` 翻转

### T13 — retrofit NodeDetailDrawer + NodeInspector tabs class

- 文件：`packages/frontend/src/components/NodeDetailDrawer.tsx` + `packages/frontend/src/components/canvas/NodeInspector.tsx`
- 改动：`<div className="tabs inspector__tabs">` → `<div className="tabs tabs--inspector">`
- 测试：现有 NodeDetailDrawer / NodeInspector 测试不退化（用 `role="tab"` 锚）

### T14 — retrofit AgentImportDialog tabs class

- 文件：`packages/frontend/src/components/AgentImportDialog.tsx`
- 改动：`agent-import__tabs` → `tabs tabs--inline`；`agent-import__tab` / `.is-active` → `tabs__tab` / `tabs__tab--active`
- 测试：`tests/agent-import-dialog.test.tsx` 不退化（用 `role="tab"` 锚）

### T15 — retrofit RepoSourceTabs class

- 文件：`packages/frontend/src/components/launch/RepoSourceTabs.tsx`
- 改动：`.repo-source-tabs__bar` → `.tabs.tabs--segment`；`.repo-source-tabs__tab.is-active` → `.tabs__tab.tabs__tab--active`
- 测试：现有 RepoSourceTabs 测试不退化

### T16 — retrofit repos.tsx .repos-table → .data-table

- 文件：`packages/frontend/src/routes/repos.tsx`
- 改动：表格 `<table className="repos-table">` → `<table className="data-table">`；行内 chip 走 `<StatusChip>`（PR1 已经引入，retrofit 现有行）
- 测试：`tests/repos-page.test.tsx` 不退化；新增 `tests/repos-data-table.test.tsx` 锚 `<table className="data-table">` 出现

### T17 — retrofit AgentImportDialog .agent-import__table → .data-table--compact

- 文件：`packages/frontend/src/components/AgentImportDialog.tsx`
- 改动：导入预览 table 用 `.data-table .data-table--compact`；保留 `.agent-import__field/__value/__filename/__route` 业务子样式
- styles.css 新增 `.data-table--compact` modifier
- 测试：`tests/agent-import-dialog.test.tsx` 不退化 + 新一行断言 `data-table` 类出现

### T18 — retrofit reviews.tsx .reviews-row → .data-table

- 文件：`packages/frontend/src/routes/reviews.tsx`
- 改动：`.reviews-row__*` 改为 `<table className="data-table">` + 行展开走 `.data-table--expandable` / `.data-table__expanded-row`
- styles.css 新增 `.data-table--expandable`（PR2，不在 PR1 引入避免 token-only 散乱）
- 测试：`tests/reviews-page.test.tsx` 不退化 + 新增 `tests/reviews-data-table.test.tsx`

### T19..T25 — Form helper 推广（7 路由）

每个子任务一个路由：

- T19 `routes/agents.new.tsx`（可能间接动 `components/AgentForm.tsx`）
- T20 `routes/agents.detail.tsx`
- T21 `routes/plugins.new.tsx`
- T22 `routes/plugins.detail.tsx`
- T23 `routes/mcps.new.tsx`
- T24 `routes/mcps.detail.tsx`
- T25 `routes/clarify.detail.tsx` 提交答案 fragment

每个子任务：

- 改动：用 `<Form.Field label hint required>` + `<TextInput>` / `<NumberInput>` / `<TextArea>` / `<Switch>` 替代手拼 `<label>` + `<input>`
- 测试：新建 `tests/{route}-form-helper.test.tsx`：
  - 源代码层断言 `from '@/components/Form'` import 存在
  - render 后所有 input/textarea 都带 `form-input` class（helper 自动加）+ label 包在 `form-field` 内
- 既有路由测试（如 `agents-new-snapshot.test.tsx` / `agent-form-mcp-picker.test.ts` 等）不退化

### T26 — 集成测试 + 类型检查

- `bun run typecheck` / test / format / lint 全绿

### T27 — 文档收尾

- `STATE.md` 更新 RFC-035 进度（PR2 落地）
- `design/plan.md` 状态保持 In Progress
- commit message：`feat(ux): RFC-035 PR2 — .tabs/.data-table/<Form> 推广`
- push + CI 验

### PR2 验收 checklist

- [ ] T12..T27 全部完成
- [ ] `tests/tabs-modifier.test.tsx` 绿
- [ ] `tests/tabs-retrofit-grep.test.ts` 旧 4 个命名空间 class 在业务文件 0 次
- [ ] `tests/data-table-callsite.test.ts` 3 处推广目标命中
- [ ] `tests/{agents,plugins,mcps,clarify}-form-helper.test.tsx` 7 处全绿
- [ ] 既有 form-related 测试不退化
- [ ] CI 六 job 全绿

---

## PR3 — Dialog / EmptyState / LoadingState / DetailLayout 抽出

> 依赖：PR2 落地 + CI 绿。
> 单 PR 内顺序：T28 → T29..T31 平行（Dialog）→ T32..T33 平行（EmptyState / LoadingState 创建）→ T34..T42 推广 → T43..T45（DetailLayout）→ T46（settings 内联 style 清理）→ T47 测试 → T48 文档。

### T28 — 新增 <Dialog> 组件 + CSS

- 文件：`packages/frontend/src/components/Dialog.tsx` 新建（~120 行）
- API 见 design.md §7.1
- styles.css 新增 `.dialog__overlay` / `.dialog__panel` / `.dialog--sm/md/lg` / `.dialog__header/__close/__body/__footer` 块
- 测试：`tests/dialog.test.tsx` 8 case + `tests/dialog-body-overflow.test.tsx` 1 case

### T29 — retrofit AgentImportDialog 到 <Dialog>

- 文件：`packages/frontend/src/components/AgentImportDialog.tsx`
- 改动：包成 `<Dialog title size="lg" open onClose>`；删 `.agent-import__overlay/__panel/__header/__close/__footer` 自家结构；保留 dialog body 内业务（tabs / textarea / 上传 / preview / table）
- 测试：`tests/agent-import-dialog.test.tsx` 不退化（用 `role="dialog"` 锚）

### T30 — 抽 ReviewDecisionDialog 组件 + 内部走 <Dialog>

- 新文件：`packages/frontend/src/components/reviews/ReviewDecisionDialog.tsx`（~80 行）
- API：`open / onClose / mode: 'approve'|'iterate'|'reject' / reason / onReasonChange / error / onConfirm`
- 改动：`routes/reviews.detail.tsx` 删内联 dialog（~60 行）→ 改 import + 调用
- 测试：新增 `tests/review-decision-dialog.test.tsx` 3 mode 路径 + reject reason 校验 + onConfirm 触发；既有 `reviews.detail.test.tsx`（如有）不退化

### T31 — retrofit BatchImportDialog 到 <Dialog>

- 文件：`packages/frontend/src/components/repos/BatchImportDialog.tsx`
- 改动：`<div className="modal batch-import-dialog">` → `<Dialog size="lg" title>`；保留 `.batch-import-dialog__textarea` / `.batch-import-table` 业务子样式
- 测试：`tests/batch-import-dialog.test.tsx` 不退化

### T32 — 新增 <EmptyState> 组件 + CSS

- 文件：`packages/frontend/src/components/EmptyState.tsx`（~30 行）
- styles.css 新增 `.empty-state` 块
- 测试：`tests/empty-state.test.tsx` 5 case

### T33 — 新增 <LoadingState> 组件 + CSS

- 文件：`packages/frontend/src/components/LoadingState.tsx`（~25 行）
- styles.css 新增 `.loading-state` + `@keyframes spin`
- 测试：`tests/loading-state.test.tsx` 3 case

### T34..T42 — EmptyState / LoadingState 推广（9 处）

- T34 `routes/agents.tsx`
- T35 `routes/skills.tsx`
- T36 `routes/mcps.tsx`
- T37 `routes/plugins.tsx`
- T38 `routes/workflows.tsx`
- T39 `routes/tasks.tsx`
- T40 `routes/repos.tsx`
- T41 `routes/reviews.tsx`
- T42 `components/home/InboxPreviewList.tsx`

每个子任务：

- 改动：`{isLoading && <div className="muted">…</div>}` → `<LoadingState />`；`{empty && <div className="muted">…</div>}` → `<EmptyState title description action />`
- 测试：新建 `tests/{route|component}-empty-loading.test.tsx` —— 源代码层 grep 锁 `<EmptyState` / `<LoadingState` ≥ 1 次 + 旧 `<div className="muted">{t('common.loading')}</div>` 不再出现

### T43 — 新增 <DetailLayout> 组件 + CSS

- 文件：`packages/frontend/src/components/DetailLayout.tsx`（~40 行）
- styles.css 新增 `.detail-layout` + modifier 块
- 测试：`tests/detail-layout.test.tsx` 4 case

### T44 — retrofit task-detail 到 <DetailLayout>

- 文件：`packages/frontend/src/routes/tasks.detail.tsx`
- 改动：`<div className="task-detail__panes">` → `<DetailLayout main aside asideWidth="lg">`
- 测试：`tests/task-detail-layout-retrofit.test.tsx` + 既有 `task-detail-*.test.tsx` 不退化

### T45 — retrofit review-detail 到 <DetailLayout>

- 文件：`packages/frontend/src/routes/reviews.detail.tsx`
- 改动：`.review-detail__layout` → `<DetailLayout main aside asideWidth="md">`
- 测试：`tests/review-detail-layout-retrofit.test.tsx` + 既有不退化

### T46 — settings.tsx 内联 style 清理（6 处）

- 文件：`packages/frontend/src/routes/settings.tsx`
- 改动见 design.md §10.1（6 处 style 改 className，引入 `.settings-hint` 局部 class + `.stack-top--*` token 化）
- 测试：`tests/settings-inline-style-cleanup.test.ts`：`routes/settings.tsx` 内 `style=\{\{` 出现 0 次

### T47 — 集成测试 + 类型检查

- 三 package typecheck / test / format / lint 全绿
- Playwright e2e（CI 跑）不退化

### T48 — 文档收尾

- `STATE.md` 更新 RFC-035 进度（PR3 落地 Done）
- `design/plan.md` 索引 RFC-035 状态 → Done
- commit message：`feat(ux): RFC-035 PR3 — <Dialog>/<EmptyState>/<LoadingState>/<DetailLayout> 抽出 + 内联 style 清理`
- push + CI 验

### PR3 验收 checklist

- [ ] T28..T48 全部完成
- [ ] `tests/dialog.test.tsx` 8 case + body-overflow + grep 锁绿
- [ ] `tests/empty-state.test.tsx` 5 case 绿
- [ ] `tests/loading-state.test.tsx` 3 case 绿
- [ ] `tests/detail-layout.test.tsx` 4 case 绿
- [ ] 4 dialog retrofit / 9 empty-loading retrofit / 2 detail-layout retrofit 各自测试绿
- [ ] `tests/settings-inline-style-cleanup.test.ts` 绿
- [ ] e2e Playwright 不退化
- [ ] CI 六 job 全绿
- [ ] 视觉抽样验证（本地启 dev server）：dialog 三处（AgentImport / ReviewDecision / BatchImport）/ EmptyState 三处（/agents / /skills / 首页 inbox）/ DetailLayout 两处（task / review detail）

---

## 附录 A — Cleanup PR（独立提出，本 RFC 范围外）

RFC-035 三 PR 全部落地后 1 个 release 周期，开 cleanup PR 一次删完：

- `.agent-import__overlay/__panel/__header/__close/__footer/__tab/__tabs` 等 ~80 行
- `.review-decision-dialog__overlay/__panel/__header/__close/__body/__warn/__label/__textarea/__error/__actions` ~90 行
- `.repo-source-tabs/__bar/__tab/__tab.is-active` ~30 行
- `.inspector__tabs` 1 行
- `.mcp-probe-chip{,--unknown/--probing/--ok/--error}` ~30 行
- `.status-badge{,--success/--warn/--danger/--muted}` ~30 行
- `.status-chip--{gray,blue,green,red,amber}` 5 个 backward-compat alias ~30 行
- `.reviews-row__*` ~40 行
- `.repos-table*` ~30 行
- `.batch-import-dialog.modal` ~5 行

预估 -350~500 行 styles.css。该 PR 不动业务文件，仅删 CSS；通过 RFC-035 三个 PR 的 grep 守卫 + e2e 间接保证安全。

## 附录 B — 风险与回退

| PR | 回退方式 | 回退成本 |
| --- | --- | --- |
| PR1 | `git revert <commit>`；token 引入零业务依赖；StatusChip retrofit 调用方 API 不变，revert 后旧 className 逻辑回来 | 低 |
| PR2 | 同；form 推广是 jsx 级，revert 不影响 mutation 行为 | 低 |
| PR3 | 同；4 共享组件可以 revert（业务文件回归内联实现）；inline style 清理可单独 revert（设计 token 不依赖此 PR） | 中（4 个共享组件牵涉面大但仍是前端） |

每个 PR 单独 commit + 单独 push + 单独验 CI；任何一个 PR 失败立刻 revert + 开 issue，不堆 work-in-progress。
