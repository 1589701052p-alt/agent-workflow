# RFC-035 — UX 一致性专项 · 技术设计

> **范围**：完全前端；`packages/frontend/src/{styles.css, components/, routes/}` 范围内。0 backend / 0 shared / 0 DB / 0 migration。
>
> **配套文件**：[`proposal.md`](./proposal.md) 产品视角 + [`plan.md`](./plan.md) 任务分解 + [`../ux-audit.md`](../ux-audit.md) 权威背景。

---

## 1. 设计 token

所有 token 都在 `styles.css` 顶部 `:root` 块声明，与现有颜色 token 一起。`:root[data-theme='dark']` + `@media (prefers-color-scheme: dark) :root:not([data-theme])` 两个块同步暗色覆写。

### 1.1 间距 `--space-*`

| Token | 值 | 用例 |
| --- | --- | --- |
| `--space-1` | 4px | 同一 inline 元素间最小间隙（chip 内 dot 与文字、icon-button 内 icon 与文字） |
| `--space-2` | 8px | 表单 label 与 input 间距、按钮 group 内按钮间距 |
| `--space-3` | 12px | 卡片内 section 间距、`<Field>` 子项间距 |
| `--space-4` | 16px | section 之间垂直间距（也是 `.stack--md > * + * { margin-top }`） |
| `--space-5` | 24px | 大 section 间距、page__header 上下 padding |
| `--space-6` | 32px | 页面主体顶部 padding、空白 hero 区 |

`.stack--sm` / `.stack--md` / `.stack--lg` 三个 utility 类对应 `--space-2` / `--space-4` / `--space-5` 子项垂直间距，用 `& > * + * { margin-top: var(--space-X) }` 实现。

### 1.2 字号 `--font-*`

| Token | 值 | 现状散落 → 替换 |
| --- | --- | --- |
| `--font-xs` | 11px | sidebar header / chip 内辅助文字 |
| `--font-sm` | 12px | data-table th / muted hint / chip 默认字号 |
| `--font-md` | 14px | 正文 / data-table td / 按钮默认字号 |
| `--font-lg` | 16px | section title / h2 |
| `--font-xl` | 22px | page title / h1 |

不强制全量替换；新代码必须走 token，旧代码在迁移点（settings / homepage / 共享 component）随手替换。

### 1.3 圆角 `--radius-*`

| Token | 值 | 用例 |
| --- | --- | --- |
| `--radius-sm` | 4px | inline code / `.btn--xs` |
| `--radius-md` | 6px | 默认按钮 / input |
| `--radius-lg` | 10px | 卡片 / dialog panel / `.status-chip` 圆角 |
| `--radius-pill` | 999px | 完全圆形胶囊（chip 极端态） |

### 1.4 阴影 `--shadow-*`

| Token | 值 | 用例 |
| --- | --- | --- |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.08)` | 悬浮卡片轻量阴影 |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.12)` | popover / dropdown |
| `--shadow-lg` | `0 20px 40px rgba(0,0,0,0.25), 0 4px 10px rgba(0,0,0,0.12)` | dialog panel（与现有 `.review-decision-dialog__panel` 对齐，零视觉退化） |

暗色覆写：dark 主题阴影 alpha 加深至 `rgba(0,0,0,0.5)` 量级，但 RFC-035 只做最小改动——以现有 dialog 暗色视觉为基准复制；后续 RFC-036 做更深入暗色阴影调优。

### 1.5 语义色 `--success / --warn / --info`

| Token | Light | Dark | 替换 |
| --- | --- | --- | --- |
| `--success` | `#2da44e` | `#3fb959` | `.status-chip--green` 现硬编码 `#2da44e` 改用 token，alias 保留 |
| `--success-bg` | `color-mix(in srgb, var(--success) 18%, transparent)` | 同公式 | 替代 chip 背景 inline `color-mix(#2da44e 18%, transparent)` |
| `--warn` | `#bf6900` | `#f0a020` | 散落 `var(--warn, #c93)` `var(--warn-strong, #92400e)` 收敛 |
| `--warn-bg` | `color-mix(in srgb, var(--warn) 18%, transparent)` | 同 | 替代 `rgba(255,180,50,0.12)` 之类 |
| `--info` | `#266ab3` | `var(--accent)` | 散落 `var(--info, #266ab3)` 收敛 |
| `--info-bg` | `color-mix(in srgb, var(--info) 18%, transparent)` | 同 | 新 |

`--danger` / `--accent` 已存在，不改值；status chip danger 复用 `--danger`。

---

## 2. `.btn--ghost` / `.btn--xs` CSS

```css
.btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--accent);
}
.btn--ghost:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.btn--ghost.btn--danger {
  color: var(--danger);
}
.btn--ghost.btn--danger:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.btn--xs {
  padding: 2px 8px;
  font-size: var(--font-sm);
  border-radius: var(--radius-sm);
}
```

设计权衡：

- `.btn--ghost` 不带 border（用 transparent 占位避免 hover 时尺寸跳动）；颜色继承 accent，但与 `.btn--danger` 组合时切换到 danger 色。
- `.btn--xs` 不重定义 background / color，叠加 `.btn` 默认；如果需要 ghost+xs，加 `.btn--ghost.btn--xs` 自动组合生效。
- 现有 9 处调用点零改动。

源代码层 grep 锁清单（`tests/btn-variants-callsite.test.ts`）：

```
src/components/home/RunningTaskList.tsx          btn--xs
src/components/home/RecentlyDoneList.tsx         btn--xs
src/components/home/InboxPreviewList.tsx         btn--xs
src/components/shell/InboxDrawer.tsx             btn--xs
src/components/launch/UploadPicker.tsx           btn--xs btn--ghost
src/components/mcps/McpInventoryPanel.tsx        btn--ghost btn--sm
src/routes/clarify.detail.tsx                    btn--ghost
src/routes/mcps.tsx (×2)                         btn--ghost btn--sm
```

---

## 3. `<StatusChip>` 共享组件

### 3.1 API

```tsx
// src/components/StatusChip.tsx
export type StatusChipKind = 'success' | 'warn' | 'danger' | 'info' | 'neutral'
export type StatusChipSize = 'sm' | 'md'

export interface StatusChipProps {
  kind: StatusChipKind
  size?: StatusChipSize           // default 'md'
  children: ReactNode
  withDot?: boolean                // 是否在文字前渲染圆点（McpProbeStatusChip 复用）
  title?: string
  'aria-label'?: string
  'data-testid'?: string
}

export function StatusChip(props: StatusChipProps): JSX.Element {
  const size = props.size ?? 'md'
  const classes = ['status-chip', `status-chip--${props.kind}`, `status-chip--${size}`]
  if (props.withDot === true) classes.push('status-chip--with-dot')
  return (
    <span
      className={classes.join(' ')}
      role={props['aria-label'] !== undefined || props.title !== undefined ? 'status' : undefined}
      title={props.title}
      aria-label={props['aria-label']}
      data-testid={props['data-testid']}
    >
      {props.withDot === true && <span className="status-chip__dot" aria-hidden="true" />}
      {props.children}
    </span>
  )
}
```

### 3.2 CSS（PR1 在 styles.css 替换现有 `.status-chip` 块）

```css
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 10px;
  border-radius: var(--radius-lg);
  font-size: var(--font-sm);
  font-weight: 500;
  border: 1px solid transparent;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.status-chip--sm { padding: 1px 8px; font-size: var(--font-xs); }
.status-chip--md { /* default */ }

.status-chip--success {
  background: var(--success-bg);
  border-color: var(--success);
  color: var(--success);
}
.status-chip--warn {
  background: var(--warn-bg);
  border-color: var(--warn);
  color: var(--warn);
}
.status-chip--danger {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  border-color: var(--danger);
  color: var(--danger);
}
.status-chip--info {
  background: var(--info-bg);
  border-color: var(--info);
  color: var(--info);
}
.status-chip--neutral {
  background: var(--bg);
  border-color: var(--border);
  color: var(--muted);
}

.status-chip__dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}

/* Backward-compat alias: 旧 callsite 仍可用 --gray/--blue/--green/--red/--amber，
   映射到新语义 modifier 的颜色。PR3 后续 cleanup PR 一次删完。 */
.status-chip--gray   { /* same as --neutral */ background: var(--bg); border-color: var(--border); color: var(--muted); }
.status-chip--blue   { /* same as --info    */ background: var(--info-bg); border-color: var(--info); color: var(--info); }
.status-chip--green  { /* same as --success */ background: var(--success-bg); border-color: var(--success); color: var(--success); }
.status-chip--red    { /* same as --danger  */ background: color-mix(in srgb, var(--danger) 18%, transparent); border-color: var(--danger); color: var(--danger); }
.status-chip--amber  { /* same as --warn    */ background: var(--warn-bg); border-color: var(--warn); color: var(--warn); }
```

### 3.3 四个分散组件的 retrofit 映射

| 组件 | 文件 | 当前 modifier | 新 kind |
| --- | --- | --- | --- |
| `<TaskStatusChip>` | `components/TaskStatusChip.tsx` | `pending → gray` `running → blue` `done → green` `failed → red` `canceled → gray` `interrupted → amber` `awaiting_review → amber` `awaiting_human → amber` | `pending → neutral` `running → info` `done → success` `failed → danger` `canceled → neutral` `interrupted → warn` `awaiting_review → warn` `awaiting_human → warn` |
| `<StatusBadge>` (inventory) | `components/inventory/StatusBadge.tsx` | `success / warn / danger / muted`（已经语义命名） | 直映射：`success → success` `warn → warn` `danger → danger` `muted → neutral` |
| `<McpProbeStatusChip>` | `components/McpProbeStatusChip.tsx` | `unknown / probing / ok / error` | `unknown → neutral` `probing → info (withDot=true)` `ok → success` `error → danger` |
| `task-row__status`（homepage） | `components/home/task-row.tsx` | inline span，无 chip class | 直接渲染 `<StatusChip size="sm" kind={mapped} />`，与 `<TaskStatusChip>` 映射表一致 |

`<TaskStatusChip>` retrofit 后实现：

```tsx
const KIND: Record<TaskStatus, StatusChipKind> = {
  pending: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  canceled: 'neutral',
  interrupted: 'warn',
  awaiting_review: 'warn',
  awaiting_human: 'warn',
}

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  const { t } = useTranslation()
  return <StatusChip kind={KIND[status]}>{t(`tasks.status.${status}`)}</StatusChip>
}
```

---

## 4. `.tabs` modifier 收敛

### 4.1 现状

| Class space | 调用点 | 视觉差异 |
| --- | --- | --- |
| `.tabs / __tab / __tab--active` | `routes/settings.tsx` `routes/skills.new.tsx` `routes/clarify.tsx` `routes/reviews.tsx` `components/NodeDetailDrawer.tsx`（叠加 `inspector__tabs`）`components/canvas/NodeInspector.tsx`（叠加 `inspector__tabs`） | 标准下划线 tab |
| `.inspector__tabs` | NodeDetailDrawer / NodeInspector | 仅添加 `margin: 0 12px`（紧凑） |
| `.agent-import__tabs / __tab / __tab.is-active` | `components/AgentImportDialog.tsx` | dialog 内联，无 border-bottom |
| `.repo-source-tabs / __bar / __tab.is-active` | `components/launch/RepoSourceTabs.tsx` | segment 圆角，背景填充 active |

### 4.2 新 modifier CSS

```css
/* 既有 .tabs / __tab / __tab--active 保留 */

.tabs--inline {
  border-bottom: none;
  margin-bottom: var(--space-2);
}

.tabs--inspector {
  margin: 0 var(--space-3);
  font-size: var(--font-sm);
}
.tabs--inspector .tabs__tab {
  padding: 6px 10px;
}

.tabs--segment {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 2px;
  gap: 0;
  margin-bottom: var(--space-3);
  background: var(--panel);
}
.tabs--segment .tabs__tab {
  border-bottom: none;
  border-radius: var(--radius-sm);
  margin-bottom: 0;
  padding: 4px 12px;
}
.tabs--segment .tabs__tab--active {
  background: var(--accent);
  color: #fff;
  border-bottom-color: transparent;
}
```

### 4.3 Retrofit 改动

- `components/NodeDetailDrawer.tsx`：`<div className="tabs inspector__tabs">` → `<div className="tabs tabs--inspector">`
- `components/canvas/NodeInspector.tsx`：同
- `components/AgentImportDialog.tsx`：`<div className="agent-import__tabs" role="tablist">` → `<div className="tabs tabs--inline" role="tablist">`；子项 `.agent-import__tab` / `.agent-import__tab.is-active` → `.tabs__tab` / `.tabs__tab--active`
- `components/launch/RepoSourceTabs.tsx`：`.repo-source-tabs__bar` → `.tabs.tabs--segment`；子项 `.repo-source-tabs__tab.is-active` → `.tabs__tab.tabs__tab--active`
- 旧 4 个命名空间 class（`.inspector__tabs` / `.agent-import__tabs` / `.agent-import__tab` / `.repo-source-tabs*`）的 CSS 在 PR2 保留作 fallback（确保 hot reload / 缓存浏览器仍能 fall through），PR3 grep 守卫确认无业务引用后删

### 4.4 测试

- `tests/tabs-modifier.test.tsx`：3 modifier render 锚 + `--active` 翻转
- `tests/tabs-retrofit-grep.test.ts`：源代码层断言
  - `inspector__tabs"` 在 `src/components/` 不再出现（CSS 中可保留 fallback）
  - `agent-import__tabs"` 同
  - `repo-source-tabs"` 在 `src/components/launch/RepoSourceTabs.tsx` 出现但仅作 CSS 兼容；新的 `tabs tabs--segment` 出现 ≥ 1 次
- 现有 `components/AgentImportDialog.test.tsx` / `RepoSourceTabs.test.tsx` 不退化（用 `role="tab"` 锚而非 class）

---

## 5. `.data-table` 推广

### 5.1 现状

| 通用 | 局部自造 |
| --- | --- |
| `.data-table` 在 `routes/mcps.tsx` 使用 | `routes/repos.tsx` `.repos-table` |
| 子修饰：`__expand / __actions / __id / __link / __muted / __nowrap / __truncate / __expanded-row` | `components/AgentImportDialog.tsx` `.agent-import__table` |
| | `routes/reviews.tsx` `.reviews-row__*` 行级（不是 table 而是 list） |

### 5.2 新增 modifier

- `.data-table--compact`：`th / td padding: 6px 10px`，`font-size: var(--font-sm)`（dialog 内嵌或紧凑场景）
- `.data-table--expandable`：行支持展开；`.data-table__expanded-row > td` 复用现有 colspan + 内嵌内容样式

### 5.3 Retrofit

- `routes/repos.tsx`：`.repos-table` / `.repos-table__actions` / `.repos-table__url` → `.data-table` / `.data-table__actions` / `.data-table__truncate`；保留行内 chip 走 `<StatusChip>`（PR1 已经引入）
- `components/AgentImportDialog.tsx`：`.agent-import__table` → `.data-table .data-table--compact`；保留 `.agent-import__field` / `__value` / `__filename` / `__route` 业务子样式（仅是 td 内联结构，不与 `.data-table` 冲突）
- `routes/reviews.tsx`：`.reviews-row__*` 改为 `<table className="data-table">` + `<tr>` `<td>` 结构；展开历史版本走 `.data-table--expandable` + `.data-table__expanded-row`；保留 `.reviews-row__title` / `__meta` 业务子样式

### 5.4 测试

- `tests/data-table-callsite.test.ts`：源代码层断言
  - `routes/repos.tsx` 出现 `className="data-table` ≥ 1 次
  - `routes/reviews.tsx` 同
  - `components/AgentImportDialog.tsx` 同
  - 旧 `.repos-table` `.agent-import__table` `.reviews-row__` 在业务文件出现次数 = 0（CSS 可保留作 fallback）
- 现有 `routes/repos.test.tsx` / `routes/reviews.test.tsx` / `AgentImportDialog.test.tsx` 用 `role="table"` / `role="row"` / `data-testid` 锚，不退化

---

## 6. `<Form>` 推广

### 6.1 当前 helper

`components/Form.tsx` 已经存在，导出 `Field` / `TextInput` / `NumberInput` / `TextArea` / `Switch` 5 个 primitive（见源码 136 行）。本 RFC 不修改 Form.tsx 本身，仅推广采用面。

### 6.2 迁移路由清单

| 路由 / 组件 | 当前形态 | 迁移做法 |
| --- | --- | --- |
| `routes/agents.new.tsx` | 内联 `<input className="form-input" />` + `<label>` 手拼 | 用 `<Form.Field label hint required>` 包装 + `<TextInput>` / `<NumberInput>` / `<TextArea>` / `<Switch>` |
| `routes/agents.detail.tsx` | 同 | 同 |
| `routes/plugins.new.tsx` | 同 | 同 |
| `routes/plugins.detail.tsx` | 同 | 同 |
| `routes/mcps.new.tsx` | 同 | 同 |
| `routes/mcps.detail.tsx` | 同 | 同 |
| `routes/clarify.detail.tsx` | 提交答案处用 `<textarea className="form-input">` | 改 `<TextArea>` + `<Field label>` 包装 |

注意：

- 表单提交逻辑 / mutation 不改；仅 jsx + className 替换。
- 现有 `<AgentForm>` / `<SkillForm>` 内部已经走 helper（在 `skills.new.tsx` / `skills.detail.tsx` 调用，间接采用）；retrofit `agents.new` / `agents.detail` 会触碰 `AgentForm.tsx`（如果它没用 helper）—— 提前 `Read` 确认 AgentForm 是否已经在用 `<Field>` 还是只用 raw className；如果只是 raw，本 RFC 把 AgentForm 内部也迁移。

### 6.3 测试

- 每个迁移路由加 `tests/{route}-form-helper.test.tsx`：
  - 源代码层 grep 锁：`{route}` 文件出现 `<Form.` 或 `from '@/components/Form'` import
  - render 后所有 input/textarea 都带 `form-input` class（helper 自动加），label 都包在 `form-field` 内
- 旧 raw input 写法（`<label className="form-row">` + `<input>` 直拼）在迁移路由不再出现（源代码层 grep）

---

## 7. `<Dialog>` 抽出

### 7.1 API

```tsx
// src/components/Dialog.tsx
export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  size?: 'sm' | 'md' | 'lg'        // default 'md'，对应 panel max-width 400/520/720
  children: ReactNode
  footer?: ReactNode
  initialFocusRef?: RefObject<HTMLElement>
  closeOnOverlayClick?: boolean    // default true
  closeOnEsc?: boolean             // default true
  'aria-label'?: string
  'data-testid'?: string
}

export function Dialog(props: DialogProps): JSX.Element | null {
  // - useEffect: 当 open=true 时
  //   1. 记录之前的 active element (lastFocusRef)
  //   2. 锁 body overflow:hidden
  //   3. ESC keydown listener（closeOnEsc=true 时）
  //   4. focus trap: 监听 Tab / Shift+Tab，在 panel 内 focusable 元素间循环
  //   5. 初始 focus: props.initialFocusRef.current ?? panel 内第一个 focusable
  // - close 时: 还原 body overflow + focus back to lastFocusRef
  // - createPortal to document.body
  // - mousedown outside .dialog__panel + closeOnOverlayClick=true → onClose
}
```

### 7.2 CSS

```css
.dialog__overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 96px 24px 24px;
  z-index: 1000;
}
.dialog__panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: min(100%, 520px);
  max-height: calc(100vh - 144px);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  box-shadow: var(--shadow-lg);
  overflow: auto;
}
.dialog--sm .dialog__panel { width: min(100%, 400px); }
.dialog--md .dialog__panel { /* default */ }
.dialog--lg .dialog__panel { width: min(100%, 760px); }

.dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.dialog__header h2 {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: 600;
}
.dialog__close {
  background: transparent;
  border: 0;
  cursor: pointer;
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.dialog__close:hover { background: var(--border); color: var(--text); }

.dialog__body { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--font-md); color: var(--text); }
.dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-1);
}
```

### 7.3 Retrofit

- `AgentImportDialog.tsx`：当前 ~360 行；删 `agent-import__overlay / __panel / __header / __close / __footer` 自家结构，包成 `<Dialog title={t('agentForm.importDialog.title')} size="lg" open onClose={onClose}>` + 内部仅留业务（textarea / 文件上传 / preview / table / footer 按钮）。CSS 中 `.agent-import__overlay` / `__panel` / `__header` / `__close` / `__footer` 可在 PR3 保留作 fallback 后由 cleanup PR 删
- `routes/reviews.detail.tsx` 内联 ReviewDecisionDialog（行 1393~1450 区间）：抽 `components/reviews/ReviewDecisionDialog.tsx` 新文件 + 接受 `open / onClose / title / mode: 'approve' | 'iterate' | 'reject' / reason / onReasonChange / error / onConfirm` props + 内部走 `<Dialog>`；reviews.detail.tsx 改为 import + 调用
- `BatchImportDialog.tsx`（RFC-033，components/repos/）：删 `.modal` ad-hoc → `<Dialog size="lg" title={t('repos.batchImport.title')}>`；保留 `.batch-import-dialog__textarea` / `.batch-import-table` 业务子样式

### 7.4 测试

- `tests/dialog.test.tsx` 8 case：
  1. open=false 不渲染（return null）
  2. open=true 渲染 `role="dialog"` + `aria-modal="true"` + 引用 title 的 `aria-labelledby`
  3. ESC 触发 onClose（closeOnEsc=true）
  4. ESC 不触发 onClose（closeOnEsc=false）
  5. outside mousedown 触发 onClose（closeOnOverlayClick=true）
  6. inside mousedown 不触发 onClose
  7. initialFocusRef 指定时 focus 落到该元素
  8. focus trap：Tab 至最后一个 focusable + Tab → 循环到第一个
- `tests/dialog-body-overflow.test.tsx` 1 case：open 期 body 添加 `overflow: hidden`，close 后还原
- 现有 `agent-import-dialog.test.tsx` / `batch-import-dialog.test.tsx` 不退化（用 `role="dialog"` 或 `data-testid` 锚而非具体 class）
- 新 `tests/review-decision-dialog.test.tsx`：3 mode (approve / iterate / reject) render + reject 路径 reason 必填校验 + 提交按钮 disabled 切换
- `tests/dialog-grep.test.ts` 源代码层断言：
  - `className="review-decision-dialog__` 在业务文件出现 0 次（CSS 保留）
  - `className="agent-import__overlay"` / `__panel"` 在业务文件 0 次
  - `className="modal"` 在 `BatchImportDialog.tsx` 不再出现
  - `<Dialog ` 出现在 `AgentImportDialog.tsx` / `BatchImportDialog.tsx` / `reviews/ReviewDecisionDialog.tsx` 各 1 次

---

## 8. `<EmptyState>` / `<LoadingState>`

### 8.1 API

```tsx
// src/components/EmptyState.tsx
export interface EmptyStateProps {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
  size?: 'compact' | 'comfortable'  // default 'comfortable'
  'data-testid'?: string
}

// src/components/LoadingState.tsx
export interface LoadingStateProps {
  label?: string                    // default t('common.loading')
  size?: 'compact' | 'comfortable'  // default 'comfortable'
  'data-testid'?: string
}
```

### 8.2 CSS

```css
.empty-state, .loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-4);
  color: var(--muted);
  text-align: center;
}
.empty-state--compact, .loading-state--compact {
  padding: var(--space-3) var(--space-3);
}
.empty-state__title, .loading-state__label { font-size: var(--font-md); color: var(--text); }
.empty-state__description { font-size: var(--font-sm); color: var(--muted); }
.empty-state__icon { font-size: 32px; opacity: 0.6; }
.empty-state__action { margin-top: var(--space-2); }

.loading-state__spinner {
  width: 18px; height: 18px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

### 8.3 推广清单（PR3，至少 9 处）

| 路由 / 组件 | 替换处 |
| --- | --- |
| `routes/agents.tsx` | `{isLoading ? <div className="muted">…</div> : null}` → `<LoadingState />`；`{data.length === 0 ? <div className="muted">…</div> : null}` → `<EmptyState title={t('agents.empty.title')} description action={<Link to="/agents/new" />} />` |
| `routes/skills.tsx` | 同 |
| `routes/mcps.tsx` | 同 |
| `routes/plugins.tsx` | 同 |
| `routes/workflows.tsx` | 同 |
| `routes/tasks.tsx` | 同 |
| `routes/repos.tsx` | 同 |
| `routes/reviews.tsx` | 同 |
| `components/home/InboxPreviewList.tsx` | `<div className="muted">{t('home.inbox.empty')}</div>` → `<EmptyState size="compact" title={t('home.inbox.empty')} />` |

剩余 ~9 处（clarify.tsx / settings.tsx / workflows.launch.tsx / NodeDetailDrawer / ResourceList / SkillFileTree / SkillSourcesCard 等）留给后续 RFC 或 cleanup PR。

### 8.4 测试

- `tests/empty-state.test.tsx` 5 case
- `tests/loading-state.test.tsx` 3 case
- 每个迁移路由加 `tests/{route}-empty-loading.test.tsx`：
  - 源代码层 grep 锁：`<EmptyState` / `<LoadingState` 至少各出现 1 次
  - 旧 `<div className="muted">{t('common.loading')}</div>` 在该文件 0 次

---

## 9. `<DetailLayout>` 抽出

### 9.1 API

```tsx
// src/components/DetailLayout.tsx
export interface DetailLayoutProps {
  main: ReactNode
  aside?: ReactNode
  asideWidth?: 'sm' | 'md' | 'lg'   // 240 / 320 / 420
  asidePosition?: 'left' | 'right'  // default 'right'
  'data-testid'?: string
}
```

### 9.2 CSS

```css
.detail-layout {
  display: grid;
  gap: var(--space-4);
  /* 默认无 aside 时单列 */
  grid-template-columns: 1fr;
  min-height: 0;
  height: 100%;
}
.detail-layout--has-aside {
  grid-template-columns: 1fr var(--detail-layout-aside-w, 320px);
}
.detail-layout--has-aside.detail-layout--aside-left {
  grid-template-columns: var(--detail-layout-aside-w, 320px) 1fr;
}
.detail-layout--aside-sm { --detail-layout-aside-w: 240px; }
.detail-layout--aside-md { --detail-layout-aside-w: 320px; }
.detail-layout--aside-lg { --detail-layout-aside-w: 420px; }

.detail-layout__main, .detail-layout__aside {
  min-width: 0;
  min-height: 0;
}

@media (max-width: 720px) {
  .detail-layout--has-aside { grid-template-columns: 1fr; }
}
```

### 9.3 Retrofit

- `routes/tasks.detail.tsx`：当前 `.task-detail__panes` 是 flex 行 + 多 pane（task-detail 实际有 canvas + inspector）；retrofit 仅把外层 `<div className="task-detail__panes">` 替换为 `<DetailLayout main={<TaskCanvasFrame />} aside={<TaskInspectorPanel />} asideWidth="lg">`；保留 `.task-detail__pane` 内部业务样式不动。注意 RFC-021 引入的 tab-bar 仍在 main 内部
- `routes/reviews.detail.tsx`：`.review-detail__layout` → `<DetailLayout main aside asideWidth="md">`；保留 `.review-detail__sidebar-*`（RFC-009 产品有意视觉差异）

### 9.4 测试

- `tests/detail-layout.test.tsx` 4 case（aside 缺省 / aside-right / aside-left / aside-md/lg/sm）
- `tests/task-detail-layout-retrofit.test.tsx`：断言 task-detail 渲染包含 `<DetailLayout>` 锚 + 旧 `.task-detail__panes"` 在源代码不再出现
- `tests/review-detail-layout-retrofit.test.tsx`：同
- 现有 task-detail / review-detail e2e（`e2e/main.spec.ts` / `e2e/clarify.spec.ts`）不退化

---

## 10. 内联 style 清理

### 10.1 settings.tsx 6 处

| 行 | 当前 | 替换 |
| --- | --- | --- |
| 406 | `<div className="info-box-muted" style={{ marginTop: 16 }}>` | `<div className="info-box-muted stack-top--md">` 新增 utility `.stack-top--md { margin-top: var(--space-4); }` |
| 408 | `<p style={{ marginTop: 4, marginBottom: 8, fontSize: 13 }}>` | `<p className="settings-hint">`（局部 class，复用现有 `.muted` + 间距 token） |
| 413 | `<p style={{ marginTop: 8, fontSize: 13 }} className="muted">` | `<p className="muted stack-top--sm">` |
| 419 | `<p style={{ marginTop: 8, fontSize: 13 }} className="error-box">` | `<p className="error-box stack-top--sm">` |
| 726 | `<div className="info-box" role="status" aria-live="polite" style={{ marginTop: 12 }}>` | `<div className="info-box stack-top--sm" role="status" aria-live="polite">` |
| 728 | `<p style={{ marginTop: 4, marginBottom: 0, fontSize: 13 }}>` | `<p className="settings-hint">` 复用上面 |

需要在 styles.css 引入：

```css
.stack-top--sm { margin-top: var(--space-2); }
.stack-top--md { margin-top: var(--space-4); }
.stack-top--lg { margin-top: var(--space-5); }
```

（与 `.stack--sm` 区分：`.stack--*` 是 `& > * + *` 子项间距；`.stack-top--*` 是元素自身 margin-top。）

### 10.2 reviews.detail.tsx 5 处

| 行 | 性质 | 处置 |
| --- | --- | --- |
| 992 | dynamic style | 保留 |
| 1265 | dynamic style | 保留 |
| 1280 | `style={{ position: 'absolute', left: popover.rect.left, top: popover.rect.top }}` | 保留（运行时位置） |
| —— | 静态可迁移的 | 实际 5 处都包含 runtime computed value；保留全部 |

### 10.3 workflows.tsx 1 处

| 行 | 当前 | 处置 |
| --- | --- | --- |
| 74 | `style={{ display: 'none' }}` 用于隐藏 file input | 保留（标准做法） |

### 10.4 测试

- `tests/settings-inline-style-cleanup.test.ts`：源代码层断言 `routes/settings.tsx` 内 `style=\{\{` 出现 0 次（6 处全清理）
- `tests/reviews-detail-inline-style-allowlist.test.ts`：断言 `routes/reviews.detail.tsx` 内 `style=\{\{` 出现次数 ≤ 5（dynamic 例外列表）+ 这些行号在 allowlist 里

---

## 11. 失败模式

| 场景 | 应对 |
| --- | --- |
| 引入 token 后某 callsite 还在用硬编码（漏迁） | 不强制 100% 替换；audit 明确点都迁，新代码必须走 token；后续 RFC 做全量扫描 |
| `<StatusChip>` retrofit 后某场景视觉退化（颜色变深 / 边框变化） | 5 个 alias modifier（`--gray/--blue/--green/--red/--amber`）保留作 backward compat；测试用 `kind` prop 锚不锚具体类，让 visual fix 可以零回归改 CSS |
| `<Dialog>` focus trap 与已有 keyboard 行为冲突（如 esc 在某 dialog 已绑业务） | 提供 `closeOnEsc` / `closeOnOverlayClick` 两个 opt-out；现有 ReviewDecisionDialog / AgentImportDialog 默认都允许 ESC 关闭，retrofit 时保留行为 |
| `<DetailLayout>` retrofit 后 task-detail / review-detail 高度计算坏 | task-detail 当前 `.task-detail__panes` 是 `flex: 1; min-height: 0`；新 `.detail-layout` CSS 用 `height: 100%` + `min-height: 0` 等价处理 |
| 旧 CSS 命名空间保留 30 天导致 styles.css 膨胀 | 接受短期膨胀；最终 cleanup PR 独立提出 |
| 与 RFC-027 / RFC-031 并行改动冲突 | 严守路径精确 `git add`；本 RFC 不动 `components/canvas/` / `components/agents/AgentForm.tsx` 之外的他人 in-flight 文件 |

---

## 12. 测试策略总览

每个 PR 自带 3 类测试：

### 12.1 共享 component 单测（render matrix + a11y）

- `tests/status-chip.test.tsx` 10 case
- `tests/dialog.test.tsx` 8 case + body overflow
- `tests/empty-state.test.tsx` 5 case
- `tests/loading-state.test.tsx` 3 case
- `tests/detail-layout.test.tsx` 4 case

### 12.2 Retrofit 验证（每个 callsite 至少 1 个）

- 每个 retrofit 路由 / 组件加 `tests/{name}-retrofit.test.tsx`：用 component-level 锚（`data-testid` / `role`）验证新组件被引入 + 旧实现细节（class / 内联 style）不再出现

### 12.3 源代码层 grep 守卫（防回归）

- `tests/btn-variants-styles.test.ts`：`.btn--ghost` `.btn--xs` 在 styles.css 仍存在
- `tests/btn-variants-callsite.test.ts`：9 处 callsite 仍存在
- `tests/styles-tokens.test.ts`：每个 token 在 `:root` 仍存在 + dark 覆写命中
- `tests/status-chip-grep.test.ts`：retrofit 后 `<StatusChip>` 出现 ≥ 4 处
- `tests/tabs-retrofit-grep.test.ts`：旧 4 个命名空间 class 在业务文件 0 次
- `tests/data-table-callsite.test.ts`：`.data-table` 在 3 处推广目标 ≥ 1 次
- `tests/form-helper-callsite.test.ts`：7 处迁移路由 import `Form` ≥ 1 次
- `tests/dialog-grep.test.ts`：旧 dialog 类 0 次 + `<Dialog>` 出现 3 处
- `tests/empty-loading-callsite.test.ts`：9 处推广 `<EmptyState>` / `<LoadingState>` ≥ 1 次
- `tests/detail-layout-callsite.test.ts`：2 处 retrofit `<DetailLayout>` ≥ 1 次
- `tests/settings-inline-style-cleanup.test.ts`：settings.tsx `style=\{\{` 0 次

### 12.4 e2e（不退化）

- `e2e/main.spec.ts` / `e2e/clarify.spec.ts` / `e2e/agent-import.spec.ts`（如果存在）等保持绿；不新增 e2e（视觉一致化通过组件单测 + grep 锁覆盖足够）

### 12.5 整体门槛

- `bun run typecheck` 三 package 0 错
- `bun run test` 全套绿
- `bun run format:check` clean
- `bun run lint` clean
- Playwright e2e 在 CI 全绿

---

## 13. 与现有 RFC 的兼容性矩阵

| RFC | 影响面 | 兼容策略 |
| --- | --- | --- |
| RFC-001 runtime status | 0 | 不动 RuntimeStatusCard / 不动 `/settings#runtime` |
| RFC-005 human review | retrofit ReviewDecisionDialog 到 `<Dialog>` | 行为零变；仅 panel structure 通过共享组件提供。reviews 列表 retrofit 到 `.data-table` 时保留 RFC-009 sidebar 视觉。 |
| RFC-009 review sidebar | retrofit `.review-detail__layout` 到 `<DetailLayout>` | sidebar 内部不动；外层 grid 由 DetailLayout 提供 |
| RFC-010 markdown diff | 0 | 不动 MarkdownDiffView |
| RFC-018 agent.md import | retrofit AgentImportDialog 到 `<Dialog>` + `.tabs--inline` + `.data-table--compact` | 业务逻辑零变 |
| RFC-021 task detail tabs | retrofit `.task-detail__panes` 到 `<DetailLayout>` | tab-bar 内部不动；外层 grid 由 DetailLayout 提供 |
| RFC-023 agent clarify | retrofit clarify.detail.tsx 提交表单到 `<Form>` | i18n 不变；行为零变 |
| RFC-024 launch from git URL | retrofit RepoSourceTabs 到 `.tabs--segment` | 行为零变 |
| RFC-025 settings language switch | settings.tsx 内联 style 清理 | language switch 本身不动 |
| RFC-027 node session view | 0（不动 NodeDetailDrawer / 不动 session-flow CSS） | 仅把 `<div className="tabs inspector__tabs">` 改为 `<div className="tabs tabs--inspector">` |
| RFC-029 inventory | retrofit `<StatusBadge>` 内部走 `<StatusChip>` | API 零变；调用方零改动 |
| RFC-030 MCP probe | retrofit `<McpProbeStatusChip>` 内部走 `<StatusChip>` | API 零变 |
| RFC-031 agent plugin deps | 0 | 不动 |
| RFC-032 nav redesign | RFC-035 紧跟 RFC-032 全 3 PR 落地后启动 | sidebar / nav / footer 不动；homepage task-row__status 收敛到 `<StatusChip>` |
| RFC-033 batch import | retrofit BatchImportDialog 的 `.modal` 到 `<Dialog>` | 业务逻辑零变 |
| RFC-034 submodule | 0 | 不动 |

---

## 14. 未尽事项 / 后续 RFC

- **RFC-036 候选**：响应式 / 移动端断点 / 第二主题 / dropdown / popover / tooltip 共享 component。
- **Cleanup PR**：旧命名空间 CSS（`.agent-import__*` 大段 / `.review-decision-dialog__*` / `.repo-source-tabs*` / `.inspector__tabs` / `.mcp-probe-chip` / `.status-badge` / `.reviews-row__*` / `.repos-table*` / `.batch-import-dialog.modal`）在 RFC-035 全 3 PR 落地 + 1 个 release 周期后，独立 cleanup PR 一次性删完。预估 -400~500 行 styles.css。
- **token 全量替换**：本 RFC 不追求散落硬编码字号 / 间距 100% 替换，仅 audit 明确指出 + 内联 style 清理；后续 RFC 做全量。
