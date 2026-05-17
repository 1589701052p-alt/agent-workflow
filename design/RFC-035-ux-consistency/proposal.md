# RFC-035 — UX 一致性专项

> **状态**：Draft（已展开，等待用户确认进入实现）。
>
> **权威背景**：[`design/ux-audit.md`](../ux-audit.md)（2026-05-17 全量审计 — 9 个缺口分类 + 强项保留清单）。Audit 文档是本 RFC 的事实依据，不在本 proposal 中复制；任何与 audit 不一致的判断都以 audit 为准 + 在 design.md / plan.md 里显式说明缺口在 RFC-032 落地后已经变化。
>
> **创建动机**：RFC-032（导航重构 + 任务驱动首页）改写期间，用户问"是否同时统一所有界面 UX 风格"。诚实评估认为 RFC-032 应保持外壳 + 首页范围，UX 一致化独立处理才能避免 scope creep。本 RFC 即是那条独立路径。
>
> **依赖**：RFC-032 PR1 + PR2 已落地（commit `04082c8` + `38690f6`）；PR3 Homepage 即将落地。RFC-035 三个 PR 顺序在 RFC-032 全 3 PR 落地后启动，避免两个 RFC 同时改 `styles.css` 大段冲突。

---

## 1. 背景

agent-workflow 前端在 31 个 RFC 累积后，**chrome 心智**已经收敛（`page__header` / `btn` / `ConfirmButton` / `ErrorBanner` / 颜色 token），但**视觉细节**有 9 处明显不一致。其中两类问题让"新人改 UI"的体验恶化：

1. **静默退化**：`btn--ghost` / `btn--xs` 在多个组件被使用但 CSS 未定义，作者期望的视觉根本没出现，code review / e2e 无法盯到。
2. **同一概念多套实现**：4 套并行的状态指示系统、4 套独立的 tab 实现、2 套独立的对话框 overlay、列表 / 表格视觉两套并行——新人要写新页面时打开 `components/` 看不到现成 primitive，只能 grep 看别的页面怎么写，复制粘贴的过程又会派生第 5 套。

ux-audit.md §2 把 9 个缺口按修复成本排序；本 RFC 把它们打包成**一套设计 tokens + 一组共享 component / class primitive + 一份明确的迁移点逐个清单**，分 3 个 PR 落地，每个 PR 自洽可独立 revert。

> **audit 数据刷新提示**：ux-audit.md 写于 2026-05-17，盘点了 5 处 `btn--ghost` / `btn--xs` 调用点；RFC-032 PR2（inbox drawer）+ PR3（homepage 三 list）又增加了 4 处。design.md 里给出 2026-05-18 数据 + 源码层 grep 锁防回归；audit 文档本身不动（它是历史快照）。

---

## 2. 目标

让全站 UX 视觉语言收敛到**一套显式声明的标准件**，使：

- 新页面实现成本下降——`components/` 顶层有现成 `<StatusChip />` / `<Dialog />` / `<EmptyState />` / `<LoadingState />` / `<DetailLayout />`，不再"复制别的页面写法"。
- 同一概念视觉一致——"成功 / 失败 / 警告 / 进行中"配色权重、圆角、字号在所有页面对齐；状态切换不产生认知摩擦。
- 设计 tokens 让"间距 / 字号 / 圆角 / 阴影"有明确取值集合，杜绝 `marginTop: 16` / `fontSize: 13` 散落写法。
- 静默缺失的 CSS（`btn--ghost` / `btn--xs`）补齐——调用方意图能落到像素上。

具体可验收的落地动作（细节见 design.md / plan.md）：

1. **PR1 — Foundation**：引入 4 类设计 token（间距 `--space-1..6` / 字号 `--font-xs..xl` / 圆角 `--radius-sm..pill` / 阴影 `--shadow-sm..lg`）+ 语义色 `--success / --warn / --info` + 暗色覆写；补 `.btn--ghost` / `.btn--xs` 缺失 CSS；引入 `<StatusChip>` 共享组件 + 把 `TaskStatusChip` / `StatusBadge`（inventory）/ `McpProbeStatusChip` / homepage `task-row__status` 四个分散组件 retrofit 成内部走 `<StatusChip>`。**0 backend / 0 shared / 0 DB**。
2. **PR2 — Form / Tabs / Table 推广**：通用 `.tabs` 加 `--inline / --inspector / --segment` 三个 modifier；inspector / agent-import / repo-source 三处现有 tab 切到通用 `.tabs`；`.data-table` 推广到 `repos` / `agent-import` 表格 / `reviews` 列表行；7 个未采用 `<Form>` 的路由 / 表单 fragment 迁移。**0 backend / 0 shared / 0 DB**。
3. **PR3 — Shared component 抽出**：抽 `<Dialog>` shared component（overlay + panel + header + close + footer + 焦点陷阱 + ESC 关闭 + portal）+ retrofit `AgentImportDialog` / 内联 `ReviewDecisionDialog`（reviews.detail.tsx）；抽 `<EmptyState>` / `<LoadingState>` + 18 个 isLoading/isPending 调用点改造（至少一半）；抽 `<DetailLayout main aside asideWidth>` + retrofit `task-detail` / `review-detail`；整理 11 处路由内联 `style={...}` 迁到间距 token / `.stack--{sm,md,lg}` 类。**0 backend / 0 shared / 0 DB**。

---

## 3. 非目标

- **不改变信息架构**：仅视觉一致化；layout 重排在 RFC-032 已经完成，本 RFC 不再动 nav / homepage / sidebar / footer 的结构。
- **不引入新的设计语言 / 主题**：颜色 token 继续用 `--bg / --panel / --border / --text / --muted / --accent / --danger` + 新增的 `--success / --warn / --info`；不变更暗色规则；不增加第二主题。
- **不引入设计系统外的 npm 依赖**：项目当前是手写 CSS + 极轻量 React component，**继续手写**，不引入 shadcn / Radix UI / Headless UI / Tailwind 等。
- **不破坏现有有意视觉差异**：例如 review 详情的 sidebar count 视觉是 RFC-009 产品有意为之，retrofit 到 `<DetailLayout>` 时要保留 sidebar 内 chip 数字的视觉；workflow canvas 的 inspector 抽屉 + 节点详情 drawer 各自的视觉细节也保留（仅把它们的 tab class 收敛到 `.tabs --inspector`）。
- **不改后端 / shared / DB**：纯前端外壳 + token + 共享 component；本 RFC 不会触发任何 schema / migration / WS / runner 改动。
- **不收敛非状态 chip**：`.chip` / `.chip--managed` / `.chip--external` / `.chip--active` 系列是 filter / source / tag chip（不表达 success/warn/danger 语义），保持独立，不并入 `<StatusChip>`。
- **不收敛非视觉一致的 chip 形态**：节点 inspector 上的 `__clarify__` "❓ clarify ask" / "💬 clarify answer" friendly badge（RFC-023 产品决策）不动；workflow canvas 上每个节点的 port chip 不动。
- **不主动重命名其他 RFC 的命名空间 class**：例如 `.review-decision-dialog__*` / `.agent-import__*` / `.session-attempts__*` 系列在 retrofit 路径之外原样保留。
- **不抽 dropdown / popover / tooltip 等其他共享 component**：当前只有 `reviews.detail.tsx` 一处自造 popover，孤例不抽。

---

## 4. 用户故事

- **作为一个新接手的前端开发者**，我希望写一个新页面时打开 `components/` 就能找到现成的 `<StatusChip />` `<Dialog />` `<EmptyState />` `<DetailLayout />` 组件，而不是去 grep 看别的页面怎么做、然后复制粘贴出第 5 套实现。
- **作为一个 RFC-032 落地后回头改首页的开发者**，我希望首页 task-row 的状态 chip 跟 `/tasks` 列表 + `/reviews` 列表 + `/mcps` 行级状态视觉一致，不需要为同一"成功"概念维护 4 套 CSS。
- **作为一个新写 form 的开发者**，我希望 `/agents/new` / `/mcps/new` / `/plugins/new` 表单 helper 跟 `/skills/new` / `/workflows/launch` 是同一套 `<Form.Field>` / `<TextInput>` / `<NumberInput>` API，间距 / label 字号 / required 标记 / hint 位置在所有页面一致。
- **作为一个 review user**，我希望平台所有"成功 / 失败 / 警告 / 进行中"的颜色与圆角语言完全一致，不会因为页面切换而产生认知摩擦。
- **作为一个 RFC-032 PR3 落地后想给首页加新 section 的开发者**，我希望 `<DetailLayout>` 已经被抽出来，能直接套用 main + aside 的 split-pane 模板，不必再去看 task-detail / review-detail 各自的 panes 实现重复一遍。
- **作为一个 settings 页面的维护者**，我希望可以用 `<p className="stack--sm">` 替代 `style={{ marginTop: 16 }}`，让间距统一从 design token 派生，不必每次手写数值。

---

## 5. 验收标准

### 5.1 PR1 — Foundation（tokens + ghost/xs + StatusChip 收敛）

#### 5.1.1 设计 token

- [ ] `styles.css` 顶部 `:root` 块新增：
  - 间距：`--space-1` 4px / `--space-2` 8px / `--space-3` 12px / `--space-4` 16px / `--space-5` 24px / `--space-6` 32px
  - 字号：`--font-xs` 11px / `--font-sm` 12px / `--font-md` 14px / `--font-lg` 16px / `--font-xl` 22px
  - 圆角：`--radius-sm` 4px / `--radius-md` 6px / `--radius-lg` 10px / `--radius-pill` 999px
  - 阴影：`--shadow-sm` `0 1px 2px rgba(0,0,0,0.08)` / `--shadow-md` `0 4px 12px rgba(0,0,0,0.12)` / `--shadow-lg` `0 20px 40px rgba(0,0,0,0.25), 0 4px 10px rgba(0,0,0,0.12)`（与现有 review-decision-dialog 阴影对齐）
  - 语义色：`--success` light `#2da44e` / dark `#3fb959`；`--warn` light `#bf6900` / dark `#f0a020`；`--info` light `#266ab3` / dark `var(--accent)`
- [ ] `:root[data-theme='dark']` 块同步覆写每个语义色 + 必要的 shadow（dark mode 阴影更深）
- [ ] `@media (prefers-color-scheme: dark)` 兜底块同步
- [ ] 添加 `.stack--sm` / `.stack--md` / `.stack--lg` 通用 utility（`.stack--sm > * + * { margin-top: var(--space-2); }` 等），用于替代散落的 `marginTop` 内联
- [ ] 测试：`tests/styles-tokens.test.ts` 源代码层断言每个 token 名都在 `:root` 出现 + dark 覆写也命中，让删除某个 token 立刻红

#### 5.1.2 `.btn--ghost` / `.btn--xs` 补齐

- [ ] `.btn--ghost`：透明背景 + accent 文字 + hover 加 `color-mix(accent 12%, transparent)` 浅底，不要 border（透明 border 占位避免 hover 时跳动）
- [ ] `.btn--xs`：`padding: 2px 8px`，`font-size: var(--font-sm)`（12px），`border-radius: var(--radius-sm)`
- [ ] 现有 9 处调用点不改源代码，依赖新 CSS 自动生效（callsite 在 audit 列出 5 处 + RFC-032 PR2/PR3 新增 4 处）
- [ ] 测试：`tests/btn-variants-styles.test.ts` 源代码层断言 `.btn--ghost {` + `.btn--xs {` 在 styles.css 出现一次，让"被人误删 CSS"立刻红
- [ ] 测试：`tests/btn-variants-callsite.test.ts` 源代码层 grep 全部 `btn--ghost|btn--xs` 调用点 ≥ 9 处（防回归：误删 callsite 也红）

#### 5.1.3 `<StatusChip>` 共享组件

- [ ] 新 `components/StatusChip.tsx` 导出：
  ```tsx
  export interface StatusChipProps {
    kind: 'success' | 'warn' | 'danger' | 'info' | 'neutral'
    size?: 'sm' | 'md'        // default 'md'
    children: ReactNode        // label text
    title?: string
    'aria-label'?: string
    'data-testid'?: string
  }
  ```
  实现为 `<span className="status-chip status-chip--{kind} status-chip--{size}">`；带 `role="status"` 当 `aria-label` / `title` 显式给出时
- [ ] `.status-chip` CSS 重整：把现有 `--gray / --blue / --green / --red / --amber` 5 色保留为 backward-compat alias，但 documented mapping 走 `--success / --warn / --danger / --info / --neutral` 5 个**语义** modifier；两套并存，旧调用方零改动
- [ ] `<TaskStatusChip>` 内部改为渲染 `<StatusChip>`（status → kind 映射表：`done → success` / `running → info` / `failed → danger` / `awaiting_review / awaiting_human / interrupted → warn` / `pending / canceled → neutral`）
- [ ] inventory `<StatusBadge>` 内部改为渲染 `<StatusChip>`（bucket → kind 直映射：`success → success` / `warn → warn` / `danger → danger` / `muted → neutral`）；保留 `.status-badge` CSS 作 visual alias 直到 PR3 grep 守卫确认无外部引用
- [ ] `<McpProbeStatusChip>` 内部改为渲染 `<StatusChip>`（status → kind 映射：`ok → success` / `error → danger` / `probing → info` / `unknown → neutral`），保留 dot 视觉锚（`.status-chip--with-dot` modifier 或直接在子节点渲染）
- [ ] homepage `task-row__status` 用 `<StatusChip size="sm" kind={mapped}>` 替换 inline span（status → kind 映射与 `<TaskStatusChip>` 完全一致，借此把首页与 `/tasks` 列表视觉对齐）
- [ ] 测试：`tests/status-chip.test.tsx` 5 kind × 2 size = 10 case render matrix + role/aria-label/data-testid 路径
- [ ] 测试：`tests/task-status-chip.test.tsx` 现有断言改为通过 `<StatusChip>` 锚点（kind 属性 + size + label）；不直接断言 `.status-chip--green` 类（让未来调 kind 映射不破测试）
- [ ] 测试：`tests/inventory-status-badge.test.tsx` 同上
- [ ] 测试：`tests/mcp-probe-status-chip.test.tsx` 同上
- [ ] 测试：`tests/homepage-task-row-status.test.tsx` 断言 task-row__status 渲染的是 `<StatusChip>` + kind 与状态匹配
- [ ] 测试：`tests/status-chip-grep.test.ts` 源代码层 grep 锁 `.mcp-probe-chip {` / `.status-badge {` CSS 仍存在（PR3 前不删），同时 `<StatusChip` 至少出现在 4 个 retrofit 组件里

### 5.2 PR2 — Form / Tabs / Table 推广

#### 5.2.1 `.tabs` modifier

- [ ] `.tabs` 加 `.tabs--inline`（无 border-bottom；用于 dialog 内嵌切换：agent-import）/ `.tabs--inspector`（紧凑 padding；workflow editor 右抽屉）/ `.tabs--segment`（圆角段控；launcher 仓库源切换）三个 modifier
- [ ] `NodeDetailDrawer.tsx` / `NodeInspector.tsx` 已用 `tabs inspector__tabs`，仅把 `inspector__tabs` 改为 `.tabs--inspector`，旧 class 在 PR3 grep 守卫确认无业务引用后删除
- [ ] `AgentImportDialog.tsx` `agent-import__tabs` 改为 `.tabs .tabs--inline` + 子项 `.tabs__tab`
- [ ] `RepoSourceTabs.tsx` `repo-source-tabs` 改为 `.tabs .tabs--segment` + 子项 `.tabs__tab`
- [ ] 测试：`tests/tabs-modifier.test.tsx` 4 modifier render 锚 + `tests/tabs-retrofit-grep.test.ts` 源代码层断言旧 class（`.agent-import__tabs` / `.repo-source-tabs`）在业务文件不再被引用（CSS 中保留作 visual fallback 至 PR3 清理）

#### 5.2.2 `.data-table` 推广

- [ ] `routes/repos.tsx` `.repos-table` → `.data-table` + 列 / 操作列复用 `.data-table__actions` / `.data-table__truncate`
- [ ] `AgentImportDialog.tsx` `.agent-import__table` → `.data-table .data-table--compact`（新 modifier，padding 更紧凑）
- [ ] `routes/reviews.tsx` `.reviews-row__*` → `.data-table`；展开行（历史版本）走新增 `.data-table--expandable` + `.data-table__expanded-row` modifier
- [ ] 测试：`tests/data-table-callsite.test.ts` 源代码层断言 `.data-table` 出现在 `repos.tsx` / `reviews.tsx` / `AgentImportDialog.tsx` 三个文件至少各 1 次 + 旧 class 在业务文件不再被引用

#### 5.2.3 `<Form>` 推广

7 个目标路由：

- [ ] `routes/agents.new.tsx` 表单 fragment 改 `<Form.Field>` + `<TextInput>` / `<NumberInput>` / `<TextArea>` / `<Switch>`
- [ ] `routes/agents.detail.tsx` 同上
- [ ] `routes/plugins.new.tsx` 同上
- [ ] `routes/plugins.detail.tsx` 同上
- [ ] `routes/mcps.new.tsx` 同上
- [ ] `routes/mcps.detail.tsx` 同上
- [ ] `routes/clarify.detail.tsx` 表单 fragment（提交答案处） 走 `<TextArea>` + `<Form.Field>`
- [ ] 注意：`reviews.detail.tsx` / `repos.tsx` / `tasks.detail.tsx` 等只含轻量 `<input>` fragment 的页面在本 PR 不迁移（避免 PR 过大），延后到 RFC-036 或之后
- [ ] 测试：每个迁移路由加 `tests/{route}-form-helper.test.tsx`，断言新调用点出现 `form-input` / `form-field` / `form-switch` 等 helper 类（一行 grep 锁）+ 表单提交流程不退化

### 5.3 PR3 — Dialog / EmptyState / LoadingState / DetailLayout 抽出

#### 5.3.1 `<Dialog>` 抽出

- [ ] 新 `components/Dialog.tsx` 导出：
  ```tsx
  export interface DialogProps {
    open: boolean
    onClose: () => void
    title: string
    size?: 'sm' | 'md' | 'lg'
    children: ReactNode             // body
    footer?: ReactNode               // 通常是 action 按钮行
    initialFocusRef?: RefObject<HTMLElement>
    closeOnOverlayClick?: boolean    // default true
    'aria-label'?: string
    'data-testid'?: string
  }
  ```
  实现：`createPortal` → `document.body`；`role="dialog"` + `aria-modal="true"` + `aria-labelledby`；ESC 关闭；焦点陷阱（Tab / Shift+Tab 内循环）；初始焦点（initialFocusRef 或首个 focusable）；mousedown outside `.dialog__panel` 关闭（可关）；body `overflow: hidden` 在 open 期间防止背景滚动
- [ ] `.dialog` / `.dialog__overlay` / `.dialog__panel` / `.dialog__header` / `.dialog__close` / `.dialog__body` / `.dialog__footer` / `.dialog--sm` / `.dialog--md` / `.dialog--lg` CSS（复用 PR1 引入的 `--shadow-lg` / `--radius-lg` / `--space-3..5`）
- [ ] `AgentImportDialog.tsx` retrofit：删 `agent-import__overlay / __panel / __header / __close` 自家结构，包成 `<Dialog title=…>` + 内部仅留业务（tabs 已经在 PR2 收敛）
- [ ] `reviews.detail.tsx` 内联 ReviewDecisionDialog retrofit：抽 `ReviewDecisionDialog.tsx` 为新组件 + 内部走 `<Dialog>`
- [ ] `BatchImportDialog.tsx`（RFC-033）retrofit：删 `.modal` ad-hoc → `<Dialog size="lg">`，保留 `.batch-import-dialog__textarea` / `.batch-import-table` 业务子样式
- [ ] 测试：`tests/dialog.test.tsx` ESC 关闭 + outside click 关闭（可关）+ initialFocus + focus trap + body overflow 锁定 + role/aria
- [ ] 测试：现有 AgentImportDialog / BatchImportDialog / ReviewDecisionDialog 测试不退化（用 `<Dialog>` 后 a11y / e2e 路径仍一致）
- [ ] 测试：`tests/dialog-grep.test.ts` 源代码层断言 `.review-decision-dialog__panel` / `.agent-import__overlay` / `.modal` 在业务文件不再被引用（CSS 保留作 fallback）

#### 5.3.2 `<EmptyState>` / `<LoadingState>` 抽出

- [ ] 新 `components/EmptyState.tsx` 导出：
  ```tsx
  export interface EmptyStateProps {
    title: string
    description?: string
    icon?: ReactNode
    action?: ReactNode
    size?: 'compact' | 'comfortable'  // default 'comfortable'
  }
  ```
- [ ] 新 `components/LoadingState.tsx`：spinner + 文字 fallback；接受同样 `size` prop
- [ ] 至少 9 个 isLoading/isPending 调用点（18 处的一半）改造为 `<LoadingState>` + `<EmptyState>`：
  - `routes/agents.tsx` / `routes/skills.tsx` / `routes/mcps.tsx` / `routes/plugins.tsx` / `routes/workflows.tsx` / `routes/tasks.tsx` 6 个列表路由
  - `routes/repos.tsx` / `routes/reviews.tsx` 2 个表格
  - `components/home/InboxPreviewList.tsx` 1 个 inbox 子列表
- [ ] 测试：`tests/empty-state.test.tsx` 5 case（基础 / 带 icon / 带 description / 带 action / compact size）
- [ ] 测试：`tests/loading-state.test.tsx` 3 case（基础 / 带 size / role="status" 锚）
- [ ] 测试：每个迁移路由加一行 `tests/{route}-empty-loading.test.tsx`，断言 `data-testid="empty-state"` / `data-testid="loading-state"` 出现 + 原 `<div className="muted">{t('common.loading')}</div>` 在源代码不再出现

#### 5.3.3 `<DetailLayout>` 抽出

- [ ] 新 `components/DetailLayout.tsx` 导出：
  ```tsx
  export interface DetailLayoutProps {
    main: ReactNode
    aside?: ReactNode
    asideWidth?: 'sm' | 'md' | 'lg'   // 240 / 320 / 420
    asidePosition?: 'left' | 'right'  // default 'right'
    'data-testid'?: string
  }
  ```
  实现：CSS Grid `grid-template-columns: 1fr {asideWidthVar}` / `{asideWidthVar} 1fr`（aside left/right 切换）；aside 缺省时 `1fr`；mobile 兜底（< 720px）改 stack 垂直堆叠
- [ ] `routes/task-detail` retrofit：`.task-detail__panes` → `<DetailLayout main={canvas} aside={inspector} asideWidth="lg">`；保留 `.task-detail__pane` / `task-canvas-layout` 业务细节
- [ ] `routes/reviews.detail.tsx` retrofit：`.review-detail__layout` → `<DetailLayout>`；保留 `.review-detail__sidebar-*` 业务细节（产品有意视觉差异，不收敛 sidebar 内部 chip）
- [ ] 测试：`tests/detail-layout.test.tsx` 4 case（aside 缺省 / aside left / aside right / asideWidth 三档）
- [ ] 测试：`tests/task-detail-layout.test.tsx` 断言新 layout 嵌套 + 旧 `.task-detail__panes` 类在源代码不再出现
- [ ] 测试：`tests/review-detail-layout.test.tsx` 同上

#### 5.3.4 内联 style 清理

- [ ] `settings.tsx` 6 处 inline `marginTop` / `marginBottom` / `fontSize` 改 `.stack--md` / `.stack--sm` / `font-size: var(--font-sm)` className（PR1 已经引入 tokens）
- [ ] `reviews.detail.tsx` 5 处保留**动态 transform** / **runtime absolute positioning** 处的 inline style（dynamic 必须 inline），仅整理 1 处可静态化的（如固定 marginTop）
- [ ] `workflows.tsx` `style={{ display: 'none' }}` 留着（file input 视觉隐藏的标准做法）
- [ ] 测试：`tests/settings-inline-style-cleanup.test.ts` 源代码层 grep `settings.tsx` 内 `style=\{\{` 出现次数 ≤ 0（或保留少数 documented 例外，列在测试断言里）

---

## 6. 与其他 RFC 的关系

### 6.1 依赖

- **RFC-032 全 3 PR 落地**：理由——PR1 / PR2 已经动了 `styles.css` + 新增 `.sidebar__footer` / `.inbox-*` / `.nav-*` 等类；PR3 Homepage 进一步加 `.task-row` / `.homepage-*` 等。RFC-035 PR1 在 `styles.css` 顶部插入 token + 收敛 chip CSS，与 RFC-032 PR3 同时操作 `styles.css` 中段会产生不必要的 merge 冲突。等 RFC-032 全部 push 后再开 RFC-035 PR1。

### 6.2 不依赖

- RFC-029 / RFC-030 / RFC-031（runner / inventory / plugin 后端 / probe 接口）：本 RFC 不动后端。
- RFC-033 / RFC-034（batch import / submodule）：本 RFC 不动 git / repo 路径；但 PR3 会 retrofit `BatchImportDialog` 的 `.modal` 用 `<Dialog>`（仅样式骨架替换，不动业务逻辑）。

### 6.3 兼容性保留

- `<TaskStatusChip>` / `<StatusBadge>` / `<McpProbeStatusChip>` **API 保持不变**——内部 retrofit 走 `<StatusChip>`，调用方零改动。
- 旧 `.status-chip--{gray,blue,green,red,amber}` 5 个 CSS modifier 保留作 backward-compat alias；新 callsite 一律用 `--{success,warn,danger,info,neutral}` 5 个语义 modifier。
- `.agent-import__*` / `.review-decision-dialog__*` / `.repo-source-tabs` 等命名空间 CSS 在 PR3 完成 retrofit 后保留 30 天（一个 RFC 周期）作 fallback，再由后续 cleanup PR 删除，避免外部 RFC 进行中分支被打回。
- 测试策略避免硬绑定到内部实现 class（如 `.status-chip--green`），改用 component-level 锚（`data-testid` / `kind` prop），让未来调 kind→color 映射不必修测试。

### 6.4 后续 RFC

- RFC-036+（如有需要）做更深入设计语言演进：响应式 / 移动端 / 第二主题 / dropdown / popover / tooltip 共享组件。
- 旧命名空间 CSS（`.agent-import__*` / `.review-decision-dialog__*` / `.mcp-probe-chip` 等）的最终 cleanup PR——独立提出，避免 RFC-035 本身 PR 过大。

---

## 7. 失败模式与权衡

| 风险 | 应对 |
| --- | --- |
| Token 引入后散落硬编码数值仍残留（例如 `font-size: 13px` 在某 component 里没被替换） | RFC-035 不追求 100% token 化，仅整理 audit 明确指出的散落点 + 内联 style 清理；后续 RFC-036+ 做全量扫描。验收里不写"100% 替换"，只写"特定 callsite 替换 + 新增 callsite 必须走 token"。 |
| `<StatusChip>` 收敛后未来需要新增第 6 种状态 kind | 留 `'neutral'` 作 fallback；新增 kind 时同时加 `.status-chip--{kind}` CSS + 更新 5 个 retrofit 组件的映射表；API 保持 string union 易扩展。 |
| `<Dialog>` 抽出后某 dialog 业务需求超出 API | API 留 `footer?` 作开放槽 + `size` 三档；如果未来需要更复杂 layout（split-pane dialog / 多 step wizard），允许 `<Dialog>` 内部嵌任意 JSX；不强制 panel 子结构 schema。 |
| `<EmptyState>` / `<LoadingState>` 推广到一半导致视觉混乱 | PR3 在每个迁移路由验收清单里明确**哪些点走新组件、哪些点保留老 muted 写法**；不强制全替换；测试只锚已替换的点。 |
| `<DetailLayout>` retrofit task-detail 后 inspector 行为退化 | task-detail 当前已经把 inspector 行为封在 `.task-detail__pane` 内部；retrofit 仅把外层 `<div className="task-detail__panes">` 换成 `<DetailLayout>`，inspector 内部不动；e2e 任务详情用例（`e2e/main.spec.ts` / `e2e/clarify.spec.ts`）继续 pass 作为兜底。 |
| 旧 CSS 命名空间保留 30 天导致 styles.css 持续膨胀 | 接受短期膨胀；最终 cleanup PR 在 RFC-035 全 3 PR 落地 + 一个 release 后开（commit 历史 + grep 锁能确认无业务引用时一次删完）。styles.css 当前 5764 行，RFC-035 三 PR 估计 net +200~300 行（新 token + 新组件 CSS - 部分旧类删除），cleanup PR 估计 -400~500 行。 |
| RFC-035 三个 PR 跨多人协作时与并行 RFC 冲突（例如 RFC-027 节点 session view / RFC-031 plugin） | 严守 CLAUDE.md "多人协作"原则：仅按路径精确 `git add` 本 RFC 改动 + commit message 只描述本 RFC 范围；本 RFC 不动其他 RFC 业务文件（StatusChip retrofit 只触碰 `TaskStatusChip.tsx` / `StatusBadge.tsx` / `McpProbeStatusChip.tsx` / `task-row.tsx` 四个组件，其他 RFC 不会动这些）。 |

---

## 8. 待办

本 proposal.md 落档后，紧接着展开：

- `design.md` —— 标准件 API 定义 / 迁移点逐个清单 / 测试策略 / 现有 RFC 兼容性矩阵
- `plan.md` —— PR1 / PR2 / PR3 各自 Tn 子任务 + 依赖 + PR 拆分理由 + 验收 checkbox

落档完成后用 `ExitPlanMode` 或显式询问获取用户批准，再进入实现阶段。
