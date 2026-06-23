# 前端：路由页与业务功能组件（公共原语采用度） — 架构审计 (2026-06-23)

> 范围 key=17-frontend-routes-features。代码锚点：`packages/frontend/src/routes/*`（agents/tasks/workflows/memory/reviews/skills/mcps/plugins/repos/settings/fusions/clarify/account/users）、`components/{memory,review,tasks,launch,inventory,mcps,repos,skills,home,fusion,clarify,structure,agents,node-session,shell,prose}/*`、`components/{AgentForm,McpFields,PluginFields,ResourceList,AclPanel,UserPicker,SkillsPicker,McpsPicker,PluginsPicker,OutputsEditor}.tsx`、`router.tsx`、`routes/__root.tsx`。
> 与 16（盘点原语）互补：本报告评估**业务层是否落地采用**这些原语。
> 与既有审计的关系：`ux-audit.md`(2026-05-17) 早于 RFC-035，其「Dialog 各写一份 / table 两套 / status 4 套 / loading-empty 零组件化」**多数已被 RFC-035 落地修复**（Dialog/EmptyState/LoadingState/DetailLayout 已建，data-table 推广到 14 站，status 收敛成单 `StatusChip`）；本报告对那些项标注「已修复，ux-audit 此条已过时」，把精力放在**仍未落地的采用缺口 + 加新业务页/资源类型的真实成本**。`dedup-audit-2026-06-13 §4.7/§3.8` 已覆盖若干前端骨架重复项，本报告交叉印证并补「扩展性 / 漂移即 bug」论证。证据均为 file:line（相对仓库根）。

---

## 0. 健康度一句话

公共原语**库存非常齐全且质量高**（Form / Select / ChipsInput / Dialog / EmptyState / LoadingState / DetailLayout / StatusChip / data-table / 各类 Picker），但**采用率两极分化**：表单 / 弹窗 / 状态 chip 的采用已接近满分，而 **loading / error / empty 三态壳在 4 个资源详情页 + 全部首页/收件箱列表里仍被逐处手写绕过**（`<div className="page muted">` / `<div className="error-box">` ~40 站），且 **11 份本地 `describeError` 副本 + `ErrorBanner` 自身都不走 i18n 的 `describeApiError`** → 同一个后端错误码在不同页面一半显示翻译句子、一半显示裸 `code: message`（dedup §3.8 漂移仍在线）。结构健康、采用度中等偏上，主要欠账集中在「三态壳」和「资源 CRUD 脚手架」两类——加第 6 种资源类型时仍要 fork 3 个路由文件。

---

## 1. 当前架构与职责

路由层用**代码式 TanStack Router**（`router.tsx` 手工 `addChildren` 33 条路由），每个资源有 list / new / detail 三个文件。导航 `__root.tsx` 用声明式 `NAV_GROUPS`(`lib/nav`) 渲染侧栏。业务表单抽成共享 Fields 组件（`AgentForm` / `McpFields` / `PluginFields` / `MemoryFormFields`），detail/new 路由只负责 query+mutation 编排和 page 骨架。公共原语集中在 `components/` 根目录（RFC-035 建的 `Dialog`/`EmptyState`/`LoadingState`/`DetailLayout` + 既有 `Form`/`Select`/`ChipsInput`/`StatusChip`/`ErrorBanner`/`ConfirmButton`）。`describeApiError`(`i18n/index.ts:54`) 是错误本地化单一事实源。

关键文件：`router.tsx`、`routes/__root.tsx`、`AgentForm.tsx`(满分范例)、`McpFields.tsx`(radio 违规)、`{Skills,Mcps,Plugins}Picker.tsx`(三胞胎)、`{agents,mcps,plugins,skills}.detail.tsx`(脚手架四胞胎)、`{agents,mcps,plugins,skills}.new.tsx`(脚手架四胞胎)、`components/home/{Running,RecentlyDone,InboxPreview}List.tsx`(三态壳手写三胞胎)、`ErrorBanner.tsx`/`i18n/index.ts:54`(错误渲染双源)、`ResourceList.tsx`(孤儿)。

---

## 2. 设计问题（Design）

**[FE17-D1] 错误渲染存在两条事实源，且「canonical」的 `ErrorBanner` 自己都不走 i18n** — 级别 P1｜类型 design/impl-bug｜证据 `i18n/index.ts:54-72`（`describeApiError` 会 `i18n.exists('errors.<code>')` → 命中返回翻译，未命中返回 `errors.fallback: <message>`）vs `components/ErrorBanner.tsx:6-13`（`${error.code}: ${error.message}`，**不查 i18n**）+ 11 份逐字本地副本 `function describeError`（`routes/{settings:1355,skills.detail:173,repos:215,workflows.edit:543,tasks.detail:925,workflows.launch:502}` + `components/{Onboarding:158,SkillSourcesCard:143,NodeDetailDrawer:642,repos/BatchImportDialog:327,launch/FilesPicker:112}`，全都是 `${e.code}: ${e.message}`）｜影响：**用户层可见的不一致**——agents/mcps/plugins 详情页用 `describeApiError` 显示「保存失败：名称已存在」之类翻译句子，而 skills/repos/tasks/workflows/settings 页用本地 `describeError` 显示裸 `agent-name-conflict: ...`；列表页走 `ErrorBanner` 同样显示裸码。dedup-audit §3.8 已把它列为「漂移即 bug」，至今未收口。｜建议：① `ErrorBanner` 内部改调 `describeApiError`（一行）；② 删 11 份本地 `describeError`，全量换 `describeApiError`；③ 加源码层 grep 锁（`grep "function describeError" routes components` 必须为空）防回潮。

**[FE17-D2] 三态壳（loading/error/empty）有公共原语但 4 个资源详情页 + 全部首页/收件箱列表仍手写绕过** — 级别 P1｜类型 design/coupling｜证据：`LoadingState` 21 站采用、但 `routes/{agents.detail:64,mcps.detail:73,plugins.detail:82,skills.detail,tasks.detail,clarify.detail,workflows.edit,workflows.launch}.tsx` 均 `return <div className="page muted">{t('common.loading')}</div>`；`EmptyState` 23 站采用、但 13 个 routes 仍 inline `className="muted"` 空态（`routes/{agents,mcps,plugins,clarify,reviews,memory,fusions.detail,settings,...}.tsx`）；error 同理（~40 处 `error-box`，见 §6）。首页三列 `components/home/{RunningTaskList:49-69,RecentlyDoneList:47-66,InboxPreviewList:57}.tsx` 各自把「`isLoading→muted` / `error→error-box+retry 按钮` / `empty→muted` / `list`」四段 inline 抄一遍。｜影响：原语已经付出建设成本（RFC-035），但「最该统一」的详情页加载态 / 首页列表态没采用——spinner / 居中 / 高度撑起这些 `LoadingState` 提供的视觉，在详情页和首页全部退化成「左上角一行灰字」，与列表页观感割裂；dedup-audit §4.7 `inline-muted-loading-bypasses-loadingstate`(26 处) / `homepage-task-list-and-section-error`(5 站) 覆盖此项。｜建议：① 详情页 loading/error 守卫换 `LoadingState`/`ErrorBanner`；② 抽 `<SectionList query={...} renderItem empty error>` 收编首页/收件箱 5+ 列表的三态 ladder（见 §4 FE17-X2）。

**[FE17-D3] 资源 CRUD「页面脚手架」是四胞胎，无 `DetailHeaderActions` / `useResourceCrud` 抽象** — 级别 P2｜类型 design/extensibility｜证据：`routes/{agents,mcps,plugins}.detail.tsx` 三者结构逐行同构——`page__header--row` + `<h1>` + `page__hint` + `page__actions{AclDialogButton + Save btn + ConfirmButton}` + `form-actions` 错误条 + `useQuery(['x',name])` + `loaded` 标志 effect + `save/del` mutation + loading/error 守卫（`agents.detail.tsx:68-107` ⟷ `mcps.detail.tsx:77-117` ⟷ `plugins.detail.tsx:88-128`，差异仅 i18n key + base URL）；new 页同构（`agents.new.tsx:73-110` ⟷ `mcps.new.tsx:47-73`）。`skills.detail.tsx:30-72` 是**双 query/双 mutation**变体（meta + content），所以不能粗暴塞进一个 hook（dedup §4.7 已点名此坑）。｜影响：见 §4 FE17-X1（加资源类型成本）。｜建议：抽 `DetailHeaderActions.tsx`（`resourceBaseUrl + invalidateKey + onSave + saving + onDelete + deleting` props）统一 ACL+Save+Delete 行动簇；CRUD 编排可抽 `useResourceDetail`（单 query 版）+ 留 skills 的双 query 版手写。dedup §5 RFC-F 已规划。

**[FE17-D4] `ResourceList.tsx` 是 P-1-17 占位实现、全仓零 import（孤儿原语）** — 级别 P2｜类型 design/test-gap｜证据 `components/ResourceList.tsx:1`（注释自述「Real DataTable arrives in P-1-17」），`grep -rln "ResourceList\b" routes components | grep -v ResourceList.tsx` = 空。它内部还自带一个 `ErrorBox`(`:51-56`) 用 `${error.code}: ${error.message}` 绕过 `describeApiError`（同 FE17-D1 漂移）。｜影响：孤儿组件给后人「这是不是该用的列表原语？」的误导；其内嵌 ErrorBox 是又一处漂移源。dedup §4.7 `resource-list-page-scaffold` 已给「补成真 DataTable 全量采用 或 删掉」二选一。｜建议：删除（data-table CSS class 已是事实标准，14 站采用），或明确补成壳并采用——别留孤儿。

**[FE17-D5] `inventory-table` / `account-table` / `batch-import-table` 三套表格类未走 `.data-table`** — 级别 P3｜类型 design/coupling｜证据 `components/inventory/{Agents,Skills,Plugins,Mcps}Table.tsx:15/11/11/11`（`className="inventory-table inventory-table--xxx"` + 各自 `<colgroup>`）、`routes/account.tsx:538/615/679` + `routes/settings.tsx:743`（`account-table`）、`components/repos/BatchImportDialog.tsx:280/283`（`batch-import-table`）。｜影响：ux-audit §2.5 旧账的残余——repos/reviews/agent-import 已迁 data-table，但 inventory（4 表）/account/settings/batch-import 仍自造表格视觉；加新 inventory 列或新审计表会再抄一份。｜建议：能套 `.data-table` 的套（inventory/account），确需固定列宽的用 `.data-table` + `<colgroup>` 组合，不再起 `xxx-table` 命名空间。

---

## 3. 实现问题 / Bug（Impl）

**[FE17-I1] `McpFields` 用原生 `<input type="radio">` + 自写 `.chip-row`，违反 CLAUDE.md「前端 UI 统一」强制条款** — 级别 P2｜类型 impl-bug/coupling｜证据 `components/McpFields.tsx:43-63`（type local/remote 用 `role="radiogroup"` 包两个 `<label className="chip"><input type="radio">`）+ `:120-138`（oauthMode auto/disabled 同款）。CLAUDE.md 明示「2-N 个短选项的分段控件走 `.segmented`，禁止自写 radio 按钮组」。｜影响：MCP 表单的「类型」「OAuth 模式」选择器与 LanguageSwitch / NodeInspector 的 `.segmented` 视觉不一致；属已声明的产品级回归。dedup §4.7 `segmented-vs-chip-radio`(6 站) 覆盖、判定「必须改」，至今未改。｜建议：换 `.segmented` 或 `<Select>`（两选项更适合 `.segmented`）。

**[FE17-I2] `OutputsEditor` 逐字重写了 `ChipsInput` 的 Enter/逗号/Backspace token 语义 + 直落原生 `<input className="form-input">`** — 级别 P3｜类型 impl-bug/coupling｜证据 `components/OutputsEditor.tsx:32-55`（`commit`/`handleKey` 复刻 trim+dedup+Enter/`,`/Backspace）+ `:106-116`（原生 `<input className="form-input outputs-editor__add">`），注释 `:3` 自述「mirrors ChipsInput's Enter/Backspace semantics」。｜影响：ChipsInput 的 validator / dedup / a11y 行为若演进，OutputsEditor 不会同步；CLAUDE.md「禁止自写 chip 输入逻辑」。dedup §4.7 `chips-input-reimplemented-in-outputseditor` 覆盖。但 OutputsEditor 确有「每行带 KindSelect」的额外需求，纯复用 ChipsInput 不够——属「应最小扩展 ChipsInput 支持 per-chip 尾随插槽」而非完全 fork。｜建议：给 `ChipsInput` 加 `renderChipSuffix(name)` 可选插槽，OutputsEditor 复用其输入/commit 内核、只注入 KindSelect。

**[FE17-I3] `workflows.launch` 的 `DynamicInput` text-multiline 分支直落原生 `<textarea className="form-input">` 而非 `<TextArea>`** — 级别 P3｜类型 impl-bug｜证据 `routes/workflows.launch.tsx:431-444`（`def.kind==='text'` 且 multiline → 原生 `<textarea className="form-input" rows={6}>`），同文件其余分支都走 `<TextInput>`/Picker。｜影响：单点风格不一致（`<TextArea>` 已有 `monospace`/`disabled`/`data-testid`），且 multiline textarea 是该文件唯一漏网。｜建议：换 `<TextArea rows={6}>`。

**[FE17-I4]（对抗式自检 · 已推翻）疑似「status 仍有 4 套并行系统」（ux-audit §2.2）** — 级别 N/A｜类型 待核验（已排除）｜证据 我尝试坐实 ux-audit 旧账：读 `components/inventory/StatusBadge.tsx:9-46` + `components/McpProbeStatusChip.tsx:16-50` —— 二者**已在 RFC-035 改为内部渲染统一 `<StatusChip>`**（`StatusBadge` 做 bucket→kind 映射、`McpProbeStatusChip` 做 ui-status→kind 映射），组件名/API 保留只为语义清晰，是「语义 wrapper 包统一原语」的**正确**模式，不是 4 套并行实现。结论：**ux-audit §2.2 此条已过时**，记录以免后人误判为回归。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[FE17-X1]「加第 6 种受 ACL 管控的资源类型」要 fork 3 个路由文件 + 改 5+ 注册点，且踩路由顺序手雷** — 级别 P1｜类型 extensibility｜
- **未来场景**：半年后加一类新资源（如「prompt 模板库」「评测集」「沙箱镜像」），它和 agent/mcp/plugin/skill 同构：list / new / detail + ACL + 可被 agent 引用。
- **根因**：资源 CRUD 没有「资源类型描述符」抽象。每种资源的「身份」散落在：① `routes/xxx.{tsx,new.tsx,detail.tsx}` 三个手写脚手架（FE17-D3 四胞胎）；② `router.tsx:40-82` 三条 `addChildren` + **手写注释维护的顺序不变量**（`agents.new.tsx:43` 注释「`/agents/new` 必须排在 `/agents/$name` 前」，每种资源重复一遍——纯人肉守的隐式契约，排错=`/new` 被当成 `$name`）；③ `lib/nav` 的 `NAV_GROUPS`；④ i18n 两份 bundle 的 `xxx.*` key 簇；⑤ 一个 `XxxFields` 组件；⑥ 若可被引用还要一个 `XxxsPicker`（见 FE17-X3）；⑦ 一个 inventory 表（FE17-D5）；⑧ `AclDialogButton` 接线。
- **现在加功能要碰**：≥ 8 个文件/位置，其中 3 个是 ~100 行脚手架复制。
- **目标形态**：定义 `ResourceKindDescriptor<TForm>{ basePath, queryKey, listColumns, FieldsComponent, formToCreate, rowToForm, aclBaseUrl(id), navGroup, i18nPrefix }`；用一个 `makeResourceRoutes(descriptor)` 工厂生成 list/new/detail 三条路由 + 自动保证 `/new` 在 `/$id` 前（消除注释手雷）；`DetailHeaderActions` + `useResourceDetail`（FE17-D3）做编排。skills 的双 query 用 descriptor 的可选 `contentQuery` 字段支持。加资源 = 写一个 descriptor + 一个 Fields 组件。

**[FE17-X2]「加新首页区块 / 新收件箱品类」每次都重抄三态 ladder + 轮询装配，无 `SectionList` 容器** — 级别 P1｜类型 extensibility/test-gap｜
- **未来场景**：RFC 后续给收件箱加品类（已从 reviews+clarify 长到 +memory+fusions，见 `shell/InboxDrawer.tsx:44-66` 已并 4 个 useQuery），或首页加「失败任务」「待审记忆」新区块。
- **根因**：`home/{RunningTaskList:49-69,RecentlyDoneList:47-66,InboxPreviewList:57}.tsx` 把「`isLoading→<div className="muted homepage-section__loading">` / `error→<div className="error-box" role="alert"> + 重试 <button className="btn btn--xs" style={{marginLeft:8}}>` / `empty→<div className="muted">` / 列表」四态逐处手写；`InboxDrawer` 把多个 useQuery+轮询自己装配。没有 `<SectionList>` / `<QueryList>` 容器封装「query→三态→renderItem」。dedup §4.7 `inbox-by-task-list`(11 站)/`homepage-task-list-and-section-error`(5 站) 覆盖。
- **现在加功能要碰**：新建一个 `XxxList.tsx` 把 ladder 抄第 N 遍 + 在 InboxDrawer/Homepage 装配；三态视觉/重试交互无单一收口处，改一次 retry 文案要扫 N 个文件。
- **目标形态**：`<SectionList query={useQuery结果} renderItem={...} empty={<EmptyState>} errorLabel limit onCount>`，内部统一 `LoadingState`/`ErrorBanner`(带 retry)/`EmptyState`；新区块/新品类 = 传一个 query + renderItem。

**[FE17-X3]「新增任何『从既有资源里挑多个』的字段」要 fork 一份 ~75 行 Picker（Skills/Mcps/Plugins 已是逐字三胞胎）** — 级别 P2｜类型 extensibility｜
- **未来场景**：agent 上加「依赖的评测集」「关联的 prompt 模板」等新引用字段，或新资源（FE17-X1）也想被引用。
- **根因**：`{Skills,Mcps,Plugins}Picker.tsx` 是「`useQuery(列表)` + 过滤已选 + `<Select>` 一次性添加 + `<ChipsInput>` 展示 + 失败回退」的同一模板，三份**逐行同构**（`SkillsPicker.tsx:22-75` ⟷ `McpsPicker.tsx:22-75` ⟷ `PluginsPicker.tsx:22-79`，差异仅 query key、label 拼接、plugins 多一个 `enabled` 过滤）。`UserPicker` 是第 4 个近亲。dedup §4.7 `list-multiselect-picker`(4 站) 覆盖。
- **现在加功能要碰**：复制一份 75 行 Picker，改 query key / label。
- **目标形态**：`<ResourcePicker queryKey endpoint labelOf={(row)=>...} filter?={(row)=>...} value onChange testidPrefix>` 单参数化组件；4 个现有 picker 收敛成 4 行调用。

**[FE17-X4]「加新 launcher 输入端口类型」要改 `DynamicInput` if-链 + 新建 Picker，无输入类型注册表** — 级别 P2｜类型 extensibility｜
- **未来场景**：给工作流输入加新 kind（如 `secret` / `date` / `repo-ref-multi`）。
- **根因**：`routes/workflows.launch.tsx:425-467` 的 `DynamicInput` 是 `if(kind==='text')...if('files')...if('enum')...if('git')...else` 硬编码链，每种 kind 对应一个 `components/launch/XxxPicker.tsx`，但没有 `Record<InputKind, Picker>` 注册表把它们绑一起；upload 分支还在外层（`:382`）特判。后端 input kind 增删时前端无编译期护栏（与 14-canvas 审计 CANVAS-D1「无节点类型注册表」同根问题）。
- **现在加功能要碰**：`DynamicInput` if-链 + 新 Picker + 可能的外层特判。
- **目标形态**：`INPUT_KIND_RENDERERS: Record<InputKind, FC<PickerProps>>`（`satisfies` 穷举），`DynamicInput` 查表渲染；与后端 `WorkflowInput` 的 kind 联合用同一处穷举对齐。

**[FE17-X5] 路由树纯手工装配 + 顺序不变量靠注释维护，规模增长时静默 mis-route 风险升高** — 级别 P3｜类型 extensibility｜证据 `router.tsx:40-82` 33 条 `addChildren`，6 处「literal 必须在 `$param` 前」注释（agents/mcps/plugins/reviews/clarify/memory）。｜影响：每加一个带详情的资源就要手记一条顺序规则；TanStack 支持 file-based routing（`router.tsx:1` 注释自承「file-based 在 M2 前 overkill」，但现已 33 路由），顺序由文件名自动决定可消除手雷。｜建议：评估迁 file-based routing，或在 `makeResourceRoutes`(FE17-X1) 工厂里固定顺序。

---

## 5. 耦合 / 分层违规

**[FE17-C1] 错误本地化逻辑在 routes/components 层被复制 11 份，绕过 `i18n/` 单一事实源** — 级别 P1｜类型 coupling｜证据 见 FE17-D1（11 份 `describeError` + `ErrorBanner` + `ResourceList.ErrorBox`）。｜影响：i18n 层是「错误码→本地化文案」的唯一职责所在，但 12+ 个 UI 文件各自决定「怎么把 error 变字符串」，分层穿透。｜建议：同 FE17-D1，全量收敛 + grep 锁。

**[FE17-C2] 首页/收件箱列表组件内联三态视觉 + 轮询，UI 编排与数据获取强耦合在每个 List 组件里** — 级别 P2｜类型 coupling｜证据 见 FE17-X2。｜影响：无法对「三态渲染」单测（要起整个 useQuery），与 CLAUDE.md「首选可断言面」原则冲突。｜建议：抽 `<SectionList>` 把三态与 query 解耦。

**[FE17-C3] 12 文件残留 inline `margin*` style（间距 token 缺失的下游症状）** — 级别 P3｜类型 coupling｜证据 `grep "marginBottom:|marginTop:" routes components` = 12 文件（如 `McpsPicker.tsx:49` `style={{marginBottom:6}}`、`home/RunningTaskList.tsx:60` `style={{marginLeft:8}}`、`routes/skills.tsx` 5 处）。｜影响：ux-audit §2.9/§3 旧账——无 `--space-*` token，作者只能 inline 像素。比 ux-audit 时已收窄但仍在。｜建议：引入 `--space-*` token + `.stack`/`.row-gap` utility，逐处迁移。

---

## 6. 测试 / 可观测性缺口

**[FE17-T1] 无源码层「采用度回归锁」——已修好的原语会被新代码悄悄绕过** — 级别 P2｜类型 test-gap｜证据 358 个前端测试文件，但 `grep "function describeError|page muted|chip-row|<input className=\"form-input\"" tests` 类源码层文本断言**缺失**（仅个别组件单测）。CLAUDE.md「最低限度也要保留一条源代码层文本断言」明确要求这类锁（范例「`selectionOnDrag` 不得出现在 `WorkflowCanvas.tsx`」）。｜影响：FE17-D1/I1/I2 这类「已知该用公共件却绕过」的回归，没有任何护栏阻止新 PR 再抄一份；ux-audit 修好的项也会缓慢回潮。｜建议：加一个 `tests/primitive-adoption.test.ts`：断言 `routes/` 下 `function describeError` 计数为 0、`McpFields.tsx` 不含 `type="radio"`、详情页守卫不含 `page muted`、`ResourceList` 有 importer（或被删）等——把本报告每条「采用缺口」钉成红线。

**[FE17-T2] ~40 处 `error-box` 各自决定有无 `⚠` 前缀 / 有无 retry / role，错误态可观测性碎片化** — 级别 P3｜类型 observability/test-gap｜证据 `grep -rln "error-box" routes components` = 40 文件；`ErrorBanner` 带 `⚠`，`RunningTaskList.tsx:54` 带 `role="alert"`+retry，多数详情页 `<div className="page error-box">` 既无 `⚠` 也无 retry。｜影响：屏幕阅读器对错误的播报、用户能否重试，因落点而异。｜建议：收敛到 `ErrorBanner`（统一 `role="alert"` + 可选 `onRetry`），detail 页守卫也用它。

---

## 7. 目标形态（Target architecture）

1. **错误渲染单源**：`ErrorBanner`(列表/守卫) + `form-actions__error`(表单提交) 两个落点，内部都调 `describeApiError`；删除 11 份 `describeError` + `ResourceList.ErrorBox`；源码层 grep 锁防回潮。这是**投入最小、用户可见收益最大**的一步。
2. **三态壳全采用 + `<SectionList>` 容器**：详情页守卫换 `LoadingState`/`ErrorBanner`；首页/收件箱列表收编进 `<SectionList query renderItem empty errorLabel limit>`。RFC-035 已建原语，缺的是「采用 + 列表态容器」。
3. **资源类型描述符 + 路由工厂**：`ResourceKindDescriptor` + `makeResourceRoutes` + `DetailHeaderActions` + `useResourceDetail`，把 agent/mcp/plugin/skill 四胞胎收敛成「descriptor + Fields 组件」，加第 6 种资源接近零脚手架，并消除路由顺序手雷。skills 双 query 走 descriptor 可选 `contentQuery`。
4. **引用 Picker 参数化**：`<ResourcePicker>` 单组件取代 Skills/Mcps/Plugins/User 四个近亲；`ChipsInput` 加 `renderChipSuffix` 让 `OutputsEditor` 复用内核。
5. **输入/节点类型注册表**：`INPUT_KIND_RENDERERS`（前端 launcher）与 14-canvas 审计建议的 `nodeKindRegistry` 同源思路——把「kind→渲染器/表单/默认值」从散落 if-链收进 `satisfies Record<Kind,...>` 表，前后端共享穷举护栏。
6. **表格统一 `.data-table`**：inventory/account/batch-import 三套类收编。
7. **采用度回归锁**（FE17-T1）作为以上每步的交付门槛。

---

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| 1 | FE17-D1 / C1 | 错误渲染双源 + 11 份 describeError 副本 | P1 | design/coupling | 同一错误码一半显翻译一半显裸码，用户可见漂移（dedup §3.8 仍在线）；改 ErrorBanner 一行 + 删 11 份 + grep 锁 |
| 2 | FE17-D2 | 三态壳在 4 详情页 + 全首页列表被手写绕过 | P1 | design/coupling | 原语已建却没在最该用的地方用，加载态全退化成左上角灰字 |
| 3 | FE17-X2 / C2 | 首页/收件箱列表三态 ladder 重抄，无 SectionList | P1 | extensibility | 加新区块/收件箱品类每次抄四态 + 装配轮询 |
| 4 | FE17-X1 / D3 | 资源 CRUD 四胞胎，加第 6 种资源 fork 3 路由 + 改 8 处 + 顺序手雷 | P1 | extensibility | 无资源类型描述符/路由工厂 |
| 5 | FE17-I1 | McpFields 原生 radio 违反前端统一强制条款 | P2 | impl-bug | dedup §4.7 判「必须改」至今未改 |
| 6 | FE17-X3 | Skills/Mcps/Plugins Picker 逐字三胞胎 | P2 | extensibility | 加引用字段 fork 75 行；应参数化为 ResourcePicker |
| 7 | FE17-T1 | 无采用度回归锁，修好的原语会被悄悄绕过 | P2 | test-gap | ux-audit 修好的项缺护栏会回潮 |
| 8 | FE17-D4 | ResourceList 孤儿原语（零 import + 内嵌漂移 ErrorBox） | P2 | design | 删或补成壳，二选一 |
| 9 | FE17-X4 | launcher 输入类型 if-链，无注册表 | P2 | extensibility | 与 canvas 节点注册表同根 |
| 10 | FE17-D5 / I2 / I3 / C3 / X5 / T2 | inventory-table 自造 / OutputsEditor 复刻 ChipsInput / launch textarea 原生 / inline margin / 路由手工装配 / error-box 碎片 | P3 | mixed | 整洁/收尾类 |

---

> 交叉印证小结：ux-audit(2026-05-17) 的 Dialog/EmptyState/LoadingState/DetailLayout/data-table/status-chip 缺口**多已被 RFC-035 落地修复**（本报告 FE17-I4 推翻 status 旧账、§2 标注 Dialog/table 已修）；仍未落地的是「原语已建但业务层不采用」——集中在三态壳（FE17-D2）、错误渲染漂移（FE17-D1，dedup §3.8 同源）、资源/列表/Picker 脚手架重复（FE17-X1/X2/X3，dedup §4.7 同源）。本报告新增的架构洞察是：把这些零散重复**归因到三个缺失的抽象层**——错误单源、`<SectionList>` 列表态容器、`ResourceKindDescriptor` 资源工厂——以及与 14-canvas 审计共享的「类型注册表」缺口（FE17-X4 ⟷ CANVAS-D1）。
