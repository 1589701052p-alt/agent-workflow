# RFC-038 — Agent 表单：从 body 文本中一键识别 agent / skill / mcp / plugin 依赖

| 字段     | 值                                                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编号     | RFC-038                                                                                                                                                                                                                                                                                            |
| 状态     | Draft                                                                                                                                                                                                                                                                                              |
| 作者     | binquanwang                                                                                                                                                                                                                                                                                        |
| 提交日期 | 2026-05-19                                                                                                                                                                                                                                                                                         |
| 关联     | [RFC-018 agent.md import](../RFC-018-agent-md-import/proposal.md), [RFC-022 agent dependencies](../RFC-022-agent-dependencies/proposal.md), [RFC-028 agent mcp deps](../RFC-028-agent-mcp-dependencies/proposal.md), [RFC-031 agent plugin deps](../RFC-031-agent-plugin-dependencies/proposal.md) |

## 1. 背景

Agent 编辑页（`/agents/new` 与 `/agents/$name`）的 `AgentForm.tsx` 上半部已经把四类资源依赖整理成可选 chip：

- `dependsOn` — 其它 agent 名（RFC-022）
- `skills` — Skill 名（RFC-002）
- `mcp` — MCP 名（RFC-028）
- `plugins` — Plugin 名（RFC-031）

用户写 agent body markdown（系统提示词）时常用法是直接在正文里点名：「请调用 `git-status` agent 的输出」「先用 `code-review-mcp` 跑一遍 lint」「依赖 skill `playwright-runner`」。现状下，用户必须手动把这些名字又分别复制到上面四个 picker 才能让运行时真正注入 —— 一个 agent 拖到画布上跑起来时，runner 走的是 `dependsOn` 闭包 + `skills` / `mcp` / `plugins` 数组，纯靠 body 文本 mention 不会注入任何资源。

这种"两遍录入"非常容易漏：M1 后的几个示例 agent（含 RFC-029 同步出来的 inventory 默认 agent）都出现过"body 里写了 `xxx-mcp`，但 mcp 列表空着"导致 task 跑起来找不到工具的 case。

需要一个**轻量自检功能**：在 agent 表单点一个按钮，对 `bodyMd` 做一次 plain-text `includes` 扫描，比对当前 inventory（agents / skills / mcps / plugins）有哪些 name 在 body 出现但**还没**被加进对应数组；弹窗列出来让用户勾选 → 一键合并进各自数组。整个过程纯前端、不改 body 本身、不改 DB、不改 backend。

## 2. 目标

1. **新按钮 "自动识别依赖"** 放在 `AgentForm.tsx` 的 `fieldDependencyTree` 闭包预览 Field **上方**（位于已有 `dependsOn` picker 与 `DependencyTreePreview` 之间），类型 `btn--ghost btn--sm`，i18n key `agentForm.autodetect.button`。
2. **检测算法纯函数**：`detectAgentDeps(bodyMd, inventory, existing, selfName)` —— 输入 body 字符串 + 四类 inventory（`Agent[]` / `Skill[]` / `Mcp[]` / `Plugin[]`，复用 `AGENTS_QUERY_KEY` / `SKILLS_QUERY_KEY` / `MCPS_QUERY_KEY` / `PLUGINS_QUERY_KEY` 已缓存数据）+ 当前 `value`（form CreateAgent）+ `selfName`，返回 `{ agents: string[]; skills: string[]; mcps: string[]; plugins: string[] }`，每组按 inventory 自身顺序、去重、排除自身、排除已存在项。
3. **匹配规则**：对每个候选 name 做 `bodyMd.includes(name)`，**纯 contains，区分大小写**，不做词边界 / 正则转义 / 大小写归一。这是 v1 的产品决策（用户原话："直接 contains 判断"）；命中假阳性靠用户在弹窗里取消勾选纠正。
4. **弹窗交互**：点击按钮打开 `<Dialog>`（复用 RFC-035 PR3 抽出的共享组件，与 AgentImportDialog 同形），标题 "识别到的潜在依赖"。Dialog 内部按四组分区列出 checkbox：每组 header 显示组名 + 命中数；空组隐藏（不展示空 section）。每个 checkbox 默认 **勾选**；行内文本 = `{name} — {description}`（description 缺失时仅 name）。所有四组都空 → Dialog 显示 EmptyState `<EmptyState>`「未识别到新依赖」+ 仅一个"关闭"按钮。
5. **应用动作**：底部按钮 `取消` / `导入选中`（`btn--primary`）。点 `导入选中` → 把每组被勾选的 name **合并**进 `value.dependsOn / skills / mcp / plugins`（去重、保留原数组顺序，新增项追加到尾部），调用 `onChange(next)` 一次（合并后整体 patch），关 Dialog；点 `取消` 或 ESC / 遮罩点击 → 不改任何 form state，关 Dialog。
6. **禁用态**：`value.bodyMd` 经 `trim()` 为空 → 按钮 disabled + `title` 提示「请先填写 agent 正文」。inventory 四个 query 全都未加载完时按钮 spinner 或临时禁用（沿用 `AgentDependsPicker` 的失败 fallback 逻辑：query 失败的那类不参与检测，按钮可点，其它类正常检测）。
7. **不改 body markdown**：扫描是纯只读；导入选中不在 body 上做任何 highlight / 替换 / 链接化。
8. **不改 backend / shared / DB / schema_version**：所有逻辑都在 frontend；inventory 沿用现有四个 GET 接口。
9. **不动闭包预览**：导入完成后，AgentForm 通过 `onChange` 触发自身重渲染，`DependencyTreePreview` 现有 200ms debounce 自然会刷新闭包；本 RFC 不直接 invalidate 任何 query。
10. **i18n 中英对称新增 9 个 key**（详见 design.md §4.4）。

## 3. 非目标

- **不**做正则 / 词边界 / 大小写不敏感 / fuzzy 匹配 / NLP 命名实体抽取 / 同义词识别。v1 一律纯 contains。
- **不**做"反向去除"——已经在数组里、但 body 里没出现的项，**不**给用户提示去除。这是只增不减的工具。
- **不**联动 `frontmatterExtra` / `permission` JSON / agent description / outputs 描述里的文本扫描，仅扫 `bodyMd`。
- **不**新增任何 backend 路由 / WS / DB 列 / migration / schema_version bump。
- **不**做 server-side 检测（例如保存 agent 时自动补依赖）。v1 完全手动触发、手动确认。
- **不**对**未被 inventory 包含的名字**做"建议创建"或"link to 创建页"——v1 只识别已存在资源。
- **不**做多语言 description 匹配。
- **不**做按钮的 / agent 表单的快捷键（Cmd+K 等）。
- **不**保存"上次勾选状态"——每次开 Dialog 都重新检测、默认全选。

## 4. 用户故事

### US-1 — 一键识别四类依赖

> Alice 写了一个 `pr-review` agent，body 里提到「先调用 `git-diff-snapshot` agent 取 diff，再用 `code-review-mcp` 的 `lint_files` 工具」「skill `playwright-runner` 用于回归」。她点 AgentForm 上的「自动识别依赖」，弹窗列出三组（Agents: `git-diff-snapshot` ✓ / MCPs: `code-review-mcp` ✓ / Skills: `playwright-runner` ✓；Plugins 组空所以不出现）。她全部保留勾选，点「导入选中」→ 上方 `dependsOn` / `skills` / `mcp` chip 各多一项，闭包预览自动重算多出对应分支，无需手动操作 picker。

### US-2 — 取消假阳性

> Bob 的 body 里有「使用 `git` 命令」，他点识别，Agents 组里命中 `git-diff-snapshot`（因为 body 里有 `git-diff-snapshot` 关键字）。他不需要这个 agent，取消勾选；同时 Skills 组命中 `git-status`（同理 body 含子串），他也取消。Plugins 组的 `digit-validator` 被命中（因为 body 里有"5 digits"，子串 `digit` 命中 `digit-validator`），他取消勾选。**这正是 contains 的预期假阳性场景**，由用户裁决。点「导入选中」→ 只导入剩下勾选项。

### US-3 — body 为空

> Carol 创建新 agent，body 还没写就点了按钮 —— 按钮 disabled，鼠标悬停 tooltip「请先填写 agent 正文」。她写完 body 再点，正常工作。

### US-4 — 全部已存在

> Dave 修改 agent，body 里的所有 `xxx-mcp` / agent 名都已经在对应 picker 里加好了。他点识别 → 弹窗 EmptyState「未识别到新依赖」+ 仅有「关闭」按钮。

### US-5 — inventory 加载失败

> Eve 因网络问题导致 `/api/plugins` 失败，但 `/api/agents`、`/api/skills`、`/api/mcps` OK。她点识别 → Dialog 只展示三组检测结果，底部加一条 muted 文案「Plugins 列表加载失败，已跳过」。她可以正常导入其它三类的勾选项。

## 5. 验收

- **AC-1**：AgentForm 在 `fieldDependencyTree` Field **之上、`fieldDependsOn` Field 之下** 新增一行包含「自动识别依赖」按钮（i18n key `agentForm.autodetect.button`）。
- **AC-2**：`value.bodyMd.trim() === ''` 时按钮 disabled + title 提示 i18n key `agentForm.autodetect.disabledHint`。
- **AC-3**：点击按钮打开 Dialog（沿用 RFC-035 PR3 共享 `<Dialog>` 组件），标题 i18n key `agentForm.autodetect.dialogTitle`。
- **AC-4**：Dialog 内对每一类资源做 `bodyMd.includes(name)` 扫描；命中且不在当前 `value.{dependsOn,skills,mcp,plugins}` 中且非 `selfName` → 进入候选列表；命中数 = 0 的组**不**展示该组 section。
- **AC-5**：候选行渲染 `{name} — {description}`（description 缺失时仅 `name`），checkbox 默认勾选；行内文本可点击切换勾选状态（label 关联 checkbox）。
- **AC-6**：底部两按钮：`取消`（关 Dialog，不改 form state）、`导入选中`（合并勾选项进对应数组，去重保留原顺序，新增项追加到尾部，调用 `onChange` 一次）。
- **AC-7**：四组候选全空 → Dialog 渲染 `<EmptyState>` + 只有「关闭」按钮（无「导入选中」）。
- **AC-8**：四个 inventory query 中有任何一个 `error` → Dialog 底部 muted 一行提示「{group} 列表加载失败，已跳过」；其它组照常显示。
- **AC-9**：ESC 键 / 遮罩点击 / 关闭按钮 → 等同 `取消`。
- **AC-10**：纯函数 `detectAgentDeps` 对自身、对已存在项、对空 body、对 inventory 顺序的处理与单测断言一致（详见 design.md §6）。
- **AC-11**：纯函数 `mergeAgentDeps`（合并选中项进 CreateAgent）对四个数组、去重、空选中、与未变更字段保持 immutability 的断言一致（详见 design.md §6）。
- **AC-12**：i18n 中英对称新增 9 keys（详见 design.md §4.4）；`Resources` 接口同步扩展。`i18n-keys-symmetry.test.ts` 自动卡死。
- **AC-13**：本地 `bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions HEAD CI 六 jobs 全绿。
- **AC-14**：新增测试 ≥ 18 条（详见 design.md §6 分布）；既有测试零退化。
- **AC-15**：multi-person working tree 安全 —— 不删 / 不改他人 untracked 文件，commit 仅按路径精确 `git add` 自己的改动。

## 6. 风险

1. **contains 大量假阳性**：典型如子串吃整词（`digit` 命中 `digit-validator`、`git` 命中 `git-status`）。已用产品决策（v1 纯 contains）规避到 UI 层 —— 用户必须显式勾选 / 取消。在 dialog 顶部加一条 muted 说明文案「按子串匹配，请人工确认每一项」减小误用风险（i18n key `agentForm.autodetect.dialogHint`）。
2. **inventory 滚动很大时 contains 扫描慢**：四类总条目预估 < 1000，N×len(body) 单次开销在 ms 级，前端无须 worker。仍然在 detect 函数加 fast-path：`bodyMd === '' → return all-empty` 避免无谓循环。
3. **inventory 加载竞态**：用户在 query 还在 pending 时点按钮 → 按钮在四个 query 全部 `isPending=false` 之前 disabled / 显示 spinner（沿用 RFC-035 `<LoadingState>`）。
4. **selfName 边界**：新建 agent 时 `value.name === ''`，需要避免 `''.includes('')` 之类的退化（实际 `agents.filter(a => a.name !== '')` 自然过滤掉空 name，不会有问题）。已在 design.md §3 测试用例锁住。
5. **重名风险**：agent 名 / skill 名 / mcp 名 / plugin 名理论上各自唯一（DB 约束），但跨类型可能同名（如 agent 叫 `playwright` skill 也叫 `playwright`）。本 RFC 按"哪个 inventory 命中加到哪个数组"逻辑，**两类都会同时命中**，用户在 dialog 里分别勾选；这是预期行为，非 bug。
6. **`includes('')` 退化**：`name === ''` 永远命中。inventory 里不可能有空名（DB 约束 + AGENT_NAME_RE），但稳健起见 detect 函数显式过滤 `name.length > 0`。
7. **导入完触发的闭包预览刷新**：`DependencyTreePreview` 200ms debounce 已足够吸收多次合并，无须额外节流。
8. **AgentForm 已经很挤**：再加一个按钮可能挤压视觉。design.md §4.1 设计为"小尺寸幽灵按钮"（`btn--sm btn--ghost`），右对齐 Field 内 + 与「Dependency tree」label 同一行。
9. **没接 plugin / mcp 的 import 流**：仅识别已存在 inventory；body 里写了 inventory 不存在的名字，**默默不识别**（v1 决策）。未来若用户呼声大可再扩，本 RFC 不预留 hook。

## 7. 备选方案

- **方案 A（已选）**：纯前端 contains + 弹窗手工确认。零 backend / DB 改动；可控、可解释、易测。
- **方案 B（被否）**：服务端 endpoint `POST /api/agents/analyze-deps` 返回检测结果。优点：将来可加 LLM 辅助 / 复杂分词。缺点：v1 不需要服务端能力；多绕一跳；测试更重。**当 v2 需要正则 / 词边界 / NLP 时再演进**。
- **方案 C（被否）**：保存 agent 时 server 端**自动**补依赖。缺点：把用户决策权拿走；假阳性进 DB；不可解释。明确否决。
- **方案 D（被否）**：实时在 body markdown 编辑器里高亮 + inline 提示。优点：交互更直接。缺点：需要改 `MarkdownEditor` / monaco 设置 / decorations，开发量大；体验不一定优于显式按钮。本 RFC 仅 v1 简化，不闭门。
- **方案 E（被否）**：复用 RFC-018 AgentImportDialog 的"识别 frontmatter 字段路由表" UI。本 RFC 是后续编辑场景（body 已写完一半），不是首次导入；交互目标不同，强行复用反而绕。新弹窗组件更直观。
