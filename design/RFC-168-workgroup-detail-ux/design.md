# RFC-168 技术设计——工作组详情页 UX 重构

对应 proposal:`./proposal.md`。纯前端改动,后端 / shared 零触碰。

## 1. 组件架构

### 1.1 现状(RFC-164 PR-1)

```
workgroups.detail.tsx
├─ DetailHeaderActions(ACL/保存/删除/重命名/启动)
├─ readiness banner
├─ WorkgroupForm(全宽配置表单:描述/章程/模式/开关/轮数/完成门)
├─ FormSection「成员」
│   └─ WorkgroupMemberCards(小卡片 + 卡内 编辑/移除/设leader 按钮)
│       ├─ AgentMemberDialog(添加 agent,含能力卡预览)★ mid-run 复用
│       ├─ HumanMemberDialog(添加 human)★ mid-run 复用
│       └─ EditMemberDialog(改别名/角色)— 仅此文件内部使用
└─ Dialog(重命名)
```

★ `WorkgroupTaskConfigDialog.tsx:21` 直接 import `AgentMemberDialog` /
`HumanMemberDialog`——mid-run(任务详情页)没有右侧面板可用,这两个 Dialog 壳
**必须保留**。`EditMemberDialog` 无外部引用,本 RFC 删除(编辑收进面板)。

### 1.2 目标

```
workgroups.detail.tsx(改造:两栏骨架 + 选中态)
├─ DetailHeaderActions(不变;save.onSuccess 不再 navigate,改「已保存」按钮态)
├─ readiness banner(不变,位于两栏之上)
├─ div.workgroup-studio
│   ├─ div.workgroup-studio__main
│   │   └─ WorkgroupMemberGallery(由 WorkgroupMemberCards 改造)
│   │       — 卡片可点选(selected 高亮),卡面无操作按钮
│   │       — agent 卡:别名/leader 徽章/agent 名/角色描述/端口摘要 chips/悬空警示
│   │       — human 卡:别名/用户显示名/角色描述
│   │       — 尾部「+ 添加 agent 成员」「+ 添加人类成员(非 dyn)」按钮
│   └─ aside.workgroup-studio__panel(sticky)
│       └─ WorkgroupContextPanel(新)——三态:
│           ① config:复用 WorkgroupForm(整体迁入,窄布局自适应)
│           ② member:MemberPanelBody(新)——别名/角色/保存成员/设leader/移除
│              + AgentCapabilityCard(agent 成员,只读)+「编辑 agent 定义 →」链接
│           ③ add:AddMemberPanelBody(新)——AgentMemberFields 或
│              HumanMemberFields(自 Dialog 抽出的共享字段组)+ 确认按钮
└─ Dialog(重命名)(不变)

WorkgroupMemberCards.tsx →拆分→
├─ workgroup/MemberFields.tsx(新):AgentMemberFields / HumanMemberFields
│   — 纯字段组(agent 选择 datalist + 能力卡预览 + 别名 + 角色),受控组件
├─ AgentMemberDialog / HumanMemberDialog:改为「Dialog 壳 + *MemberFields」,
│   对外 props 契约不变(mid-run 调用零改动)
└─ EditMemberDialog:删除
```

### 1.3 选中态模型

```ts
type PanelState =
  | { kind: 'config' }
  | { kind: 'member'; key: string }          // WorkgroupMemberRowState.key
  | { kind: 'add'; memberType: 'agent' | 'human' }
```

- `useState` 持于 `workgroups.detail.tsx`,**不进 URL**(瞬时 UI 态;刷新回 config 可接受)。
- 选中成员被并发 PUT 移除(server row 刷新后 key 不存在)→ 面板自动回落 `config`
  (派生校验:`members.find(key) === undefined ⇒ config`,渲染期兜底,非 effect)。
- **实现期发现(2026-07-11):后端 full-replace PUT 会重新生成全部 member id**
  (`services/workgroups.ts` §1.2 注释「member ids regenerate」)——不止「并发移除」,
  **任何**成员 PUT 成功后旧选中 key 都失配。解法:把下述 F4 的内容复合键匹配推广为
  统一的**选中重解析** `findMemberKeyByContent(fresh, probe)`:保存成员 / 设 leader /
  添加成功后都按 `(memberType, reference, displayName.trim())` 在 fresh row 里找新
  key 重新选中(焦点策略 `none`——按钮点击后不夺焦;添加仍为 `title`);匹配失败才
  回落 config。
- 添加确认成功 → 新成员保持选中。**key 一致性陷阱(已核实)**:`makeAgentMemberRow`
  生成的是本地 `row-*` key(`nextMemberRowKey()`,"never on the wire"),而卡片渲染
  自 server row,key = server member id(`workgroupToMembersState`,workgroup-form.ts:190)
  ——用本地 key 选中会在 PUT 回写后立即失效。解法:`onApply` 契约从
  `Promise<boolean>` 扩为 `Promise<Workgroup | null>`(成功返回 fresh row;现有真值
  判断兼容),添加面板确认成功后在 fresh row 里匹配新成员取其 server id,
  `setPanel({ kind: 'member', key: 该 id })`。
  **匹配键必须是 wire 规范化值(设计门 F4)**:输入态保留原始字符串而校验/发送层
  都 `trim()`(workgroup-form.ts:253-260、345-351),`" reviewer "` 过校验、以
  `"reviewer"` 回写——按原始 displayName 匹配必失配。故按
  `(memberType, reference, displayName.trim())` 复合键匹配(displayName 组内唯一
  是 `validateMemberDraft` 既有约束,trim 后仍唯一——校验即按 trim 值查重)。
  测试锁一条「首尾空白别名添加后仍保持选中」。

## 2. 数据流与保存语义(全部沿用现状,仅换容器)

| 操作 | 通道 | 变化 |
| --- | --- | --- |
| 组配置(描述/章程/模式/开关/轮数/完成门) | `useDraftFromQuery` draft + header 保存(PUT 全量,members 透传) | 容器从主区迁入面板 config 态;**save.onSuccess 删除 `navigate('/workgroups')`**,改为「已保存」按钮态(现有 i18n `saved` 文案先例) |
| 成员 增/改/设leader/移除 | immediate PUT:read-current → `lib/workgroup-form.ts` 纯函数 → `onApply` | 触发位置从卡面按钮/Dialog footer 迁入面板;**纯函数层(addMember/patchMember/removeMember/setLeader/validateMemberDraft…)零改动** |
| 成员编辑草稿 | Dialog 内 useState → 面板内 useState | 面板 member 态以 `key` 为 React key 重挂载,保证切换成员时草稿重置(与「Dialogs mount on open」同理) |

**「已保存」态的正确语义(设计门 F2,P1)**:draft 在 PUT in-flight 期间仍可编辑
(hydrate-once draft 契约不变),若响应落地时 draft 已再次变更,不得显示「已保存」
——那会对未保存的新改动撒谎。实现为**提交快照比对**:`save.mutate(payload)` 时记
`submittedRef = payload`;`onSuccess` 仅当「当前 draft 重建的 payload 深等于
submittedRef」才置 saved 态;**任何 `onChange` 立即清除 saved 态**。saved 态显示
在保存按钮上(`已保存`,2s 自动回落或被 onChange 打断)。测试锁:延迟 PUT +
请求期间继续编辑 → 响应落地后按钮回到「保存」(可再存)而非「已保存」。

**成员写操作 single-flight 契约(设计门 F5)**:现组件以 `applying`/`applyError`
统一禁用所有写入口(卡面 + dialog 确认),迁入面板后**保留同一契约**——
`membersMut.isPending` 期间面板内全部写操作(保存成员/设 leader/移除/添加确认)
与画廊添加按钮一并禁用(单飞,杜绝两次 full-replace 基于同一旧 `group` 的丢更新);
错误按**发起面板归属**:面板切换(选中另一成员 / 回 config / 进添加态)时
`membersMut.reset()`,全局 header 错误行保留最近一次(现状),面板内错误行只显示
属于当前面板的失败。失败不清草稿,可改后重试。

## 3. 卡片能力摘要(agent 端口 chips)

- 数据源:画廊组件 `useQuery(['agents'])`(与 AgentMemberDialog 现状同 key,天然
  共享缓存);`Map<name, Agent>` 查找。
- 投影:复用 shared `capabilityCardModel(agent, { promptBudget: 0 })` 取
  inputs/outputs(单一结构化投影,RFC-166 决策——不得另写投影)。
- 卡面展示:`in: a b +2 / out: c` 形态的 chips 行;端口 >3 截断为 `+n`(完整列表
  在面板能力卡里看)。样式复用 `.capability-card__port*` 既有命名空间,不新造。
- 悬空引用(agentName 不在 agents 列表):卡片显示 `StatusChip kind="warn"`
  「agent 不存在」;agents query 加载中 / 失败 → 摘要行整体不渲染(优雅降级,
  卡片仍显示别名/agent 名)。
- human 成员卡无能力摘要(RFC-166 human 无卡原则,prompt 隔离同源)。

## 4. 三模式差异(逻辑不变,位置迁移)

| 模式 | 画廊 | 面板 |
| --- | --- | --- |
| leader_worker | leader 徽章;成员卡全量 | member 态显示「设为 leader」(agent、非 leader) |
| free_collab | 无 leader 徽章 | 无设 leader;config 态三开关强制 ON 只读(现状) |
| dynamic_workflow | 无「+ 添加人类成员」按钮(现状) | 无设 leader;config 态开关区显示 dyn 提示(现状) |

模式切换在 config 态分段控件里完成(现状),切换后画廊徽章/按钮即时跟随 draft?
——**否**:徽章跟随 **server row**(`group.mode`),与成员区「render from server
truth」既有原则一致;draft 模式只影响 config 表单自身显隐。保存后 server row
刷新,画廊自然跟上。(现状 `WorkgroupMemberCards` 的 `showLeaderControls` 读
`props.group.mode`,维持。)

**mode-transition 错误必须可见(设计门 F3)**:draft mode 切到 `dynamic_workflow`
而当前成员含 human 时,`buildConfigUpdatePayload` 过 schema 失败 → Save 禁用,但
现 `WorkgroupForm` 只渲染 `maxRounds` 错误——用户面对无解释的禁用按钮。本 RFC 在
config 面板 mode 字段下**呈现成员兼容性错误**(i18n:「动态工作流模式不允许人类
成员,请先移除:{names}」;错误值由 builder 的 errors 映射,不足则 builder 增补
一个 `mode` 错误 key——这是 lib 的**错误 key 增补**,不改纯函数变换语义)。同理
禁用态的 Save 悬停 title 给出同文案。画廊添加按钮仍跟随 server mode(避免 draft
未保存就变更成员操作面),测试锁「lw→dyn draft + 现存 human → mode 错误行可见、
Save 禁用;移除 human 后可保存」。

## 5. 样式(styles.css,`.workgroup-studio` 命名空间)

- 两栏:`display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: var(--sp-6)`;
  `@media (max-width: 960px)` 降级单列(面板取消 sticky,自然堆叠于画廊之后)。
- 面板:`position: sticky; top: <header 高度>; max-height: calc(100vh - …); overflow-y: auto`,
  卡片化容器(边框/圆角/内边距与 `.card` 对齐)。
- 画廊:`grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`;卡片复用
  `<Card>` 组件;选中态 `.workgroup-card--selected`(主色边框 + 轻阴影,明暗双主题
  各自用现有 CSS 变量,不硬编码色值)。
- 卡片可点(设计门 F10 否决整卡 `<button>` 包裹——卡内含 `<h3>`/`<div>`/`<p>` 等
  非 phrasing 内容,塞进原生 button 违反内容模型,且 accessible name 会吞入端口/
  警示全部文本):**标题即 button + stretched hit-area** 模式——卡片标题渲染为
  `<button className="workgroup-card__open">{displayName}</button>`,accessible name
  = 成员别名(干净稳定);`.workgroup-card__open::after { position:absolute; inset:0 }`
  把命中区拉伸到整卡(卡容器 `position:relative`),视觉/鼠标行为与整卡可点等价。
  `aria-expanded={selected}` + `aria-controls=<panel id>`。Card 组件如需
  `className` 透传的最小扩展,按 UI 一致性原则扩展公共组件而非 fork。
- 遵守 Frontend UI consistency:表单一律 Form primitives / FormSection;按钮
  `.btn` 系;chips 复用 `.chip` / `.capability-card__port*`;**禁止**新造 modal/chrome。

## 6. a11y 与键盘

- 卡片开启按钮(§5):`aria-expanded={selected}` + `aria-controls=<panel id>`;
  Enter/Space 原生触发;accessible name = 成员别名。
- 面板:`<aside id="workgroup-context-panel" aria-label={t('workgroups.panelAria')}>`;
  member/add 态头部有关闭按钮(回 config)。
- **焦点迁移契约(设计门 F8)**——DOM 顺序是画廊在前、面板在后,键盘用户激活卡片后
  若焦点留在卡上,要 Tab 穿过剩余全部卡片才到编辑器;窄屏用户甚至看不到面板变化:
  - 激活卡片(选中)→ 焦点移到面板首个可聚焦元素(member 态 = 别名输入框,
    add 态 = agent 选择输入);
  - 关闭 / Esc → 焦点返回触发卡的开启按钮;
  - 面板内移除成员成功 → 焦点移到相邻卡的开启按钮(无剩余成员则 config 面板容器);
  - 添加成功保持选中新成员 → 焦点移到新成员面板标题。
- **Esc 绑定面板容器而非 document(设计门 F9)**:`onKeyDown` 挂在 aside 上,仅当
  焦点位于面板内时响应——天然不与重命名 / 删除确认 Dialog 的 ESC 抢层级(Dialog
  有 focus trap,焦点不在面板内),无需维护 `dialogOpen` 旁路。测试锁三层级:
  member 面板内 Esc 关面板;rename Dialog 内 Esc 只关 Dialog;删除确认 Dialog 内
  Esc 只关 Dialog、面板选中态不变。
- 测试锚点优先 `getByRole('button', { name })`;testid 沿用现有命名(见 §8)。

## 7. i18n

新增 keys(zh-CN / en-US 双语,`workgroups.*` 命名空间):
`panelConfigTitle` / `panelMemberTitle` / `panelAddAgentTitle` / `panelAddHumanTitle` /
`panelClose` / `memberSave` / `memberSaved` / `editAgentDefinition` /
`agentMissing` / `portsIn` / `portsOut` / `panelAria` / `configSaved`。
复用既有:`workgroups.memberField*`、`workgroups.setLeaderButton`、
`workgroups.memberRemove`、`common.save(d)` 系。

## 8. 现有测试锁定面与适配(grep 已盘,见 plan T6)

| 测试文件 | 锁定 | 处置 |
| --- | --- | --- |
| `workgroups-pages.test.tsx` | `workgroup-card-*`、`workgroup-member-edit-*`(卡内)、`workgroup-set-leader-*`(卡内 within)、`workgroup-add-agent-member` → `workgroup-add-agent-dialog`、`workgroup-member-displayname-input`、`workgroup-edit-member-confirm`、`workgroup-field-description` + `workgroup-save-button`(draft 流,无跳转断言);**另有源码 wiring 断言(:551-555)锁 `import { WorkgroupMemberCards } from '@/components/workgroup/WorkgroupMemberCards'` 等 detail 页组合(设计门 F1)** | 交互路径改为:点卡(`workgroup-card-*` 保留)→ 面板内断言;`workgroup-member-edit-*` 删除(点卡即编辑);`workgroup-set-leader-*` / displayname-input / confirm 系 testid **保留同名**,位置移入面板;add 流断言 dialog 出现 → 断言面板出现(`workgroup-panel-add`);**wiring 断言同步更新为新组件名(`WorkgroupMemberGallery`/`WorkgroupContextPanel`),保持源码锁风格** |
| `workgroup-task-config.test.tsx` | AgentMemberDialog/HumanMemberDialog 经 mid-run dialog——**现覆盖仅 Agent happy path(:230-252),Human/嵌套关闭/错误态无锁(设计门 F11)** | **既有断言全部保持 + 增量契约测试**(见 §8.1;「零改动」不足以保护重构——全绿也可能静默破坏未被锁定的 Human/嵌套行为) |
| `workgroup-form.test.tsx` | `lib/workgroup-form.ts` 纯函数 | 纯函数变换零改动;仅当 §4 mode 兼容错误需增补错误 key 时新增对应 case |
| e2e / 视觉基线 | 无 workgroups 详情页覆盖(已核:visual-regression 基线无 workgroups 截图;task-wizard 仅经 /tasks/new) | 无基线 churn |

### 8.1 Dialog 壳行为契约(设计门 F11,P1——抽 MemberFields 前先锁)

mid-run 复用的真实契约**不止 props 形状**,重构(抽 Fields)必须保持并用测试锁定:

1. **fresh mount 草稿重置**——Dialog 每次 open 重新挂载,草稿从空开始;
2. **`others` 唯一性校验**——displayName 与 others 重复 → 确认禁用 + 错误文案;
3. **别名自动跟随**——agent 名/选中用户驱动 displayName 直到手改(`aliasTouched`
   后停止跟随);
4. **确认只提交 validated row**——`makeAgentMemberRow`/`makeHumanMemberRow` 产物
   (trim 后),roleDesc 透传;
5. **`applying` 禁用确认、`applyError` 展示于 footer**;
6. **嵌套关闭层级**——mid-run 场景是 Dialog 套 Dialog,内层 cancel/Esc 只关内层。

增量测试(落 `workgroup-task-config.test.tsx` 或伴生新文件,既有断言不动):
mid-run **Human 完整 staging 全链**(选用户→自动别名→手改停跟随→roleDesc→确认
→staged 行呈现)、重复别名禁用、内层 Esc 只关内层、applying/error 态。

## 9. 新增测试(与改动同 commit,Test-with-every-change)

`packages/frontend/tests/workgroup-studio-panel.test.tsx`(新,vitest):

1. **三态切换**:默认 config 态渲染 WorkgroupForm 字段;点成员卡 → member 态
   (displayname input 预填);点关闭 / 再点同卡 / **面板内 Esc(F7)** → 回 config。
2. **成员保存**:member 态改别名 → 点保存成员 → 断言 PUT body 中该成员
   displayName 更新、其余成员透传(镜像现有 dialog 版 case)。
3. **设 leader / 移除**:面板内触发,断言 PUT body(leader_worker);free_collab /
   dynamic_workflow 无设 leader 按钮;移除后焦点落相邻卡(F8)。
4. **添加面板(agent)**:点添加 agent → add 态;选 agent 出现能力卡预览;确认 →
   PUT body 含新成员且新成员卡呈选中态(**含首尾空白别名仍选中,F4**);dyn 模式无
   添加 human 按钮(现状 case 迁移)。
5. **添加面板(human,F7)**:选用户 → 别名自动跟随 → 手改停止跟随 → roleDesc →
   确认 → PUT body + fresh-id 选中。
6. **能力摘要**:agent 成员卡渲染端口 chips(>3 截断 `+n`);悬空 agentName 显示
   警示 chip;human 卡无摘要;**agents query 失败 → 摘要/能力卡降级不渲染、成员
   编辑仍可用(F6)**。
7. **保存不跳转(回归锁)**:config 保存成功后断言仍在 `/workgroups/$name`
  (锁 proposal §3.6 的行为变更,防止未来恢复 navigate)。
8. **「已保存」时序(F2/F7,fake timers)**:延迟 PUT + 请求期间继续编辑 → 响应
   落地不显示「已保存」;不编辑 → 显示「已保存」2s 后回落;显示期间 onChange →
   立即清除。
9. **成员 PUT 失败(F6)**:409/422 → 面板内错误行 + 草稿保留 → 修改后重试成功;
   pending 期间所有写入口禁用(防双飞);失败后切换到另一成员 → 错误行不跟随
   (归属重置,F5)。
10. **并发移除兜底**:member 态下 server row 刷新致 key 消失 → 面板回 config 不炸。
11. **Esc 层级(F9)**:member 面板 Esc 关面板;rename / 删除确认 Dialog 内 Esc
    只关 Dialog、面板选中态不变。
12. **mode-transition(F3)**:lw→dyn draft + 现存 human → config 面板 mode 错误行
    可见、Save 禁用;移除 human 后可保存。

`workgroups-pages.test.tsx` 适配后所有既有断言(PUT body 形状、lenient save、
readiness banner、rename)保持语义等价;§8.1 的 mid-run 增量契约测试同 commit 落。

## 10. 失败模式

| 失败 | 表现 |
| --- | --- |
| 成员 PUT 409/422(并发写) | header 错误行 + 面板内错误行;面板草稿不丢,可改后重试 |
| agents 列表加载失败 | 卡片能力摘要与面板能力卡降级不渲染;成员编辑功能不受影响 |
| 选中成员被并发删除 | 面板回落 config(§1.3) |
| 窄屏 | 单列堆叠,无横向滚动(页面级禁止 overflow-x) |

## 11. 实现自查清单(节选自 CLAUDE.md 强制项)

- 公共组件优先:Dialog/Form/Select/Card/StatusChip/EmptyState/Segmented 全复用;
  Card 若需 className 透传按「最小扩展」处理。
- 视觉对齐自查:与 /agents、/workflows、/settings side-by-side 比按钮高度/圆角/
  spacing;明暗双主题截图(minimal repro 不适用——直接起 dev server 全页截图)。
- `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
  再 push;push 后查 CI(按我的 sha 查,非 --limit 1)。

## 12. 设计门评审记录(Codex,2026-07-11)

11 findings(2 P1 + 8 P2 + 1 P3),结论 block-approval-until-P1-fixed,**全部采纳
并折入本文档**:

| # | 级 | 内容 | 落点 |
| --- | --- | --- | --- |
| F1 | P3 | workgroups-pages.test.tsx:551 源码 wiring 断言锁旧 import 名,改名必红 | §8 表(wiring 断言同步更新) |
| F2 | P1 | 「已保存」未定义保存期间继续编辑语义,会对新改动撒谎 | §2(提交快照比对 + onChange 清除)+ §9.8 |
| F3 | P2 | draft mode 切 dyn + 现存 human → 无解释的禁用 Save | §4(mode 兼容错误呈现)+ §9.12 |
| F4 | P2 | displayName 原始串与 wire trim 串不一致,添加后选中失配 | §1.3(trim 复合键)+ §9.4 |
| F5 | P2 | 成员写操作缺 single-flight/错误归属/切面板清理契约 | §2(single-flight 契约)+ §9.9 |
| F6 | P2 | 测试无失败/pending/降级 case | §9.6/9.9 |
| F7 | P2 | 测试缺 Esc、human 添加全链、saved 时序 | §9.1/9.5/9.8 |
| F8 | P2 | 焦点迁移未定义(激活卡后焦点滞留,窄屏不可见) | §6(焦点契约四条)+ §9.3 |
| F9 | P2 | Esc document 级监听与 Dialog 抢层级 | §6(绑面板容器 onKeyDown)+ §9.11 |
| F10 | P2 | 整卡 `<button>` 包 Card 违反内容模型、accessible name 失控 | §5(标题 button + stretched hit-area) |
| F11 | P1 | mid-run 壳保护只靠「props 不变+测试零改动」不足(现测试仅 Agent happy path) | §8 表 + §8.1(行为契约六条+增量测试) |

另:我方自查提前发现并折入的缺陷——新增成员本地 `row-*` key 与 server id 不一致
(§1.3,后被 F4 进一步收紧为 trim 复合键)。

## 13. 实现门评审记录(Codex,2026-07-11)

2 P1 + 1 P2,全部核实为真、全部修复(同 commit 附回归测试):

| # | 级 | 缺陷 | 修复 |
| --- | --- | --- | --- |
| I-1 | P1 | 成员 PUT in-flight 时切面板调 `reset()`——清 isPending 但不取消请求,写入口重新解锁,可从 stale row 再发并发 full-replace(乱序丢更新) | 用户入口(点卡/关闭/Esc/添加)经 `changePanel` 统一冻结(`isPending` 早退);settle 后的内部重选走无 guard 的 `applyPanel`(await 后闭包 isPending 仍是旧 true,必须绕开) |
| I-2 | P1 | header 保存 config(成员透传)→ 后端重生成 id → 打开中的成员编辑器被判「成员已删」回落 config,未保存草稿被卸载;「已保存」flash 撒谎 | `save.onSuccess` 按 PRE-WRITE row 内容重解析选中(`findMemberKeyByContent`);MemberBody 的 React key 与焦点 identity 从 server id 改为**内容身份** `memberType:reference:displayName`——id 重生成不再重挂载,草稿天然保留 |
| I-3 | P2 | dirty 别名/角色时点设 leader → PUT 用 server row,成功后 id 重生成重挂载,dirty 值被旧值静默顶掉 | I-2 的内容身份 key 直接消解(不重挂载,dirty 草稿留存;wire 仍提交 server 值——未保存编辑不随设 leader 生效,语义明确) |

内容身份含 displayName 的原因:同一 agent 可用不同别名入组两次,`memberType:reference`
不唯一;别名被**保存**后 identity 变化触发的重挂载是无损的(草稿=刚保存的值)。

## 14. 用户验收期实时反馈(2026-07-11,三条,已修)

1. **「工作组配置滚到底也看不到末尾」**——两层根因叠加:①面板初版
   `max-height: calc(100vh-32px)` + 内部滚动在「画廊比面板矮 → 页面无滚动量 →
   面板停在自然位置」时底部被视口裁死;②**app-shell 潜伏 bug**:`.app-shell`
   只定义了 grid 列,隐式 auto 行被 sidebar 导航的 min-content(~830px)撑破
   100vh,`overflow:hidden` 裁死 `.content` 底部——**任何视口矮于 ~830px 时所有
   页面都滚不到底**(修:`grid-template-rows: minmax(0,1fr)` + sidebar 自滚;
   `app-shell-layout.test.ts` 源级锁)。
2. **「成员卡片用颜色区分 agent/人类,对齐工作流编排配色」**——agent 卡复用
   `.canvas-node--agent` 的 accent 边框;human 卡复用 review/clarify 的琥珀
   human-in-the-loop 家族 tint(`#d97706` 10%/45% color-mix);选中态仍由公共
   `.card--highlighted` 全权负责(`:not()` 让位)。
3. **「成员显示和工作组配置独立滚动条」**——滚动模型定稿(取代 1① 的 sticky
   过渡方案):`.page--studio` 把页面变为视口高 flex 列,`.workgroup-studio`
   `flex:1 + minmax(0,1fr)` 行,两列(`__main` / `.workgroup-panel`)各自
   `min-height:0 + overflow-y:auto` 独立滚动;页头/成员区/配置互不牵动。
   <960px 单列时恢复文档流(单页滚动条)。
