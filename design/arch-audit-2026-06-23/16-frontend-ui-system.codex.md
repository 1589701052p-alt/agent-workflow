# Codex 核验：前端：UI 设计系统 / 可抽取公共组件 (16-frontend-ui-system)

> 对应报告：`design/arch-audit-2026-06-23/16-frontend-ui-system.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **UI-D1 / UI-X1 / UI-X2 基本属实，级别建议 P1→P2/P1 边界**：确实没有 `Tabs/Segmented/Table/DataTable` 组件文件；调用方直接写 class。例：`tasks.detail.tsx` 自写 `role="tablist"`/`role="tab"`/`aria-selected`（`packages/frontend/src/routes/tasks.detail.tsx:260`），而 `clarify.detail.tsx` 只把 `tabs__tab` 用在 `Link` 上，无 tab 语义（`packages/frontend/src/routes/clarify.detail.tsx:699`）。`.segmented` 也只是 CSS class，调用方自己决定 `role`，例如 `AclPanel` 用 `role="group"`（`packages/frontend/src/components/AclPanel.tsx:157`），`tasks.detail` 用 `radiogroup/radio`（`packages/frontend/src/routes/tasks.detail.tsx:477`）。
- **UI-D2 / UI-X3 属实，但漏了 account**：`TextInput` 只允许 `text|number|url`（`packages/frontend/src/components/Form.tsx:36`），没有 `password`、`autoComplete`、`autoFocus`、`name`、`minLength`。因此 `users`、`auth`、`settings OIDC` 都落了原生 input：`users.tsx:250`、`users.tsx:296`，`auth.tsx:163`、`auth.tsx:174`、`auth.tsx:226`，`settings.tsx:976`、`settings.tsx:1046`。对应私有 chrome 在 `styles.css:418`、`styles.css:969`、`styles.css:5241`。
- **UI-B1 属实**：手写 tab 的 ARIA 不一致。正例是 `tasks.detail.tsx:260-267`；反例是 `NodeDetailDrawer` 只有 `tabs__tab` class（`packages/frontend/src/components/NodeDetailDrawer.tsx:142`），`clarify.detail` 甚至是链接形态（`packages/frontend/src/routes/clarify.detail.tsx:695`）。
- **UI-B2 属实，P2 合理**：`ErrorBanner` 本身只是封装 `error-box`（`packages/frontend/src/components/ErrorBanner.tsx:6`），但大量调用方仍直接写 `error-box`，如 `reviews.tsx:105`、`settings.tsx:682`、`TaskDiagnosePanel.tsx:102`。报告的“39 处绕过”与实际数量级一致。
- **UI-B3 属实但应更谨慎**：确有大量内联 loading/empty，如 `TaskDiagnosePanel.tsx:100`、`TaskDiagnosePanel.tsx:145`；但部分是紧凑局部状态，不必一律迁成全页 `LoadingState/EmptyState`。
- **UI-B4 部分属实**：布尔开关应优先 `Switch`，例如 OIDC enabled 用原生 checkbox（`packages/frontend/src/routes/settings.tsx:1149`）。但列表多选不是伪问题，报告自己也承认 `FilesPicker` 合理（`packages/frontend/src/components/launch/FilesPicker.tsx:99`）。
- **UI-D4 属实但级别 P3 合理**：`Dialog` 只有自由 `footer` slot（`packages/frontend/src/components/Dialog.tsx:261`），没有标准 `DialogFooter`，导致按钮顺序/危险态靠约定。
- **UI-C1 / UI-X5 属实**：业务 CSS 与原语 CSS 同居，例：`.account-table`（`styles.css:745`）、`.oidc-form`（`styles.css:901`）、`.diagnose-table`（`styles.css:2246`）、`.data-table`（`styles.css:2450`）、`.tabs`（`styles.css:3259`）。

## REFUTED / 伪问题（给反证 file:line）

- **UI-D3 “现有 UI 测试只锁 class 存在性、找不到源码层反向守卫”是过期/夸大**。仓里已有源码层 grep 守卫：`tabs-retrofit-grep.test.ts` 明确锁调用方使用 `.tabs/.tabs__tab`（`packages/frontend/tests/tabs-retrofit-grep.test.ts:1`），`empty-loading-callsite.test.ts` 锁已 retrofit 路由必须渲染 `<LoadingState>/<EmptyState>`（`packages/frontend/tests/empty-loading-callsite.test.ts:1`），`form-helper-coverage.test.ts` 禁止目标路由重新长出裸 `<input>/<textarea>`（`packages/frontend/tests/form-helper-coverage.test.ts:10`）。更准确的问题是：守卫覆盖面是 RFC-035 目标清单，不是全仓全局红线。
- **UI-C2 “中文环境直接显示英文 default”不成立为普遍结论**。`auth`、`users`、`account`、`settings.auth` 的 key 多数已经在 zh/en bundle 中存在，例如 `auth.tabPassword` 等在中文 bundle（`packages/frontend/src/i18n/zh-CN.ts:2570`），`users.*` 在中文 bundle（`packages/frontend/src/i18n/zh-CN.ts:2695`），`settings.auth.*` 在中文 bundle（`packages/frontend/src/i18n/zh-CN.ts:2830`）。但 `defaultValue` 仍会削弱“缺 key 编译失败”的保护，这点成立。
- **“Select 已 100% 替换”需加限定**：源码里没有业务 `<select>`，但 `Select.tsx` 注释仍提到原生 select 的历史兼容；当前反证不是问题，只是报告表述应限定为“业务调用方未直接落 `<select>`”。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **account 是第 4 套 form-input chrome — P1 — `packages/frontend/src/routes/account.tsx:138`, `packages/frontend/src/styles.css:702` —** 报告说三套 form chrome，但账户页也自建 `.account-form`，密码修改和 PAT 创建都直接落 `<input>`（`account.tsx:144`, `account.tsx:156`, `account.tsx:412`），样式独立于 `Form.TextInput`。
- **登录页提交按钮绕过 `.btn` 系统 — P2 — `packages/frontend/src/routes/auth.tsx:183`, `packages/frontend/src/styles.css:5256` —** `auth-form` 内两个 submit button 没有 `btn btn--primary`，靠 `.auth-form button` 私有 CSS，和报告强调的“按钮/表单 chrome 唯一入口”同根。
- **StatusChip 仍有业务直写 — P2 — `packages/frontend/src/routes/account.tsx:561` —** account PAT 状态直接拼 `status-chip status-chip--danger/success`，绕过已有 `<StatusChip>`；这与报告“StatusChip 已达标”的结论不完全一致。
- **segmented 的语义不一致不止是组件缺失 — P2 — `packages/frontend/src/components/AclPanel.tsx:157`, `packages/frontend/src/routes/tasks.detail.tsx:477` —** 同一视觉原语一处是 `role="group"`，一处是 `radiogroup/radio`；抽组件时应先明确“分段按钮是 tab、radio、还是 toolbar toggle”，否则只是把漂移搬进 props。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

- `<TextInput>` 最小扩展是最优先、低风险：加 `password/autoComplete/autoFocus/name/minLength` 不触碰 RFC-097 状态机、RFC-099 prompt 隔离、opencode env 合并优先级，且能一次消掉 users/auth/settings/account 的大部分表单漂移。
- `<Tabs>` / `<Segmented>` 值得做，但不应合成一个巨型 `Tabs variant="segment"`。`Tabs` 是 tablist/tabpanel 语义；`Segmented` 很多地方更像 radio group 或 toggle group。把语义做清楚比复用 CSS 更重要。
- `<Table columns rows>` 不宜一次性过度抽象到排序、展开、截断、操作列全包。当前更稳的路径是先抽 `DataTableShell`/`TableEmptyRow`/`TableActionsCell` 这类薄组件，保留业务 row render，避免把 23 个表的差异塞进复杂 columns DSL。
- `<AsyncList>/<QueryView>` 需要谨慎。TanStack Query 状态封装有价值，但列表、弹窗内局部状态、表格空态、详情页加载态视觉不同；建议先做 `QueryBoundary` 只统一 error/loading/empty 的默认件，并允许局部 override。
- grep 守卫应做“新增禁止 + 现有白名单”，而不是立即全仓禁止 `<input>/<table>/error-box>`。否则会把合理的文件上传、隐藏 input、checkbox list、多选权限矩阵也误伤。
- 这些前端 UI 重构不会直接破坏 RFC-097/RFC-099/opencode env 不变量；真正风险是大规模迁移时误改 auth/account/settings 的权限与提交语义，所以应按小 PR 分层推进。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：报告抓住了 UI 收敛缺少组件入口与强制力的主问题，但对测试现状和 i18n 影响有过期/夸大之处，并漏掉了 account/auth/status-chip 这些同类漂移点。
