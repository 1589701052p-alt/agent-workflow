# Codex 核验：前端：路由页与业务组件 (17-frontend-routes-features)

> 对应报告：`design/arch-audit-2026-06-23/17-frontend-routes-features.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **错误渲染双源属实 — P1**：`describeApiError` 会查 i18n 并 fallback 到本地化前缀，见 `packages/frontend/src/i18n/index.ts:54-62`；但 `ErrorBanner` 直接拼 `${code}: ${message}`，见 `packages/frontend/src/components/ErrorBanner.tsx:6-11`。本地 `function describeError` 也确为 11 处，见 `routes/workflows.launch.tsx:502`、`routes/workflows.edit.tsx:543`、`routes/settings.tsx:1355`、`routes/tasks.detail.tsx:925`、`routes/repos.tsx:215`、`routes/skills.detail.tsx:173`、`components/NodeDetailDrawer.tsx:642`、`components/SkillSourcesCard.tsx:217`、`components/Onboarding.tsx:158`、`components/launch/FilesPicker.tsx:112`、`components/repos/BatchImportDialog.tsx:327`。报告里 `SkillSourcesCard:143` 行号不准，但问题成立。

- **详情页三态壳绕过公共原语属实 — P2，非 P1**：CLAUDE 明确禁止手写 `<div className="error-box">` / loading 状态，见 `CLAUDE.md:84-85`；详情页仍大量 `page muted` / `page error-box`，例如 `routes/agents.detail.tsx:64-66`、`routes/mcps.detail.tsx:73-75`、`routes/plugins.detail.tsx:82-84`、`routes/skills.detail.tsx:80-85`、`routes/tasks.detail.tsx:159-161`、`routes/workflows.edit.tsx:347-350`。这是统一性和可访问性问题，但多数是视觉/体验一致性，不宜全打 P1。

- **资源 CRUD 脚手架重复属实 — P2**：agent/mcp/plugin detail 的 query、loaded、save/delete、header action 结构高度同构，见 `routes/agents.detail.tsx:32-66`、`routes/mcps.detail.tsx:34-75`、`routes/plugins.detail.tsx:44-84`；header actions 也重复，见 `agents.detail.tsx:75-94`、`mcps.detail.tsx:84-104`、`plugins.detail.tsx:95-115`。skills 是双 query 变体，见 `routes/skills.detail.tsx:30-85`，报告对此判断正确。

- **`ResourceList` 孤儿组件属实 — P2**：只有自身定义，没有 importer，见 `packages/frontend/src/components/ResourceList.tsx:22`；内部 `ErrorBox` 也绕过 `describeApiError`，见 `ResourceList.tsx:51-55`。

- **三套表格类未收敛属实 — P3**：inventory 表用 `inventory-table`，见 `components/inventory/AgentsTable.tsx:15`、`SkillsTable.tsx:11`、`PluginsTable.tsx:11`、`McpsTable.tsx:11`；account/settings 用 `account-table`，见 `routes/account.tsx:538`、`account.tsx:615`、`account.tsx:679`、`routes/settings.tsx:743`；batch import 用 `batch-import-table`，实际 `<table>` 在 `components/repos/BatchImportDialog.tsx:260`，报告引用的 280/283 是内部 cell/action 行。

- **`McpFields` radio / chip-row 违规属实 — P2**：CLAUDE 要求短互斥选择走 `.segmented`，见 `CLAUDE.md:79-80`；源码仍是原生 radio，见 `components/McpFields.tsx:42-63`、`McpFields.tsx:119-138`。

- **`OutputsEditor` 复刻 ChipsInput 语义属实 — P3**：文件注释自述 mirror，见 `components/OutputsEditor.tsx:1-4`；commit/key 逻辑在 `OutputsEditor.tsx:32-55`，原生 input 在 `OutputsEditor.tsx:106-116`；`ChipsInput` 的对应内核在 `components/ChipsInput.tsx:34-60`。

- **`workflows.launch` multiline 原生 textarea 属实 — P3**：`DynamicInput` 的 multiline 分支直接渲染 `<textarea className="form-input">`，见 `routes/workflows.launch.tsx:431-443`，违反 `CLAUDE.md:72-74` 的 Form primitives 约束。

- **Picker 重复属实，但报告低估了范围 — P2**：不只是 Skills/Mcps/Plugins，`AgentDependsPicker` 也是同一模板，见 `components/SkillsPicker.tsx:22-75`、`McpsPicker.tsx:22-75`、`PluginsPicker.tsx:22-79`、`AgentDependsPicker.tsx:25-77`。

## REFUTED / 伪问题（给反证 file:line）

- **“无源码层采用度回归锁”表述过度**：仓内已有源码层 guard，只是覆盖不全。Empty/Loading guard 见 `packages/frontend/tests/empty-loading-callsite.test.ts:13-46`；data-table guard 见 `packages/frontend/tests/data-table-callsite.test.ts:17-35`；`describeApiError` 代表性锁见 `packages/frontend/tests/i18n-batch-extraction.test.ts:141-144`。应改为“缺少针对本报告缺口的 guard”。

- **“首页三列 empty 全部手写”不准确**：`InboxPreviewList` 已用 compact `EmptyState`，见 `components/home/InboxPreviewList.tsx:78-85`；Running/RecentlyDone 仍手写，见 `components/home/RunningTaskList.tsx:67-69`、`components/home/RecentlyDoneList.tsx:65-67`。

- **status 四套并行是伪问题，报告自检推翻正确**：统一原语存在，见 `components/StatusChip.tsx:1-9`；`StatusBadge` 和 `McpProbeStatusChip` 都包 `StatusChip`，见 `components/inventory/StatusBadge.tsx:31-42`、`components/McpProbeStatusChip.tsx:35-49`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **InboxDrawer 的 memory 品类错误/加载态被吞 — P2 — `components/shell/InboxDrawer.tsx:44-49`, `InboxDrawer.tsx:222-239` —** memory query 已接入，但错误行只覆盖 reviews/clarify/fusion，空态判断也没等 `memoryQuery.isLoading`；管理员打开 memory tab 时可能在加载或失败时看到“空”。

- **首页 InboxPreview 单源失败会显示空态 — P2 — `components/home/InboxPreviewList.tsx:55-85` —** 只有 `bothErrored` 才显示错误；如果 reviews 失败、clarify 成功但为空，用户看到空态，实际 pending review 可能完全不可见。

- **ACL Dialog 加载/失败时空白 — P2 — `components/AclPanel.tsx:62-69`, `AclPanel.tsx:80-85`, `AclPanel.tsx:121-124` —** 打开权限弹窗后，ACL query loading 或 error 直接 `return null`，既无 LoadingState 也无 ErrorBanner，用户只能看到空弹窗。

- **InboxDrawer 自写 dialog chrome / portal / focus 行为 — P2 — `components/shell/InboxDrawer.tsx:194-199`, `InboxDrawer.tsx:323`, 对照 `CLAUDE.md:69-71` —** 它声明 `role="dialog"` 但不走公共 `Dialog`，也没有 Dialog 的 focus trap/portal 内部判定；这是比普通 error-box 更高风险的 a11y/一致性偏差。

- **Workflow import 冲突使用 `window.prompt` — P2 — `routes/workflows.tsx:49-52`, 对照 `CLAUDE.md:69-71` —** 这是原生 modal，无法复用 Dialog 的 a11y、样式和测试锚点；报告讨论路由页业务组件时漏掉了这个明显的公共原语绕过点。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

- **错误单源、`ErrorBanner -> describeApiError`、删除本地 `describeError` 是最优先且不过度设计**。这一步小、收益直接，也不会触碰 RFC-097 状态机 CAS、RFC-099 prompt 隔离或 opencode env 合并优先级。

- **`SectionList` 建议合理，但应先修真实吞错语义**：先解决 `InboxPreviewList` 单源失败空态、`InboxDrawer` memory 错误缺失，再抽三态容器；否则只是把 bug 包进新抽象。

- **`ResourceKindDescriptor + makeResourceRoutes` 偏重，建议分阶段**：先抽 `DetailHeaderActions`、`useSingleResourceDetail`、`ResourcePicker` 这类低风险重复；等新增第 6 类资源真的出现，再引入 descriptor。过早把 routes、nav、i18n、ACL、Fields、inventory 都塞进 descriptor，容易形成“万能配置对象”，也可能掩盖 skills 双 query、workflow canvas editor 这类非同构资源。

- **不要把 workflows 强行塞进普通 CRUD 工厂**：workflow editor 有 autosave、validate、canvas、export/import、版本等特殊不变量，见 `routes/workflows.edit.tsx:347-430`；资源工厂最多覆盖 list/new/detail 的简单资源，不应破坏 RFC-097/RFC-099 相关行为边界。

- **Picker 参数化建议比路由工厂更值得先做**：四个 picker 的重复边界清楚，见 `SkillsPicker.tsx:22-75` 等，抽 `ResourcePicker` 风险低；但 `UserPicker` 是搜索型、portaled list、单选/排除 owner 语义不同，不能粗暴并入同一个静态资源 picker。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：核心方向和多数证据成立，但严重级有些偏高，测试锁部分表述过度，并漏掉了收件箱 memory 品类吞错、ACL 空弹窗、原生 prompt/自写 dialog 这些更具体的用户可见问题。
