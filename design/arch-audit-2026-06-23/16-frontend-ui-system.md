# 前端 UI 设计系统 / 公共组件 / 风格统一 — 架构审计 (2026-06-23)

> 子系统 key：`16-frontend-ui-system`
> 范围：`packages/frontend/src/{components,styles.css,routes,i18n}` 全量（132 个组件、1575 个顶级 CSS class、10768 行 styles.css）。
> 既有审计交叉印证：`design/ux-audit.md`（2026-05-17，RFC-035 落地前的盘点）、`design/dedup-audit-2026-06-13.md` §3.8 / §4.6 / §4.7 / §21。
> **重要时间线背景**：`ux-audit.md` 的 9 处缺口绝大多数已被 **RFC-035（commit `ebe114d`/`3a98930`/`236fe49`，2026-05-18）** 修掉——本报告**不重复** ux-audit 的旧发现，而是验证「修完之后又漂回来了什么」+ 从扩展性角度回答用户的直接问题：**还有哪些原生元素 / 自写 chrome 应该收敛成公共组件**。

---

## 0. 健康度一句话

公共原语库本身**质量很高**（`Dialog` / `StatusChip` / `Form` / `Select` / `EmptyState` / `DetailLayout` 都是经过真实 a11y/focus-trap 打磨的好件，RFC-035 把 ux-audit 的 4 套状态系统、2 个静默退化按钮、对话框 chrome 都收敛掉了）——但**收敛机制是「CSS class + 人工自觉」而非「React 组件 + grep 守卫」，所以新功能照样各写一份**：RFC-035 落地当天与之后（account/users/settings-auth/RFC-033/RFC-057）就引入了 3 套独立 form-input chrome、5+ 套 table CSS、十余个手写 tab/segmented，a11y 属性各写各的。**问题不在「缺组件」，在「缺把组件做成唯一入口的强制力」**。

---

## 1. 当前架构与职责

前端 UI 一致性靠三层：(1) `components/` 下 132 个组件里约 20 个「公共原语」（`Dialog` / `Form.{Field,TextInput,NumberInput,TextArea,Switch}` / `Select` / `ChipsInput` / `StatusChip`（+ 适配器 `TaskStatusChip`/`StatusBadge`/`McpProbeStatusChip`）/ `EmptyState` / `LoadingState` / `ErrorBanner` / `ConfirmButton` / `DetailLayout`）；(2) `styles.css` 里的 class 体系（`.btn--*` / `.page__*` 骨架 / `.tabs` + 3 modifier / `.data-table` / `.segmented` / `.form-*` / 设计 token `--space/--font/--radius/--shadow/--success/--warn/--info`）；(3) `i18n/{zh-CN,en-US}.ts` 编译期类型校验文案。

关键文件：
- `packages/frontend/src/components/Dialog.tsx`（唯一 modal 原语，focus-trap + nested-stack，质量标杆）
- `packages/frontend/src/components/Form.tsx`（5 个表单原语；**`TextInput.type` 只支持 `text|number|url`，无 `password`**）
- `packages/frontend/src/components/StatusChip.tsx`（统一状态胶囊，RFC-035 收敛产物）
- `packages/frontend/src/components/Select.tsx`（原生 `<select>` 已 100% 替换）
- `packages/frontend/src/styles.css`（10768 行；`.tabs--*` @ 3292、`.data-table` @ 2450、`.segmented` 无 React 件、`.oidc-form` @ ~960、`.users-create-form input` @ 414、`.auth-form input` @ 5241）

---

## 2. 设计问题（Design）

**[UI-D1] 收敛靠「CSS class 复用」而非「组件唯一入口」，无法防止新漂移** — 级别 P1｜类型 design/extensibility｜证据：`.tabs__tab` 在 13 个文件各自手写（`grep -rln "tabs__tab" --include=*.tsx` → AgentImportDialog / MemoryAllList / NodeDetailDrawer / RepoSourceRow / NodeInspector / skills.new / tasks.detail / reviews / settings / auth / clarify.detail / clarify / memory）；`.segmented` 同理 8 个文件手写 `segmented__option--active` 翻转（`components/AclPanel.tsx:157-162`、`routes/tasks.detail.tsx:477-487`）；**没有 `<Tabs>` / `<Segmented>` / `<Table>` React 组件**（`ls components/{Tabs,Segmented,Table,DataTable}.tsx` 全部 No such file）。｜影响：tab/段控/表格的 active 逻辑、键盘导航、ARIA 每处重写，必然漂移（见 UI-B1）。｜建议：把 `.tabs` / `.segmented` / `.data-table` 各升级为受控 React 组件（`<Tabs items role=tablist>` / `<Segmented options>` / `<Table columns rows>`），class 仅作内部实现；老 class 标 deprecated。

**[UI-D2] 三套并行的 form-input chrome，根因是 `TextInput` 缺 `password` 类型** — 级别 P1｜类型 design/extensibility｜证据：`styles.css:414 .users-create-form input`、`styles.css:5241 .auth-form input`、`styles.css:~960 .oidc-form__field/__label/__hint`（30 行）三套各自给 `<input>` 上 padding/border/font；**全仓无全局 `input {}` base 样式**（`grep -nE "^\s*input\s*[,{]" styles.css` 仅命中作用域选择器）。`routes/users.tsx:250` 的 `<input>` **完全没有 className**，只靠 `.users-create-form input` 作用域选择器才不至于裸样式。`Form.tsx:38` `type?: 'text'|'number'|'url'`——**没有 `password`**，于是凡需要密码/凭据输入的页面（auth / users / settings-OIDC）只能落原生 `<input type=password>` + 自写 chrome。｜影响：登录页、用户管理、OIDC 设置三处视觉各异；CLAUDE.md「禁止直接落 `<input className=form-input>` 或自写 border/focus ring」被这三处违反。｜建议：给 `TextInput` 加 `password` + `autoComplete` + `autoFocus` + `pattern`（已有）+ `minLength`/`name` props（RFC-045 式最小扩展），三套 chrome 删除，统一走 `<Field>`+`<TextInput>`。

**[UI-D3] 无「源码层 UI 一致性 grep 守卫」，旧门禁只锁 CSS class 存在性** — 级别 P1｜类型 test-gap/design｜证据：现有 UI 测试 `frontend/tests/btn-variants-styles.test.ts`、`tabs-modifier-styles.test.ts` 只断言 styles.css **定义了** `.btn--ghost`/`.tabs--inline`，**不断言调用方采用**；`grep -rln "readFileSync.*styles\|not.toContain" tests` 找不到任何「禁止新增 `<input className=form-input>` / 禁止新 `error-box` / 禁止裸 `<table>`」的反向守卫。｜影响：RFC-035 当天就被 account/users/settings 绕过（见 §4 时间线），没有红线拦住。｜建议：补一组源码层文本断言（CLAUDE.md「最低限度也要保留一条源代码层文本断言」精神）：`expect(routeSrc).not.toMatch(/<input(?![^>]*className="form-input)/)`、禁止新 `className="error-box"`（白名单 ErrorBanner.tsx）、禁止新 `*-table` class。

**[UI-D4] 缺少 `<DialogFooter>` / 标准 Save-Cancel action row 约定** — 级别 P2｜类型 design｜证据：`Dialog` 提供 `footer` slot 但不规范其内容；各 dialog 自己拼 footer 按钮（`grep -rn "dialog__footer" --include=*.tsx` 散落）。｜影响：modal 底部按钮顺序/对齐/危险态各写各的。｜建议：导出 `<DialogFooter onCancel onConfirm confirmLabel confirmDanger>` 把 Save/Cancel/Confirm 收敛（与 `ConfirmButton` 协同）。

---

## 3. 实现问题 / Bug（Impl）

**[UI-B1] 手写 tab 的 ARIA 不一致——一半有 `role="tab"` 一半没有** — 级别 P2｜类型 impl-bug/test-gap｜证据：同样用 `.tabs__tab` class，`routes/tasks.detail.tsx:260-267`（`role="tablist"`+`role="tab"`+`aria-selected`）、`routes/auth.tsx`、`routes/clarify.tsx`、`routes/memory.tsx`、`routes/reviews.tsx` 带 `role="tab"`；而 `components/NodeDetailDrawer.tsx`、`components/canvas/NodeInspector.tsx`、`routes/settings.tsx`、`routes/skills.new.tsx`、`routes/clarify.detail.tsx`（`grep -c 'role="tab"'` = **0**）**完全没有 ARIA**——`clarify.detail.tsx:700` 只复用了视觉 class，无 tablist 容器、无 `aria-selected`。｜影响：屏幕阅读器在不同 tab 上行为不一致；键盘箭头导航全部缺失（无 `useTablistKeyNav`，dedup §58 已记同名缺口）。｜建议：抽 `<Tabs>`（见 UI-D1）一次性把 `role=tablist/tab` + `aria-selected` + 左右箭头键导航做对。

**[UI-B2] 39 处 `<div className="error-box">` 绕过 `ErrorBanner`** — 级别 P2｜类型 impl-bug/coupling｜证据：`ErrorBanner.tsx:11` 自己 `return <div className="error-box">⚠ {msg}</div>`；但 `grep -rln error-box --include=*.tsx | grep -v ErrorBanner.tsx` = **39 个文件**（`ResourceList`/`RuntimeStatusCard`/`Onboarding`/`NodeDetailDrawer`/`SkillFileTree`/`FuseDialog`/home/* 等）各自落裸 `error-box`，`⚠` 前缀有的有有的没有。｜影响：与 dedup §3.8（「~40 处 inline error-box 绕过 ErrorBanner」+ `describeError` 复制 10 份导致同一错误码不同页显示翻译句 vs 裸 `code:message`）**同一根因**——**已被 `dedup-audit §3.8/§4.6` 覆盖**，本报告确认仍未修（39 站）。｜建议：随 dedup RFC-E 一并收敛到 `ErrorBanner` + `describeApiError`。

**[UI-B3] 59 处 inline `isLoading &&`/`isPending &&` 仍绕过 `LoadingState`/`EmptyState`** — 级别 P2｜类型 impl-bug｜证据：`EmptyState`/`LoadingState` 已有 23/20 个采用方（RFC-035 PR3 推广见效），但 `grep -rn "isLoading &&\|isPending &&\|common.loading\|common.empty" --include=*.tsx | grep -v {Empty,Loading}State.tsx` 仍 **59 处**手写 `<div className="muted">{t('common.loading')}</div>`；`grep -rn 'className="muted"'` 在 `ModelSelect/WorktreeFilesPanel/McpsPicker/PluginsPicker/ResourceList/AclPanel/SkillSourcesCard/RuntimeStatusCard` 等仍在用单色 muted 当加载/空态。｜影响：加载/空态视觉表现仍随上下文摆动（部分是表格上一行小字、部分是 panel 居中）。｜建议：把 picker 类组件（`*Picker.tsx` / `ResourceList`）的内联态批量改 `<LoadingState>`/`<EmptyState>`，并补 UI-D3 守卫禁止新内联。

**[UI-B4] 11 处原生 `<input type=checkbox>` 绕过 `Form.Switch`** — 级别 P2｜类型 impl-bug｜证据：`grep -rn 'type="checkbox"' --include=*.tsx | grep -v Form.tsx` = 11 站（`components/clarify/QuestionForm.tsx:400`、`components/launch/FilesPicker.tsx:99`、`routes/settings.tsx:1150`、`routes/account.tsx:486`、`WorktreeDiffPanel`/`NodeDetailDrawer`/`FuseDialog`/`MemoryRow`/`StructuralGraph`/`StructuralDiffView`）。注意：multi-select 列表的勾选框（FilesPicker）是合理原生用法，但**布尔开关**（settings 的 Enabled、QuestionForm 的 required）应走 `<Switch>`。｜影响：开关视觉两套（iOS 滑块 vs 原生方框）。｜建议：布尔开关统一 `<Switch>`；列表多选另抽 `<Checkbox>` 原语（当前完全没有）。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

> **贯穿主线（git 证据）**：RFC-035 在 `2026-05-18` 落地收敛，**同一天**就有 `account-table`（`24998d9`）、`oidc-form`（`56ee03b`）、`users-create-form`（`d225542`）三处「修 unstyled input / 修 native chevron」时**自写新 chrome 而非采用刚做好的 Form/Select**；随后 `batch-import-table`（RFC-033 `26d8105`）、`diagnose-table`（RFC-057 `d5f5d08` 2026-05-23）继续各造表格。这不是个别疏忽，是**收敛机制（CSS class）本身不具强制力**的系统性后果。

**[UI-X1] 加任何「带表格的新页面」→ 被迫第 N 次重造 table 视觉** — 触发场景：半年后加「审计任务历史表」「Cron 任务列表」「成员权限表」。根因：`.data-table` 只是 CSS，**没有 `<Table columns rows>` 组件**；全仓 23 个文件落裸 `<table>`，CSS 已分裂成 `data-table`/`diagnose-table`/`repos-table`(残)/`account-table`/`batch-import-table`/`inventory-table` **6 套**。现在加表要碰：写 `<table><thead><tbody>` 结构 + 选 borrow 哪套 class + 行 hover/空态/操作列/截断各抄一遍 + 排序/展开自己实现。目标形态：`<Table>` 组件吃 `columns: {key,header,render,width,nowrap,truncate}[]` + `rows` + `expandable` + `emptyState`，内部用 `.data-table` class；新表零 CSS、零 ARIA 自写。

**[UI-X2] 加任何「分页/分段切换 UI」→ tab 与 a11y 各写一份且漂移** — 触发场景：给 agent 详情加「关联工作流」页签、给新设置页加分组 tab。根因：无 `<Tabs>`/`<Segmented>` 组件（UI-D1），13 处 `.tabs__tab` + 8 处 `.segmented` 手写，ARIA 已经一半缺失（UI-B1）。现在加 tab 要碰：active state hook + class 翻转字符串 + 决定加不加 `role=tab`（多半忘）+ 无箭头键导航。目标形态：`<Tabs items={[{id,label,panel}]} variant="line|inline|inspector|segment">` 统一受控 + ARIA + 键盘导航；`<Segmented>` 同源。

**[UI-X3] 加任何「凭据/登录/密码类表单」→ 第 4 套 form-input chrome** — 触发场景：加「修改密码」「API token 管理」「SMTP 设置」。根因：`TextInput` 无 `password` 类型（UI-D2），已逼出 `.oidc-form`/`.users-create-form`/`.auth-form` 三套。现在加凭据表单要碰：原生 `<input type=password>` + 自写 `.xxx-form input` 作用域 CSS（因为无全局 input base）+ 自写 label/hint。目标形态：`TextInput` 支持全部 input 语义 props，`<Field>` 是唯一表单字段入口，新表单 0 行 CSS。

**[UI-X4] 加任何「列表页」→ loading/empty/error 三态各拼一遍** — 触发场景：任何新资源列表（这是平台最高频的新功能形态）。根因：`EmptyState`/`LoadingState`/`ErrorBanner` 虽存在，但**没有把「query → 三态渲染」封装成一个东西**，59 处 inline loading + 39 处 inline error-box 证明大家仍手拼。现在加列表要碰：`isLoading ? ... : error ? ... : data.length===0 ? ... : <list>` 四分支自己写，每处对 muted/error-box 的选择不同。目标形态：抽 `<QueryView query={...} empty={...} children={(data)=>...}>` 或 `<AsyncList>` 把 TanStack Query 的 `{isLoading,error,data}` → 三态渲染收敛成单组件（这是平台 CRUD 页的主骨架，值得专门做）。

**[UI-X5] CSS 单文件 10768 行 / 1575 个 class，新功能改样式要在巨文件里找位置** — 触发场景：任何视觉调整。根因：`styles.css` 单文件承载全部样式，业务 class（`.oidc-form` / `.diagnose-table` / `.batch-import-*`）与原语 class（`.btn` / `.tabs`）混居，且 RFC-035 为兼容保留的 deprecated alias（`.status-badge`/`.mcp-probe-chip`/`.repos-table`——**已是 dead CSS**，`grep` 证实 tsx 不再引用）从未清理。现在改样式要：在 10768 行里定位 + 担心改到别的 + 不知道哪些 class 已死。目标形态：(a) 立即跑 RFC-035 承诺的「30 天后 cleanup PR」删 dead alias（`status-badge`/`mcp-probe-chip`/`reviews-row` 残/`repos-table` 残，预估 -350~500 行）；(b) 中期把 styles.css 按「token / 原语 / 骨架 / 业务」拆文件或 CSS Modules 化。

**[UI-X6] 收敛无强制力——新功能默认绕过原语** — 触发场景：每一个新 RFC。根因：UI-D3（无 grep 守卫）。这是把上面所有瓶颈「钉死」的元问题：即便补齐了 `<Table>`/`<Tabs>`/`<TextInput password>`，只要没有红线测试拦「新写裸 `<table>`/`<input>`」，下一个 RFC 还会再造。目标形态：源码层文本断言（白名单原语文件）+ CI 强制，让「绕过」直接编译/测试失败。

---

## 5. 耦合 / 分层违规

**[UI-C1] 业务 CSS 与原语 CSS 同居 styles.css，无命名空间隔离** — 级别 P2｜类型 coupling｜证据：`.oidc-form`（settings 业务）、`.diagnose-table`（RFC-057 业务）、`.batch-import-table`（RFC-033 业务）与 `.btn`/`.tabs`/`.data-table`（全局原语）在同一文件无分层。｜影响：删业务功能不敢删对应 CSS（怕误删原语）；原语演进时业务 class 跟着被 review 噪音淹没。｜建议：见 UI-X5。

**[UI-C2] i18n：RFC-036/099 新增的多用户路由大量用 `defaultValue:` 内联英文，绕过编译期类型校验** — 级别 P2｜类型 design/test-gap｜证据：`grep -rc "defaultValue:" --include=*.tsx` → `routes/settings.tsx:50`、`account.tsx:46`、`users.tsx:21`、`auth.tsx:12`、`components/UserMenu.tsx:8`。MEMORY「编译期类型检查，新 key 漏翻会编译失败」的保护**被 `t(key,{defaultValue})` 旁路**——这些字符串不在 bundle 里，中文环境直接显示英文 default。｜影响：多用户相关页面中英混排风险，且翻译漂移检测失效（项目引以为豪的 i18n 强一致在这批新页失守）。｜建议：把 settings/account/users/auth 的 `defaultValue` 文案补进 `zh-CN.ts`/`en-US.ts` bundle，删 `defaultValue`，恢复编译期保护。（注：`grep '[一-龥]'` 命中的组件经抽检多为代码注释，非未翻译 JSX 字面量——i18n 在老路由覆盖良好，问题仅集中在这批新路由。）

---

## 6. 测试 / 可观测性缺口

**[UI-T1] UI 一致性测试只锁「class 已定义」，不锁「调用方采用」** — 见 UI-D3。`btn-variants-styles.test.ts` / `tabs-modifier-styles.test.ts` 是必要但不充分的守卫。缺：采用面反向守卫（禁止新原生元素/error-box/裸 table）。

**[UI-T2] 手写 tab/segmented 无 a11y 测试** — 13+8 处手写控件没有 `findByRole('tab')` 级别断言（CLAUDE.md 要求「能用 role 就优先 role」）；UI-B1 的 ARIA 缺失正是因为没有测试逼它。抽 `<Tabs>`/`<Segmented>` 时一并补 role + 键盘导航测试。

---

## 7. 目标形态（Target architecture）

理想的前端 UI 设计系统应满足「**唯一入口 + 强制力**」两条：

1. **每类 UI 形态恰有一个 React 组件作唯一入口**，class 退为内部实现：
   - 已达标：`Dialog` / `StatusChip` / `Select` / `Form.*` / `EmptyState` / `LoadingState` / `ErrorBanner` / `ConfirmButton` / `DetailLayout` / `ChipsInput`。
   - **需新增**：`<Tabs>`（吸收 13 处手写 + 4 个 modifier）、`<Segmented>`（吸收 8 处手写 + diff-mode/scope 段控）、`<Table>`（吸收 6 套 table CSS + 23 个裸 `<table>`）、`<Checkbox>`（列表多选）、`<DialogFooter>`、`<AsyncList>/<QueryView>`（query→三态）。
   - **需最小扩展**（RFC-045 式）：`TextInput` 加 `password`/`autoComplete`/`autoFocus`/`name`/`minLength`，消灭 `.oidc-form`/`.users-create-form`/`.auth-form` 三套 chrome。
2. **强制力**：源码层 grep 守卫（白名单原语文件）拦「新原生 `<input>`/`<select>`/`<table>`/`error-box`/inline loading」，进 CI。让「绕过」= 编译/测试失败，而不是靠 code review 自觉（RFC-035 证明自觉不够）。
3. **styles.css 治理**：先删 RFC-035 deprecated dead alias（已到期），再按 token/原语/骨架/业务分层或 CSS Modules 化。
4. **i18n**：禁止 `t(key,{defaultValue})` 用于稳定 UI（守卫拦），恢复全量编译期校验。

落地建议作为 **RFC「UI 设计系统 v2 / 收敛强制化」**，分 3 PR：PR1 = `<TextInput password>` + 三套 form chrome 消除 + grep 守卫骨架；PR2 = `<Tabs>`/`<Segmented>`/`<Table>` 三组件 + retrofit；PR3 = `<AsyncList>` + error-box/loading 全量收敛 + dead CSS 清理。

---

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话建议 |
| --- | --- | --- | --- | --- | --- |
| 1 | UI-D3 / UI-X6 | 无 grep 守卫，收敛无强制力 | P1 | test-gap/design | 补源码层反向守卫进 CI，否则下面都白做 |
| 2 | UI-D1 / UI-X1 / UI-X2 | 缺 `<Tabs>`/`<Segmented>`/`<Table>` 组件 | P1 | extensibility | 抽 3 个受控组件，class 退为实现 |
| 3 | UI-D2 / UI-X3 | `TextInput` 缺 password → 3 套 form chrome | P1 | design/extensibility | 最小扩展 TextInput，删三套 chrome |
| 4 | UI-X4 | 列表三态（loading/empty/error）未封装 | P1 | extensibility | 抽 `<AsyncList>`/`<QueryView>` |
| 5 | UI-B2 | 39 处 error-box 绕过 ErrorBanner | P2 | impl-bug | 随 dedup §3.8/RFC-E 收敛（已被覆盖） |
| 6 | UI-B1 / UI-T2 | 手写 tab ARIA 一半缺失 | P2 | impl-bug | 由 `<Tabs>` 统一修 |
| 7 | UI-B3 / UI-B4 | 59 inline loading + 11 原生 checkbox | P2 | impl-bug | 批量迁 LoadingState/EmptyState/Switch |
| 8 | UI-C2 | 新多用户路由 defaultValue 旁路 i18n 校验 | P2 | design | 文案进 bundle，删 defaultValue |
| 9 | UI-X5 | styles.css 10768 行 + dead alias 未清 | P2 | perf/coupling | 跑 RFC-035 到期 cleanup + 分层 |
| 10 | UI-D4 | 缺 DialogFooter 标准 | P3 | design | 抽 `<DialogFooter>` |

---

### 附：用户问题的直接回答 ——「可抽取/可统一公共组件清单」

**A. 应新增（共享库完全没有）**
| 目标组件 | 收敛对象（调用点 file:line） |
| --- | --- |
| `<Tabs>` | `tasks.detail.tsx:260`、`clarify.detail.tsx:700`、`NodeDetailDrawer.tsx`、`canvas/NodeInspector.tsx`、`AgentImportDialog.tsx`、`memory/MemoryAllList.tsx`、`launch/RepoSourceRow.tsx`、`skills.new.tsx`、`reviews.tsx`、`settings.tsx`、`auth.tsx`、`clarify.tsx`、`memory.tsx`（共 13 文件 `.tabs__tab`）+ 非规范族 `memory-tab-bar`(`memory.tsx`)/`task-detail-tabs`(`tasks.detail.tsx`)/`sub-tab`(`memory/MemoryScopedList.tsx`)/`three-tab`(`auth.tsx`)/`ub-tabs`(`memory.tsx`)/`file-tab`(`WorktreeDiffPanel.tsx`,`structure/StructuralDiffView.tsx`) |
| `<Segmented>` | `AclPanel.tsx:157`、`tasks.detail.tsx:477`、`memory/MemoryFormFields.tsx`、`structure/StructuralGraph.tsx`、`structure/CallChainView.tsx`、`structure/StructuralDiffView.tsx`、`clarify.detail.tsx`、`reviews.detail.tsx:544`(`diff-mode-segmented`)（共 8 文件） |
| `<Table>` | `routes/{plugins,agents,tasks,skills,mcps,reviews,users,workflows,account,repos}.tsx`、`inventory/{AgentsTable,SkillsTable,PluginsTable,McpsTable}.tsx`、`tasks/TaskDiagnosePanel.tsx`、`repos/BatchImportDialog.tsx`、`skill/SkillVersionHistory.tsx`、`memory/MemoryDistillJobsTable.tsx`、`skills/ImportZipPanel.tsx`（共 23 个裸 `<table>`，6 套 CSS） |
| `<Checkbox>` | `launch/FilesPicker.tsx:99`、`agents/DependencyAutodetectDialog.tsx`、`structure/StructuralGraph.tsx`（列表多选） |
| `<AsyncList>` / `<QueryView>` | 59 处 inline `isLoading/isPending`（`*Picker.tsx`、`ResourceList.tsx`、列表路由等） |
| `<DialogFooter>` | 各 dialog 自拼 footer（`dialog__footer` 调用点） |

**B. 应最小扩展（原语已存在，缺 prop）**
| 原语 | 缺口 → 加 prop | 解锁的收敛 |
| --- | --- | --- |
| `Form.TextInput`（`Form.tsx:36`） | `type: +'password'`、`autoComplete`、`autoFocus`、`name`、`minLength` | 消灭 `.oidc-form`(settings.tsx)/`.users-create-form`(users.tsx:250)/`.auth-form`(auth.tsx:163) 三套 chrome |
| `Dialog`（`Dialog.tsx`） | 配套 `<DialogFooter>` | 统一 modal 底部按钮 |

**C. 应替换收敛（落原生/自写 chrome → 已有公共件）**
| 现状（file:line） | 应改为 |
| --- | --- |
| 39 处 `<div className="error-box">`（`ResourceList`/`RuntimeStatusCard`/`Onboarding`/`NodeDetailDrawer`/home/* …） | `<ErrorBanner>` |
| 59 处 inline `<div className="muted">{t('common.loading/empty')}</div>` | `<LoadingState>`/`<EmptyState>` |
| 11 处原生 `<input type=checkbox>` 布尔开关（`settings.tsx:1150`、`QuestionForm.tsx:400` …） | `Form.Switch`（列表多选除外，走新 `<Checkbox>`） |
| `routes/users.tsx:250` 无 className 的 `<input>` | `<TextInput>` |
| settings/account/users/auth 的 `t(key,{defaultValue})` | bundle key + 删 defaultValue |

**D. 应清理的 dead CSS（RFC-035 到期 alias，tsx 已不引用）**：`.status-badge`、`.mcp-probe-chip`、`.repos-table`(残)、`.reviews-row__*`（仅 clarify/reviews 复用残留）等，预估 styles.css -350~500 行。
