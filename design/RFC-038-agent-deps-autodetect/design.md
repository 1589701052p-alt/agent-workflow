# RFC-038 — 技术设计

> 配套 [proposal.md](./proposal.md)。proposal 钉产品意图；本文件钉技术契约、文件级落点、测试矩阵。

## 1. 模块拓扑

```
packages/frontend/
  src/
    lib/
      agent-dep-detect.ts                       # 纯函数：detectAgentDeps + mergeAgentDeps
    components/
      AgentForm.tsx                             # 在 fieldDependencyTree 上方挂载新行
      agents/
        DependencyAutodetectButton.tsx          # 按钮 + 状态封装（disabled/loading）
        DependencyAutodetectDialog.tsx          # 弹窗 UI（四组 checkbox + footer 操作）
    i18n/
      zh-CN.ts                                  # +9 keys
      en-US.ts                                  # +9 keys（Resources 接口同步扩展）
  tests/
    agent-dep-detect.test.ts                    # 纯函数单测
    agent-dep-autodetect-button.test.tsx        # disabled 态 + 点击打开 dialog
    agent-dep-autodetect-dialog.test.tsx        # 渲染分组 + 勾选 + 导入 / 取消 / 空态 / 失败态
    i18n-autodetect-keys.test.ts                # 键存在 + 中英对称
```

不动模块：

- backend / shared / DB / migration / runner / scheduler / WS / opencode plugin / workflow editor。
- 既有 `AgentDependsPicker` / `SkillsPicker` / `McpsPicker` / `PluginsPicker`：query keys 完全复用，不改它们的内部行为。
- `DependencyTreePreview`：闭包预览靠现有 200ms debounce 自动随 `onChange` 重算，本 RFC 不直接 invalidate。

## 2. 数据流

```
点击按钮
  └─→ 读 react-query 缓存：AGENTS_QUERY_KEY / SKILLS_QUERY_KEY / MCPS_QUERY_KEY / PLUGINS_QUERY_KEY
        （未命中或 stale 走各 picker 已有 useQuery，本组件只 useQuery 同 key 复用缓存）
  └─→ detectAgentDeps(bodyMd, inventory, value, selfName) → Candidates
  └─→ setOpen(true) + setSelected(Candidates 全选初始态)
        ↓
打开 Dialog
  └─→ 渲染四组 checkbox（非空组），footer = [取消, 导入选中]
  └─→ checkbox 变化 → setSelected
        ↓
点 "导入选中"
  └─→ next = mergeAgentDeps(value, selected) （pure，append + dedupe）
  └─→ onChange(next)
  └─→ setOpen(false)
        ↓
AgentForm 因 value 变化重渲染 → DependencyTreePreview 触发 200ms debounce → 闭包重算
```

## 3. 纯函数契约（`lib/agent-dep-detect.ts`）

```ts
import type { CreateAgent, Agent, Skill } from '@agent-workflow/shared'

/** 把 inventory 行抽象为同形 record，detect 不依赖具体 schema 差异。 */
export interface DetectInventoryRow {
  name: string
  description?: string
}

export interface DetectInventory {
  /** 缺省（query 还在 pending 或 error）传 `undefined`，本组不参与检测。 */
  agents?: readonly DetectInventoryRow[]
  skills?: readonly DetectInventoryRow[]
  mcps?: readonly DetectInventoryRow[]
  plugins?: readonly DetectInventoryRow[]
}

export interface DetectExisting {
  dependsOn: readonly string[]
  skills: readonly string[]
  mcp: readonly string[]
  plugins: readonly string[]
}

export interface DetectionGroup {
  /** 命中的候选 row，保留 inventory 中传入的顺序，去重。 */
  candidates: readonly DetectInventoryRow[]
}

export interface DetectionResult {
  agents: DetectionGroup
  skills: DetectionGroup
  mcps: DetectionGroup
  plugins: DetectionGroup
}

export function detectAgentDeps(
  bodyMd: string,
  inventory: DetectInventory,
  existing: DetectExisting,
  selfName: string,
): DetectionResult
```

**实现要点（用语言锁住，prompt-driven 实现时 1:1 落代码）**：

- `body = bodyMd ?? ''`；若 `body === ''` → 四组候选全空（fast path）。
- 对四组分别执行：
  1. `rows = inventory.<group> ?? []`；
  2. 过滤 `r.name.length > 0 && r.name !== selfName`；
  3. 过滤 `!existing.<groupField>.includes(r.name)`；
  4. 过滤 `body.includes(r.name)`；
  5. 按 name 去重（保留 inventory 内的首次出现）；
  6. 入 `candidates`。
- `selfName` 仅对 `agents` 组有意义（其它三组不可能等于自身 agent 名 —— 但同样过滤以求一致）。
- 返回值 immutable；输入数组**不**被修改。

```ts
export function mergeAgentDeps(
  value: CreateAgent,
  selection: {
    agents: readonly string[]
    skills: readonly string[]
    mcps: readonly string[]
    plugins: readonly string[]
  },
): CreateAgent
```

**实现要点**：

- 对每个数组：`merged = [...(value.<field> ?? []), ...selection.<field>.filter(n => !(value.<field> ?? []).includes(n))]`。
- 返回新对象 `{ ...value, dependsOn: mergedAgents, skills: mergedSkills, mcp: mergedMcps, plugins: mergedPlugins }`；其它字段不动；`value` 不被 mutate。
- 若四组 selection 全空 → 返回 `value` 本身（同一引用，避免无意义 onChange 触发 re-render；测试断言 `result === value`）。

## 4. 前端 UI

### 4.1 `AgentForm.tsx`

在 `<Field label={t('agentForm.fieldDependsOn')}>` 之后、`<Field label={t('agentForm.fieldDependencyTree')}>` **之前**，插入一行：

```tsx
<DependencyAutodetectButton
  bodyMd={value.bodyMd ?? ''}
  value={value}
  selfName={value.name}
  onApply={(selection) => onChange(mergeAgentDeps(value, selection))}
/>
```

> `DependencyAutodetectButton` 自己内部 `useState` 管理 dialog 开关与 selected 集合，把"打开 → 检测 → 渲染 dialog → 收取选择 → 调 onApply"完整封装。AgentForm 仅传输入和 callback。

### 4.2 `components/agents/DependencyAutodetectButton.tsx`

职责：

- `useQuery` 四组 inventory（与四个 picker 共享 query key 与 staleTime；`retry: false`）。
- 计算按钮 disabled 态：`bodyMd.trim() === ''` 或 全部四个 query `isPending`（仍可点但内部禁用）。
- 点击：`detectAgentDeps(...)` → `setResult` → 打开 `<DependencyAutodetectDialog>`。
- Dialog 内部 onApply 收到 selection → 调 props.onApply(selection) → 关 dialog。

按钮形态：

```tsx
<div className="agent-form__autodetect-row">
  <button
    type="button"
    className="btn btn--ghost btn--sm"
    disabled={isDisabled}
    title={isDisabled ? t('agentForm.autodetect.disabledHint') : undefined}
    onClick={onOpen}
  >
    {t('agentForm.autodetect.button')}
  </button>
</div>
```

新增 css（`styles.css` 末尾追加）：

```css
.agent-form__autodetect-row {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--space-2);
}
```

### 4.3 `components/agents/DependencyAutodetectDialog.tsx`

骨架（沿用 RFC-035 PR3 `<Dialog>`）：

```tsx
<Dialog
  open={open}
  onClose={onClose}
  title={t('agentForm.autodetect.dialogTitle')}
  size="md"
  data-testid="agent-dep-autodetect-dialog"
  footer={
    hasAnyCandidate ? (
      <>
        <button className="btn btn--ghost" onClick={onClose}>
          {t('agentForm.autodetect.cancelButton')}
        </button>
        <button className="btn btn--primary" onClick={onApply} disabled={selectedCount === 0}>
          {t('agentForm.autodetect.applyButton', { count: selectedCount })}
        </button>
      </>
    ) : (
      <button className="btn btn--primary" onClick={onClose}>
        {t('agentForm.autodetect.closeButton')}
      </button>
    )
  }
>
  {/* body */}
</Dialog>
```

Body 渲染规则：

- 顶部 hint：`<p className="muted">{t('agentForm.autodetect.dialogHint')}</p>`（说明 contains 语义，提醒人工确认）。
- 四个 section 依次渲染：`agents / skills / mcps / plugins`；每组若 `candidates.length === 0` 整段隐藏。
- Section 标题：`<h3>{t(`agentForm.autodetect.section.<group>`, { count: n })}</h3>`。
- 每行：`<label><input type="checkbox" checked={selected.has(name)} onChange=...>{name}{description ? ' — ' + description : ''}</label>`，class `agent-dep-autodetect__row`。
- 若四组全空：渲染 `<EmptyState>` 共享组件，文案 `agentForm.autodetect.emptyText`。
- 若任意 query `isError`：底部追加 muted 一行 `agentForm.autodetect.groupLoadFailed`（按组名插值），不打断其它组渲染。

### 4.4 i18n keys（中英对称，共 9 个）

```
agentForm.autodetect.button                 "自动识别依赖"                                / "Auto-detect dependencies"
agentForm.autodetect.disabledHint           "请先填写 agent 正文"                          / "Fill in the agent body first"
agentForm.autodetect.dialogTitle            "识别到的潜在依赖"                              / "Detected potential dependencies"
agentForm.autodetect.dialogHint             "按子串匹配，请人工确认每一项"                  / "Matched by plain substring — review each item before importing"
agentForm.autodetect.section.agents         "Agents（{{count}}）"                          / "Agents ({{count}})"
agentForm.autodetect.section.skills         "Skills（{{count}}）"                          / "Skills ({{count}})"
agentForm.autodetect.section.mcps           "MCPs（{{count}}）"                            / "MCPs ({{count}})"
agentForm.autodetect.section.plugins        "Plugins（{{count}}）"                         / "Plugins ({{count}})"
agentForm.autodetect.emptyText              "未识别到新依赖"                                / "No new dependencies detected"
agentForm.autodetect.groupLoadFailed        "{{group}} 列表加载失败，已跳过"                / "Failed to load {{group}} list; skipped"
agentForm.autodetect.cancelButton           "取消"                                          / "Cancel"
agentForm.autodetect.applyButton            "导入选中（{{count}}）"                         / "Import selected ({{count}})"
agentForm.autodetect.closeButton            "关闭"                                          / "Close"
```

> 上表 13 行；其中 cancel / close / applyButton 之前可能已有同义 key（如 `common.cancel`）。落实现时优先复用 `common.*`：若 `common.cancel` 存在则按钮直接 `t('common.cancel')`，i18n keys 新增数会少于 9。最终新增 key 数以"现状无重复可用项"为准；测试断言以"按钮文案非空"为准而非 key 字面。

`Resources` 接口扩展（仅枚举新增的 9 个；如复用 common 则相应缩减）：在 zh-CN.ts / en-US.ts 类型推导处自动同步。

## 5. 兼容与并发

- **多人 working tree**：本 RFC 仅新增 1 lib 文件 + 2 component 文件 + 1 css 块 + 1 行 import + i18n 块。AgentForm 里**仅追加一行**，不删 / 不重排既有 Field。冲突面极小。
- **与 RFC-022 闭包预览**：本 RFC 写入 `value.dependsOn` 后由 `DependencyTreePreview` 自然 debounce 重算，零联动改动。
- **与 RFC-031 plugin 急安装**：本 RFC **仅**把 plugin name 加进 `value.plugins`；plugin 急安装走的是 `/plugins` 页"创建 / 升级"路径，与 agent 表单 picker 选名行为完全一致。本 RFC 不触发任何 plugin install。
- **与 RFC-036 多用户协作**：detect / merge 纯前端，与 owner / collaborator 过滤正交。
- **schema_version**：不动 agent schema，本 RFC 不 bump。
- **回退**：单 commit `git revert`。零 DB / API / WS breaking。

## 6. 测试策略

总量目标 ≥ 18。

### 6.1 `tests/agent-dep-detect.test.ts`（≥ 10 case）

1. body 为空 → 四组候选全空。
2. body 含 agent 名 → agents 组命中；其它组不命中。
3. body 含同名但已在 existing.dependsOn → 不入候选。
4. body 含 selfName → agents 组排除自身。
5. body 含 skill 名 + mcp 名 + plugin 名 → 三组各 1 命中。
6. inventory.agents 顺序 `[a, b, c]`，body 都命中 → candidates 顺序 `[a, b, c]`。
7. inventory 含重名（同 name 多行，理论 DB 约束不允许但稳健测）→ 去重，首次出现保留。
8. inventory 行 name 为空字符串 → 不参与检测（避免 `includes('')` 退化）。
9. `inventory.skills === undefined`（query failed / pending）→ skills 组候选空；其它组照常。
10. case sensitive：body 含 `Foo`，inventory 含 `foo` → 不命中（区分大小写）。
11. body 含字串 `digit-validator-extra`，inventory 含 `digit-validator` → 命中（contains 即可，子串包含也算）。

### 6.2 `tests/agent-dep-merge.test.ts`（≥ 4 case）

1. 全部 selection 空 → 返回引用相等（`result === value`）。
2. selection.agents = `['a']`，value.dependsOn = `[]` → 结果 `dependsOn = ['a']`。
3. selection.agents = `['a']`，value.dependsOn = `['a', 'b']` → 去重，仍 `['a', 'b']`。
4. selection 四组都有值 → 四个数组都追加；未涉及字段（如 bodyMd、permission）保持 reference 不变。

### 6.3 `tests/agent-dep-autodetect-button.test.tsx`（≥ 2 case）

1. `bodyMd = ''` → 按钮 disabled + title 提示文案出现。
2. 点击按钮 → dialog 打开（`getByTestId('agent-dep-autodetect-dialog')` 可见）。

### 6.4 `tests/agent-dep-autodetect-dialog.test.tsx`（≥ 4 case）

1. mock 四组 inventory + body 各命中一项 → dialog 显示四组 section 与对应候选行。
2. 默认全部 checkbox checked；取消其中一个；点「导入选中」→ `onApply` 收到的 selection 不含被取消项；onClose 被调。
3. 点「取消」→ `onApply` 没被调；dialog 关闭。
4. 四组候选全空（body 无命中）→ 渲染 EmptyState；底部只有「关闭」按钮（无「导入选中」）。

### 6.5 `tests/i18n-autodetect-keys.test.ts`（≥ 2 case）

1. 中英 keys 全部存在 + 非空 string。
2. `Resources` 接口扩展（typecheck 在 build 阶段卡死，本测试只做 runtime 存在性断言）。

### 6.6 fixture / 既有测试影响

- `AgentForm.test.tsx`（若存在）：本 RFC 在 AgentForm 中**追加一行**，不动既有断言；可能因 DOM 增加一个按钮触发 snapshot 断言失败。落实现时如发现 snapshot 测试，更新快照；非 snapshot 断言（`getByRole('textbox', { name: ... })` 等）不受影响。
- 不预期触发其它套件 fixture 改动。

### 6.7 e2e（可选）

不强增。若实现时间充裕，在 `e2e/main.spec.ts` 既有 agent 编辑流里追加 1 case：填 body → 点按钮 → 确认 dialog 出现 → 关闭。非验收必要。

## 7. 失败模式

| 场景                                 | 行为                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| inventory query 失败（任一）         | 该组从 detect 输入剔除（`undefined`），dialog 底部 muted 一行提示加载失败          |
| body 极长（> 1MB）                   | detect 函数依然纯函数 O(N×K) 完成；UI 不卡顿（v1 不引 worker）；测试用例不强制覆盖 |
| 用户重复点按钮                       | 每次重新 `detectAgentDeps` + reset selected，行为可重入                            |
| onApply 抛错（理论不可能 —— 纯赋值） | dialog 不关；error 冒泡到 AgentForm 现有 try/catch 之外，靠 React error boundary   |
| selfName 改名后再点                  | 用新 selfName 重新检测，旧 selfName 不再被排除（预期）                             |
| body 含转义字符 / emoji / CJK        | 按 UTF-16 字符 includes 比对；JS string 原生行为                                   |

## 8. 与 opencode 源码的关系

无。本 RFC 不涉及 opencode 进程 / CLI / env / XML envelope / config 加载顺序。runner / scheduler 零改动。
