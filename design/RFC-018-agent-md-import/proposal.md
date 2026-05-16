# RFC-018 Proposal — 新建代理支持导入 agent.md 自动填表

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 参考：[opencode Agents](https://opencode.ai/docs/agents/)、`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/agent.ts`

## 1. 背景

`/agents/new` 当前只能逐字段手填。但 opencode 本身用 `agent.md`（YAML frontmatter + markdown body）作为 agent 定义的事实标准，社区里大量已有的 agent 文件可以复用——例如从其它仓的 `.opencode/agents/` 直接拿过来贴进来。

现状的痛点：

1. **复制粘贴成本高**：用户拿到一份 agent.md 文件后，必须逐字段抄进表单（description、model、temperature、permission、steps、body）。permission 这种 JSON 对象抄写最容易写错。
2. **缺少导入入口**：仓里已有 `parseFrontmatter`（`packages/backend/src/util/frontmatter.ts`）能解析 YAML frontmatter，但只用于运行时 SKILL.md 解析，新建表单完全没有暴露这条路径。
3. **opencode 字段映射缺失**：opencode agent frontmatter 里有 `mode / hidden / color / disable / top_p / options / tools`（deprecated）等本框架 schema 不直接支持的字段，需要明确的"识别后塞 frontmatterExtra"策略，否则用户手抄时容易把这些字段丢掉。

需求语句：

> 新建代理支持导入 agent 文件自动填写相关字段。

## 2. 目标

**做**

- 在 `/agents/new` 的 `AgentForm` 顶部加一个 **Import from agent.md** 按钮；点开后弹出一个对话框，提供两种输入路径：**上传 `.md` / `.markdown` 文件**，或**直接粘贴文本**到 textarea。
- 对话框里有 "Parse" 按钮，触发解析后展示**字段对照预览**（左列识别到的字段名 / 值；右列简短说明，例如 `→ description`、`→ permission`、`→ frontmatterExtra`、`(ignored)`）。
- 用户点 "Apply" 后，把解析结果合并进当前 AgentForm 草稿（**覆盖**已有字段，因为这是用户主动导入，不是 snapshot）。`name` 字段按用户答复优先级：`frontmatter.name → 上传文件名去 .md → 留空`。粘贴模式下若 frontmatter 无 name，保持空。
- **deprecated 字段归一**（与 opencode 的 normalize 逻辑对齐）：
  - `tools: { write|edit|patch: bool }` → `permission.edit = 'allow' | 'deny'`；其它 `tools[k]` → `permission[k]`。显式 `permission` 优先级更高（最后写入）。
  - `maxSteps`（仅当文件没写 `steps` 时）→ `steps`；同时把原 `maxSteps` 仍写入本框架的 `maxSteps` 字段（我们 schema 保留了独立列）。
- 其余 opencode frontmatter 字段（`mode / hidden / color / disable / top_p / options / prompt` 以及任何未识别 key）全部塞入 `frontmatterExtra`（合并而非覆盖：如果用户已有 `frontmatterExtra`，按 key 浅合并，导入值覆盖同名 key）。
- markdown body（frontmatter 之后的所有内容，含前后空行 trim 一次）→ `bodyMd`。
- 抽出**纯函数 parser**（`packages/shared/src/agent-md.ts` 导出 `parseAgentMarkdown(text, opts?)`），返回 `{ partial: Partial<CreateAgent>, warnings: string[], unrecognizedKeys: string[] }`。parser 不抛异常；YAML 不合法时 `partial = {}` + 一条 `warnings[0] = 'yaml-parse-failed: …'`。

**不做（本 RFC 之外）**

- 不修改 `/agents/$name`（编辑现有 agent）页面：导入入口仅在新建页可用，避免误覆盖正在编辑的 agent。
- 不做"批量导入"或"从目录扫描"：单次单个 agent，文件多了走多次。
- 不做导出（agent → md 文件）；后续如有需要单独 RFC。
- 不引入新的 YAML 解析依赖：复用现有 `parseFrontmatter`（基于 `yaml` 包）。
- 不改 `CreateAgentSchema` / DB schema / runner / scheduler。
- 不为节点级覆写（NodeInspector）做 import；只作用于 agent 资源本身。

## 3. 用户故事

- **U1（粘贴导入）**：用户复制其它仓 `code-reviewer.md` 的全部内容（含 frontmatter + body），打开 `/agents/new` → 点 "Import from agent.md" → 选 Paste tab → 粘贴 → "Parse" → 看到 `description / model / temperature / permission / body` 列在预览里，未识别字段 `mode / color` 标注 `→ frontmatterExtra` → "Apply" → 表单立刻填好，name 仍空待填 → 改 name 后保存。
- **U2（上传导入）**：用户从硬盘选 `~/Downloads/security-auditor.md` → 表单的 name 字段自动填为 `security-auditor`，其它字段同 U1 行为。
- **U3（deprecated tools → permission）**：导入文件 frontmatter 含 `tools: { write: false, bash: true }`，无显式 `permission`。预览展示 `tools → permission.edit=deny, permission.bash=allow`，apply 后表单 permission JSON 字段显示 `{ "edit": "deny", "bash": "allow" }`。
- **U4（maxSteps coalesce）**：导入文件含 `maxSteps: 50`，无 `steps`。预览展示 `maxSteps → steps=50（deprecated 别名）`；apply 后 form `steps=50, maxSteps=50`（maxSteps 也单独保留，因为我们 schema 有独立列）。
- **U5（YAML 不合法）**：用户粘贴的内容 frontmatter 里 YAML 缩进错了。"Parse" 后预览区显示警告 `YAML parse failed: …`，全部字段保持现状，"Apply" 按钮 disabled。
- **U6（无 frontmatter，只有正文）**：用户粘贴的内容根本没有 `---` 分隔。Parser 把整段当作 `bodyMd`，预览展示 `body (N chars) → bodyMd`，其它字段不动。可以 Apply。
- **U7（覆盖确认）**：用户已经在表单里填了一些字段，再点 Import。Parse 预览区顶部出现红字 `Apply will overwrite N fields you have edited: description, model, …`。用户可以选择继续或取消（关闭对话框）。
- **U8（多次导入合并 frontmatterExtra）**：用户先导入一个 agent（frontmatterExtra 含 `mode: subagent`），再次 Import 一个新文件（含 `mode: primary, hidden: true`）。Apply 后 `frontmatterExtra = { mode: 'primary', hidden: true }`（同名 key 被新导入覆盖，旧 key 若新导入没有则保留）。
- **U9（permission 校验）**：导入的 `permission` 不是对象（写成 `permission: "allow"` 这种错用），parser 把它丢进 `frontmatterExtra.permission`，并给出 warning `permission must be an object; kept in frontmatterExtra`。

## 4. 验收标准

详见 [design.md §6 测试策略](./design.md#6-测试策略) 与 [plan.md](./plan.md)。核心断言：

1. `parseAgentMarkdown` 是纯函数（无网络 / 文件 IO），对同一字符串输入返回稳定结构；test 覆盖至少 12 条 case（已知字段 / 未识别字段 / tools normalize / maxSteps coalesce / 显式 permission 优先 / YAML 失败 / 无 frontmatter / 数组型 frontmatter 兜底 / null / body trim / body 含多个 `---` 围栏 / unicode）。
2. `/agents/new` 顶部出现 Import 按钮；点开后对话框含 Upload / Paste tab + Parse + Apply + Cancel；i18n 中英双份。
3. 上传文件成功后 name 字段从文件名（去 `.md`）自动填入；frontmatter 显式 `name` 则覆盖文件名。
4. Apply 后 AgentForm 当前 value 被 parser 返回的 `partial` **覆盖性**合并：parser 返回 undefined 的字段保持原样，返回有值的字段直接替换；`frontmatterExtra` 字段按 key 浅合并。
5. 仅在 `/agents/new`（新建路由）显示 Import 按钮；`/agents/$name`（编辑路由）不显示。
6. YAML 解析失败时 Apply 按钮 disabled；UI 显示具体 warning 文案。
7. `bun run typecheck && bun run test && bun run format:check` 全绿。

## 5. 非破坏性

- `CreateAgentSchema` / `AgentSchema` / DB schema / 任何 backend 服务均不变；纯前端 + shared parser。
- 不引入新 npm 依赖。
- 编辑现有 agent 行为不变。
- 现有 agent 表单的所有字段（含 RFC-002 的 Runtime snapshot 行为）继续生效；Import 是叠加路径，不替换 snapshot。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| YAML 解析对超大文件慢 / 阻塞主线程 | 前端 parser 同步即可（agent.md 通常 <50 KB）；超大文件用户极少见，不做 worker 化 |
| `name` 字段从 frontmatter 来源 + 非法字符 | parser 不对 name 做 regex 校验，原样交给表单字段；表单已有 `AGENT_NAME_RE` pattern 校验和提交时的 zod 校验兜底 |
| 用户误以为 Import 会自动提交 | Apply 仅写入表单 state；保存仍需点 Save 按钮，与原流程一致；对话框 footer 文案明确写 "Fills the form below; you still need to save." |
| 覆盖已填字段令用户困惑 | U7：Parse 后在预览区顶部红字列出将被覆盖的字段名，Apply 不弹二次确认（保持 UX 轻量；红字已足够提示） |
| `permission` / `frontmatterExtra` 非对象类型 | parser 主动丢回 `frontmatterExtra.<key>` + 一条 warning；不阻塞 Apply |
| i18n race | 文案走现有 i18n 模式；测试用 class / role 选择器避免 label 文本断言 race |

## 7. 参考

- 现有 frontmatter parser：`packages/backend/src/util/frontmatter.ts`（基于 `yaml` 包，已用于 SKILL.md）
- opencode agent 规范：`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/agent.ts`（normalize 逻辑权威）
- AgentForm：`packages/frontend/src/components/AgentForm.tsx`
- 新建路由：`packages/frontend/src/routes/agents.new.tsx`
- CreateAgent schema：`packages/shared/src/schemas/agent.ts`
