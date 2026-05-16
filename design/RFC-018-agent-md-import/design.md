# RFC-018 Design — 新建代理导入 agent.md 技术设计

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 总览

整条流程纯前端 + shared 纯函数，零 backend / DB 改动：

```
┌──────────────────────────────┐   raw text   ┌────────────────────────────────────┐
│ AgentImportDialog (frontend) │──────────────►│ parseAgentMarkdown (shared, pure) │
│  - file <input> / textarea   │               │  yaml frontmatter + body          │
│  - Parse / Apply buttons     │◄──────────────│  → { partial, warnings, unrec[] } │
└──────────────────────────────┘   structured  └────────────────────────────────────┘
              │
              │ Apply 合并
              ▼
   AgentForm value (existing CreateAgent state in agents.new.tsx)
```

测试金字塔以 parser 单测为底（纯函数，无 DOM、最容易覆盖边界）；UI 层只跑少量集成断言。

## 2. shared 层：`parseAgentMarkdown`

### 2.1 文件位置

新增 `packages/shared/src/agent-md.ts`，从 `packages/shared/src/index.ts` 重导出。复用 `yaml` 包（已是 backend 依赖；shared 目前没用 yaml，需要在 shared `package.json` 加 `yaml` 依赖——npm 单包内已经存在，pnpm/bun workspace 直接 hoist 不增 lock 体积）。

> 备选：让 parser 接收已解析的 `data` 对象 + body 字符串，把 YAML 解析放到 frontend 调用层。这样 shared 完全不依赖 yaml。
> 决策：放在 shared 里更内聚，且 backend 后续可能也想用（例如未来从 `~/.opencode/agents/` 批量扫描）。**加 `yaml` 到 shared package**。

### 2.2 签名

```ts
export interface AgentMarkdownParseResult {
  partial: Partial<CreateAgent>
  warnings: string[]
  /** Keys we saw in frontmatter but didn't map to a CreateAgent field. They are
   *  preserved in `partial.frontmatterExtra`; this list is only for UI display. */
  unrecognizedKeys: string[]
  /** Whether the input had a valid frontmatter block at all. False = no `---`
   *  pair; entire input went to bodyMd. */
  hadFrontmatter: boolean
}

export interface AgentMarkdownParseOptions {
  /** Used to seed `partial.name` when frontmatter has no `name`. Stem only
   *  (caller strips extension). */
  filenameStem?: string
}

export function parseAgentMarkdown(
  raw: string,
  opts?: AgentMarkdownParseOptions,
): AgentMarkdownParseResult
```

### 2.3 解析流程

```
1. parseFrontmatterText(raw) → { data, body, hadFrontmatter }
   - 使用与 packages/backend/src/util/frontmatter.ts 相同的正则；提到 shared 里复用
   - YAML.parse 抛错 → return { data: {}, body: raw, hadFrontmatter: true (有 --- 但内容坏) }
     在 result.warnings 加 `yaml-parse-failed: ${err.message}`
   - data 不是 plain object（数组 / null / 标量）→ data = {} + warning
2. 已知字段直接抽取（带类型校验，类型错的丢 extra + warning）：
   description: string
   model: string
   variant: string
   temperature: number (0..2)  // 注：opencode 允许 0..1，但本框架 schema 是 0..2；导入时不二次校验，留给 zod 提交校验
   steps: positive int
   maxSteps: positive int
   permission: plain object
3. tools normalize（仅当存在 `tools` 且为 plain object）：
   for (k, v) of tools:
     if k in {write,edit,patch}: derivedPermission.edit = v ? 'allow' : 'deny'
     else: derivedPermission[k] = v ? 'allow' : 'deny'
   再 Object.assign(derivedPermission, explicitPermission)
   partial.permission = derivedPermission
   `tools` 不进 frontmatterExtra（已消费）
4. maxSteps coalesce：
   if steps == null and maxSteps != null: partial.steps = maxSteps
   partial.maxSteps 仍单独写入（如果文件有 maxSteps）
5. name 解析：
   if data.name is non-empty string: partial.name = data.name
   else if opts.filenameStem: partial.name = opts.filenameStem
   else: 留空（不写 partial.name）
6. body：
   partial.bodyMd = body.replace(/^\s+/, '').replace(/\s+$/, '')
   若 body 为空且 hadFrontmatter=false → 不设置 partial.bodyMd
7. 收集 unrecognizedKeys：
   KNOWN = name/description/model/variant/temperature/steps/maxSteps/permission/tools
   for (k in data): if not in KNOWN: extra[k] = data[k]; unrecognizedKeys.push(k)
   partial.frontmatterExtra = extra（仅当非空）
```

返回的 `partial` 字段都是 optional——caller 用 `{...current, ...partial}` 合并，其中 `frontmatterExtra` 浅合并（见 §3.3）。

### 2.4 字段类型校验细节

- 任何字段类型不匹配（例如 `model: 42`、`permission: "allow"`）→ 丢进 `frontmatterExtra[key]` + warning `<key> must be <type>; kept in frontmatterExtra`。
- `temperature` 必须是有限 number；NaN / Infinity → extras + warning。
- `steps / maxSteps` 必须是 positive integer；浮点 / 负数 → extras + warning。

## 3. frontend 层

### 3.1 新组件 `AgentImportDialog`

`packages/frontend/src/components/AgentImportDialog.tsx`

Props：

```ts
interface AgentImportDialogProps {
  open: boolean
  onClose: () => void
  /** Called when user clicks Apply; receives parser result + filename if any. */
  onApply: (result: AgentMarkdownParseResult) => void
  /** Current form value, used to compute "will overwrite" field list. */
  currentValue: CreateAgent
}
```

布局：

```
┌─ Import from agent.md ────────────────────────────────┐
│ [Upload file] [Paste text]   <tab strip>              │
│                                                       │
│  ┌─ Upload tab ──────────────────────────────────────┐│
│  │ <input type="file" accept=".md,.markdown,text/*"> ││
│  │ <filename label>                                  ││
│  └───────────────────────────────────────────────────┘│
│                                                       │
│  ┌─ Paste tab ───────────────────────────────────────┐│
│  │ <textarea monospace rows=14 placeholder="---\n…"> ││
│  └───────────────────────────────────────────────────┘│
│                                                       │
│  [Parse]                                              │
│                                                       │
│ ── Preview (collapsed before Parse) ─────────────     │
│ Warning bar (if any): yaml-parse-failed: …            │
│ Overwrite warning (if any): "Apply will overwrite N…" │
│ field table:                                          │
│   name           │ "code-reviewer"     → name         │
│   description    │ "…"                 → description  │
│   permission     │ { edit: deny, … }   → permission   │
│   mode           │ "primary"           → frontmatterExtra│
│   color          │ "#FF5733"           → frontmatterExtra│
│   body           │ "(2.1 KB)"          → bodyMd       │
│                                                       │
│ [Cancel]                            [Apply]           │
└───────────────────────────────────────────────────────┘
```

实现细节：

- Tab 切换用本地 state，不动 URL。
- Upload tab：用 `<input type="file">`，`onChange` 读取 `file.text()` → 设置 `rawText` + `filenameStem`（去 `.md` / `.markdown`）。
- Paste tab：受控 textarea，`onChange` 设置 `rawText`，`filenameStem = undefined`。
- Parse 按钮：当 `rawText` 非空时启用；点击调用 `parseAgentMarkdown(rawText, { filenameStem })`，结果写入本地 state `parseResult`。
- Apply 按钮：仅当 `parseResult` 存在且没有 `yaml-parse-failed` warning 时启用；点击调用 `onApply(parseResult)` 然后 `onClose()`。
- "will overwrite" 计算：对每个 `partial` 里非 undefined 的 key，看 `currentValue[key]` 是否与 `emptyAgent()[key]` 不同（即用户改过）。把这些 key 列在红字提示里。

### 3.2 集成到 `agents.new.tsx`

`packages/frontend/src/routes/agents.new.tsx` 在 AgentForm 之上插入一个 Import 按钮 + 对话框：

```tsx
const [importOpen, setImportOpen] = useState(false)
…
<div className="agent-new-toolbar">
  <Button variant="ghost" onClick={() => setImportOpen(true)}>
    {t('agentForm.importButton')}
  </Button>
</div>
<AgentForm value={value} onChange={setValue} />
<AgentImportDialog
  open={importOpen}
  onClose={() => setImportOpen(false)}
  currentValue={value}
  onApply={(res) => setValue((prev) => mergeAgentImport(prev, res))}
/>
```

`/agents/$name`（编辑路由）**不**渲染这个按钮——这是 `/agents/new` 路由独占的 UX。

### 3.3 合并函数 `mergeAgentImport`

放 `packages/frontend/src/lib/agent-import-merge.ts`（纯函数，方便单测）：

```ts
export function mergeAgentImport(
  current: CreateAgent,
  result: AgentMarkdownParseResult,
): CreateAgent {
  const next: CreateAgent = { ...current }
  for (const [k, v] of Object.entries(result.partial)) {
    if (v === undefined) continue
    if (k === 'frontmatterExtra') {
      next.frontmatterExtra = {
        ...(current.frontmatterExtra ?? {}),
        ...(v as Record<string, unknown>),
      }
    } else {
      ;(next as any)[k] = v
    }
  }
  return next
}
```

`outputs / outputKinds / readonly / syncOutputsOnIterate / skills` 不在 parser 输出里，因此原值不变。

## 4. UI 复用 & i18n

- 复用 `Field / TextArea / Switch` 等已有 form primitives；不引入新设计系统组件。
- 对话框样式参考 `WorkflowYamlImportDialog`（`packages/frontend/src/components/WorkflowYamlImportDialog.tsx` 如存在）；若没有就用与 settings 页同款的 `Modal` / 简易 `<dialog>` HTML 元素。导入时先 grep 现有 modal 模式再做决策。
- 新增 i18n 键（中英）：
  - `agentForm.importButton` = "导入 agent.md" / "Import from agent.md"
  - `agentForm.importDialog.title`
  - `agentForm.importDialog.tabUpload` / `tabPaste`
  - `agentForm.importDialog.parseButton` / `applyButton` / `cancelButton`
  - `agentForm.importDialog.previewEmpty`
  - `agentForm.importDialog.willOverwrite` (插值：fields)
  - `agentForm.importDialog.warningYaml`
  - `agentForm.importDialog.routedTo.description` / `model` / `permission` / `frontmatterExtra` / `bodyMd` / `ignored`
  - `agentForm.importDialog.footerHint` = "Fills the form below; you still need to save."

## 5. 与 opencode normalize 的对齐边界

我们只复现 opencode normalize 中**对 frontmatter 字段语义不变**的两条：

| opencode normalize | 本 RFC 采纳？ | 备注 |
|---|---|---|
| 未知 key → `options` | ✗ | 本框架对应字段叫 `frontmatterExtra`；直接塞进去 |
| `tools` deprecated → `permission` | ✓ | 见 §2.3 step 3 |
| `steps ?? maxSteps` coalesce | 部分 ✓ | 我们 schema 有独立 `maxSteps` 列，所以两者都保留；仅当 `steps` 缺失时用 `maxSteps` 填 `steps` |

不做：

- 不验证 model id 是否在 ConfigModelID 表里——交给运行时 / 表单 zod 校验。
- 不验证 color 是否合法 hex / theme key——原样进 frontmatterExtra。
- 不解析 `prompt` 字段（opencode 里允许 `prompt: string` 字段替代 body）——若文件用了 `prompt` 字段，我们把它塞进 `frontmatterExtra`，并在 warning 里提示 "use markdown body instead of `prompt` field"。本框架 `bodyMd` 才是规范来源。

## 6. 测试策略

### 6.1 Shared parser 单测（`packages/shared/tests/agent-md.test.ts`，新增）

每条 case 都断言 `partial` 完整结构 + `warnings` 数组 + `unrecognizedKeys` 数组：

1. **happy-path 最小**：frontmatter 仅 `description`、body 一行。`partial = { description, bodyMd }`，无 warning。
2. **完整字段**：name / description / model / variant / temperature / steps / permission / mode / color / body。partial 包含前 7 个 + bodyMd；frontmatterExtra={mode, color}；unrecognizedKeys=['mode','color']。
3. **tools normalize**：`tools: { write: false, bash: true, read: true }` 无显式 permission → `partial.permission = { edit: 'deny', bash: 'allow', read: 'allow' }`；tools 不进 extras。
4. **tools + 显式 permission（显式优先）**：`tools: { write: true, edit: false }`（write 与 edit 都映射到 edit），`permission: { edit: 'ask' }` → 最终 `permission.edit = 'ask'`。
5. **maxSteps coalesce**：仅 `maxSteps: 50` → `partial.steps = 50` 且 `partial.maxSteps = 50`；两者都在 → steps=fileSteps, maxSteps=fileMaxSteps。
6. **YAML 失败**：frontmatter 内容是 `key: : :` → warnings 含 `yaml-parse-failed:` 前缀；partial 仅含 bodyMd（若有 body）；hadFrontmatter=true。
7. **无 frontmatter**：整段输入无 `---` → partial.bodyMd = trim(input)；hadFrontmatter=false；其它字段未设置。
8. **数组型 frontmatter**：`---\n- a\n- b\n---\nbody` → data 被丢弃；partial.bodyMd='body'；warning 含 `frontmatter-not-object`。
9. **null frontmatter**：`---\n\n---\nbody` → partial={ bodyMd:'body' }。
10. **body trim**：body 前后多行空行 → bodyMd 去掉首尾空白；中间空行保留。
11. **filenameStem fallback**：data 无 name；opts.filenameStem='reviewer' → partial.name='reviewer'。
12. **frontmatter.name 优先**：data.name='x'、filenameStem='y' → partial.name='x'。
13. **类型错误丢 extras**：`model: 42` → frontmatterExtra.model=42 + warning `model must be string …`；partial 不含 model。
14. **permission 非对象**：`permission: "allow"` → frontmatterExtra.permission='allow' + warning。
15. **body 含多个 `---`**：第一个 frontmatter 块解析正常；body 里多余 `---` 原样保留。
16. **unicode + 中文**：description 含中文 → 不丢字符。

### 6.2 Frontend 单测

`packages/frontend/tests/agent-import-merge.test.tsx`（新增，纯函数）：

- 空 current + partial 包含若干字段 → merged 等于 partial 覆盖到 emptyAgent 上。
- current 已有 frontmatterExtra={a:1}，partial.frontmatterExtra={b:2} → merged.frontmatterExtra={a:1,b:2}。
- current 已有 frontmatterExtra={a:1}，partial.frontmatterExtra={a:9} → merged.a=9（导入覆盖同名）。
- partial 某字段 undefined → merged 保留 current 原值。

`packages/frontend/tests/agent-import-dialog.test.tsx`（新增，集成）：

- 渲染 dialog 打开态，默认 Upload tab，点击 Parse 在 rawText 为空时 disabled。
- 切到 Paste tab，输入合法 markdown → Parse → preview 字段列出现 → Apply → onApply 被调用且参数为 parser 返回值。
- 输入 YAML 失败的内容 → Parse → 红字 warning 出现 → Apply disabled。
- currentValue 已有 description='x'，partial.description='y' → preview 顶部出现 willOverwrite 提示，列出 'description'。

`packages/frontend/tests/agents-new-import-button.test.tsx`（新增，最小源码/渲染层兜底）：

- `/agents/new` 渲染存在 Import 按钮 testid。
- `/agents/$name` 路由组件**源码层**断言不出现 `AgentImportDialog` 导入（grep 文本断言）。

### 6.3 不需要的测试

- 不写 backend / DB 测试（无后端改动）。
- 不写 E2E playwright；已有覆盖足够。

## 7. 失败模式 & 边界

| 场景 | 行为 |
|---|---|
| 上传的不是文本文件（二进制） | `file.text()` 仍返回字符串（可能乱码）→ parser 大概率 yaml-parse-failed；UI 显示 warning，Apply disabled |
| 文件大于 2 MB | 不显式拦截（不应用代码加限制；agent.md 现实不会这么大）；如果真碰到性能问题再加 |
| 同时打开 Upload 和 Paste tab 输入了内容 | 仅以当前 active tab 的 rawText 为准 |
| 用户在 Parse 后又改了 rawText 但没重新点 Parse | preview 仍显示旧结果；Apply 用旧结果——可接受（按钮文字暗示 Parse 是显式步骤） |
| 同一 session 多次 Import | 每次 Apply 都做覆盖 + frontmatterExtra 浅合并 |

## 8. 文件清单（落地时编辑/新增）

新增：
- `design/RFC-018-agent-md-import/{proposal,design,plan}.md`
- `packages/shared/src/agent-md.ts`
- `packages/shared/tests/agent-md.test.ts`
- `packages/frontend/src/components/AgentImportDialog.tsx`
- `packages/frontend/src/lib/agent-import-merge.ts`
- `packages/frontend/tests/agent-import-merge.test.tsx`
- `packages/frontend/tests/agent-import-dialog.test.tsx`
- `packages/frontend/tests/agents-new-import-button.test.tsx`

修改：
- `packages/shared/src/index.ts`（重导出 parser + 类型）
- `packages/shared/package.json`（加 `yaml` 依赖；版本对齐 backend）
- `packages/frontend/src/routes/agents.new.tsx`（加 toolbar + dialog 集成）
- `packages/frontend/src/lib/i18n/locales/{zh,en}.json`（或对应 i18n 文件）—— 新增上述 key
- `design/plan.md`（RFC 索引表追加 RFC-018 一行）
- `STATE.md`（追加"进行中 RFC: RFC-018"行；完工时改 Done 并补已完成表）
