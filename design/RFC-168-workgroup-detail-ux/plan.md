# RFC-168 任务分解

单 PR(纯前端,无后端/schema 触碰;commit 前缀 `feat(frontend): RFC-168 …`)。
任务序即实现序;T1–T5 为实现,T6 测试与实现同 commit 交付(Test-with-every-change),
T7 为门禁。

## 任务

- **RFC-168-T1 骨架与选中态**
  `workgroups.detail.tsx`:`.workgroup-studio` 两栏骨架;`PanelState` 三态
  (config/member/add)+ 并发移除回落兜底;`WorkgroupContextPanel` 容器(config 态
  迁入 `WorkgroupForm`);save.onSuccess 去 navigate、改「已保存」按钮态
  (**F2:提交快照比对,onChange 立即清除 saved 态**);config 面板呈现 mode 成员
  兼容错误(**F3**)。
  依赖:无。

- **RFC-168-T2 成员画廊**
  `WorkgroupMemberCards` → `WorkgroupMemberGallery`:**标题 button + stretched
  hit-area 可点选(F10 否决整卡 button;aria-expanded/aria-controls)**+ 选中态
  样式;卡面按钮全部移除;agent 卡端口摘要 chips(`capabilityCardModel` 投影,
  >3 截断 `+n`)+ 悬空 agent 警示;human 卡无摘要;添加按钮(dyn 无 human)。
  Card 组件如需 className 最小扩展在此完成。
  依赖:T1。

- **RFC-168-T3 成员编辑面板**
  `MemberPanelBody`:别名/角色描述(key 重挂载草稿)、保存成员(immediate PUT,
  **F5 single-flight:pending 全写入口禁用、错误按面板归属、切面板 reset**)、
  设为 leader(lw+agent+非 leader)、移除(二次确认)、`AgentCapabilityCard` 只读
  +「编辑 agent 定义 →」链接;面板内错误行;**Esc 绑面板容器 onKeyDown(F9)**;
  **焦点迁移四条契约(F8:激活→面板首字段、关闭→触发卡、移除→相邻卡、
  添加→新面板)**。
  依赖:T1。

- **RFC-168-T4 添加成员面板化 + Dialog 壳保留**
  抽 `workgroup/MemberFields.tsx`(AgentMemberFields/HumanMemberFields 受控字段组);
  `AgentMemberDialog`/`HumanMemberDialog` 改为 Dialog 壳 + Fields(**对外 props 契约
  + design §8.1 六条行为契约全部保持**,mid-run 零行为变化);`AddMemberPanelBody`
  用同一 Fields;确认后新成员保持选中(**F4:`(memberType, reference,
  displayName.trim())` 复合键匹配 fresh row**);删除 `EditMemberDialog`。
  依赖:T1(与 T2/T3 可并行)。

- **RFC-168-T5 样式、响应式与 i18n**
  styles.css `.workgroup-studio` 命名空间(两栏 grid/sticky 面板/画廊 auto-fill/
  选中态,CSS 变量不硬编码色值);<960px 单列降级;design §7 全部 i18n key 双语落
  zh-CN/en-US。
  依赖:T1–T4。

- **RFC-168-T6 测试适配与新增**
  适配 `workgroups-pages.test.tsx`(交互路径 dialog→面板,testid 尽量同名保留,
  既有 PUT body/lenient save/readiness/rename 断言语义等价;**:551 wiring 断言
  更新为新组件名,F1**);新增 `workgroup-studio-panel.test.tsx`(design §9
  十二组 case,含 F2 saved 时序 / F4 空白别名 / F6 失败与降级 / F7 human 全链 /
  F9 Esc 层级 / F3 mode-transition);`workgroup-task-config.test.tsx` **既有断言
  全保持 + design §8.1 增量契约测试(mid-run Human 全链/重复别名/内层 Esc/
  applying-error,F11)**;`workgroup-form.test.tsx` 纯函数变换零改动(仅 F3 错误
  key 增补时加对应 case)。
  依赖:T1–T5(与实现同 commit)。

- **RFC-168-T7 门禁**
  `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿;
  dev server 明暗双主题视觉自查(三模式 × config/member/add 态截图,与 /agents、
  /workflows 对齐比对);Codex 实现门 review 并修复 findings;push 后按本 commit sha
  查 CI。
  依赖:T1–T6。

## 验收清单(对照 proposal §6)

- [ ] 两栏工作台 + <960px 单列降级
- [ ] agent 卡:别名/leader 徽章/agent 名/角色/端口 chips/悬空警示
- [ ] 点选↔取消选中↔Esc 三态切换(Esc 绑面板、不与 Dialog 抢层级)
- [ ] 成员编辑器全功能(别名/角色/保存/设 leader/移除/能力卡/跳转链接)+
      single-flight/错误归属
- [ ] 焦点迁移契约(激活→面板、关闭→触发卡、移除→相邻卡、添加→新面板)
- [ ] 添加走面板、dyn 无 human 入口、新成员保持选中(trim 复合键)
- [ ] 配置 draft+header 保存、保存后留在原地 +「已保存」反馈(编辑期不误标)+
      mode 兼容错误可见
- [ ] mid-run WorkgroupTaskConfigDialog 既有断言全保持 + §8.1 增量契约测试全绿
- [ ] lib/workgroup-form.ts 变换零改动(仅允许 F3 错误 key 增补)
- [ ] 四门禁全绿 + 双主题视觉自查 + Codex 实现门 + CI 绿

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 多人并发:他人 session 触碰 workgroup 前端文件 | 开工前 `git status` + 按路径精确 add;混合文件按 [mixed-file cross-dep commit] 流程 |
| Dialog 壳契约破坏 mid-run | T4 硬约束 props 不变;`workgroup-task-config.test.tsx` 作为守门测试先跑 |
| 测试 testid 改名遗漏 | 改名集全量 grep(`workgroup-member-edit-` 等)确认零残留 |
