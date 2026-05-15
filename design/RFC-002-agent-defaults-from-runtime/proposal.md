# RFC-002 Proposal — Add Agent 表单从 Runtime 默认值快照

> 状态：Draft（2026-05-15）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

`/agents/new` 的新建代理表单（`packages/frontend/src/components/AgentForm.tsx`）允许用户填写每个 agent 自己的 `model / variant / temperature / steps / maxSteps` 覆写。当前实现存在两个不一致：

1. **Model 字段是裸文本 TextInput**。
   - 用户必须手敲完整 `provider/modelID` 字符串（例如 `anthropic/claude-sonnet-4-6`）。
   - 而 `/settings` → Runtime 标签页的 `defaultModel` 字段在 RFC-001 已经升级为 `ModelSelect`（按 provider 分组的 `<select>` + `Custom…` + 刷新按钮）。两个入口体验割裂。

2. **`model / variant / temperature / steps / maxSteps` 全部默认为空，不参考 Runtime 默认值**。
   - 用户在 Settings 已经填好「整个团队都用 sonnet-4-6 + temperature 0.2」时，每次新建 agent 还要再手填一次；忘填就意味着这个 agent 在运行时走 opencode 内置默认（可能不是用户想要的那一档）。
   - Settings Runtime 现在只有 `defaultModel / defaultVariant / defaultTemperature` 三项；`steps / maxSteps` 在 Settings 里根本没有「团队默认值」概念，每个 agent 单独想。

需求语句：

> 在新增代理界面，Model 也应该和设置 → 运行时的 Model 一致，并默认选择运行时中已经保存的 Model。同理应该默认提示设置中已经填写的 variant、Temperature、Steps、Max steps，如果不配置则为默认；以后修改了运行时中默认值后，代理的配置不跟随改变。

最后一句是关键：**snapshot 语义**——新建 agent 时把 Runtime 当前默认值拷进表单，保存后这些值落在 agent 自身行上，之后 Settings 改了不再影响已建 agent。

## 2. 目标

**做**

- AgentForm 的 Model 字段从 TextInput 改为复用 Settings 已有的 `ModelSelect` 组件（同样的 provider 分组、`Custom…`、刷新按钮）。
- AgentForm mount 时**一次性**从 `/api/config` 读 Runtime 默认值（`defaultModel / defaultVariant / defaultTemperature / defaultSteps / defaultMaxSteps`），把这五项作为 agent 草稿的初始值；后续 Settings 修改不再回流到正在编辑的草稿。
- 在 `ConfigSchema` 里新增 `defaultSteps / defaultMaxSteps` 两个 optional 正整数字段，并在 Settings → Runtime 标签页加入对应 NumberInput，让这两项有「设置里填写的默认值」这个来源。
- 用户在 AgentForm 里清空某个字段保存 → 持久化的 agent 行上该字段就是 `undefined`，运行时回退到 opencode 内置默认（行为不变）。
- AgentForm 的 **Skills 字段**在现有 chip 输入框上方新加一个"从已有技能中选择"下拉框，选中即把对应技能名追加到 chip 列表（自动去重）。下拉项来自 `/api/skills` 实时列表；自由输入 chip 的行为保留，便于用户写未来还要新建的 skill 占位名。该下拉对**新建**与**编辑**两个路由同时生效（纯 UX 改进，与 snapshot 无关）。

**不做（本 RFC 之外）**

- 不改 `/agents/$name`（编辑现有 agent）页面的预填逻辑：依然严格只显示已保存值，避免在打开/保存旧 agent 时被 Settings 当前值「污染」。
- 不改 `NodeInspector` 的节点级 model override（保持文本输入；后续可单独 issue 复用 ModelSelect）。
- 不修改 backend agent.service / runner / scheduler 的任何运行时行为。`agent.steps / agent.maxSteps` 已经在 schema 中、且会注入 `OPENCODE_CONFIG_CONTENT`；本 RFC 仅改前端表单的初始值来源。
- 不引入"实时跟随 Settings 变化"的反应式连线。

## 3. 用户故事

- **U1（统一选型）**：管理员已在 Settings → Runtime 把 `defaultModel = anthropic/claude-sonnet-4-6`、`defaultTemperature = 0.2` 写好。打开 `/agents/new`，看到 Model 下拉已经停在 sonnet-4-6，Temperature 已经填 0.2。无需任何重复输入，直接填 name + body 保存。
- **U2（覆盖默认）**：在 U1 基础上，用户想让某个特定 agent 跑 `opus`。点开 Model 下拉换成 opus，Temperature 改成 0.7，保存。
- **U3（清空回归 opencode 默认）**：用户故意把 Temperature 清空，期望 agent 行 `temperature = null/undefined` 持久化，运行时不再传 `temperature` 参数给 opencode。
- **U4（snapshot 不跟随）**：U1 建好 agent 之后，又在 Settings 把 `defaultTemperature` 改成 0.5。回到 `/agents/$nameOfU1Agent` 查看，Temperature 仍然显示 0.2（即 U1 当时 snapshot 的值），不会自动变成 0.5。
- **U5（Settings 加 Steps / Max steps）**：用户在 Settings → Runtime 新看到 `Default steps` / `Default max steps` 两个输入框，分别填 10 / 50，保存。下次新建 agent 表单这两项自动预填 10 / 50。
- **U6（首次使用 / 未填 Settings）**：用户根本没在 Settings 填任何运行时默认值。新建 agent 时所有五个字段保持空，与今天行为一致。
- **U7（挑现成 skill）**：用户已经创建过若干 skill。新建 / 编辑 agent 时在 Skills 区上方下拉一开就看到全部已有 skill 名（带可选 description tooltip / sourceKind 标记）。点选后自动加进 chips。重复添加被忽略。
- **U8（占位 skill 名）**：用户打算稍后再建一个名叫 `code-review-helper` 的 skill，但现在就想把它写进 agent.skills 里。下拉里还没有，仍可在 chip 输入框直接打字 + Enter 加入。

## 4. 验收标准

详见 [design.md §7 测试策略](./design.md#7-测试策略) 与 [plan.md](./plan.md)。核心断言：

1. `/agents/new` 加载且 `/api/config` 返回 `defaultModel=X / defaultVariant=Y / defaultTemperature=Z / defaultSteps=S / defaultMaxSteps=M` 时，表单这五项立即显示对应值。
2. 加载时 Model 字段渲染为 `<ModelSelect>`（按 provider 分组 + `Custom…` + 刷新按钮），与 Settings → Runtime 的 `defaultModel` 控件视觉与交互一致。
3. 用户在 AgentForm 中改某个字段 → 同一会话内即使 Settings 通过 WS / 另一 tab 改了同名字段，AgentForm 不回滚（snapshot 一次性）。
4. 用户在 AgentForm 中**清空**字段 → POST `/api/agents` 提交的 payload 该字段为 `undefined`，后端持久化为 NULL。后续 GET 不会被任何 Settings 默认值"补全"。
5. `/agents/$existingName`（编辑现有 agent）页面字段为空时**不会**被 Settings 默认值覆盖。
6. `Config` schema 含 `defaultSteps / defaultMaxSteps` 两个 optional 正整数；`/settings` Runtime 标签页可见对应 NumberInput；旧 `~/.agent-workflow/config.json` 缺字段时按 `undefined` 处理，无 schema 错误。
7. AgentForm 的 Skills 区上方渲染下拉框，选项来自 `/api/skills` 列表；选择某项后该 skill 名追加到 chip 列表；已在 chip 列表中的 skill 重复选不会再加；自由 chip 输入保留可用。
8. `/api/skills` 加载失败 / 列表为空时下拉降级（loading 文案 / 空选项 placeholder），chip 输入仍可用。
9. `bun run typecheck` / `bun test` 全绿。

## 5. 非破坏性

- `Config` schema 新增字段是 optional，旧 config.json 兼容（缺字段 = `undefined`）。
- `AgentSchema` 不变，DB schema 不变。
- 编辑现有 agent 行为不变。
- `NodeInspector` / 任务运行时不变。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `/api/config` 解析失败 / 网络异常 → snapshot 拿不到 | useEffect 内 try/catch + 仅在 query.data 解析成功时一次性应用；失败时表单保持当前空白行为 |
| 用户在 config 加载完之前已经开始打字 → 后到达的 snapshot 覆盖了用户输入 | 用 `useRef` 守卫：只在「config 首次成功 + 表单当前字段仍是 default 初值」时填入；任何字段用户已动过就跳过 |
| Settings 改了，Add Agent 已经打开一会儿 → 用户期望 vs 实际不一致 | snapshot 显式一次性；UI 上不需要提示，行为与所有「表单初值」一致 |
| `defaultSteps / defaultMaxSteps` 类型校验失败 | zod `z.number().int().positive().optional()`；UI 上 NumberInput min=1，与 AgentForm 完全对齐 |

## 7. 参考

- 既有 ModelSelect 组件：`packages/frontend/src/components/ModelSelect.tsx`（RFC-001 落地）
- AgentForm 当前实现：`packages/frontend/src/components/AgentForm.tsx`
- Settings Runtime 标签：`packages/frontend/src/routes/settings.tsx:98-172`
- Config schema：`packages/shared/src/schemas/config.ts`
- Agent schema（含 model / variant / temperature / steps / maxSteps）：`packages/shared/src/schemas/agent.ts`
