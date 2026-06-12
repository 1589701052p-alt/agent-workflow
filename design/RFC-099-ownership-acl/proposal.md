# RFC-099 — 资源级 owner/用户 权限系统（代理/技能/MCP/插件/工作流/任务/评审/反问）

> 状态：Draft。触发：2026-06-12 用户「实现代理、技能、MCP、插件、工作流、任务、评审、反问的
> 权限系统，每个元素都有其 owner 和用户……」。落档前与用户做了 5 轮反问澄清（共 19 个决策点，
> 全部得到明确答复，见 §决策登记）。基础设施沿用 RFC-036（users / 三轨鉴权 / 任务级
> owner+collaborator / 权限目录）。

## 背景

RFC-036 落了多用户地基：用户体系（schema.ts:1016）、三轨鉴权、全局权限目录
（shared/permission.ts —— 资源写 admin-only、user 全局只读）、任务级
owner+collaborator 可见性（taskCollab.ts:25 `canViewTask`）、节点级 reviewer/clarify_target
指派（schema.ts:1179 `node_assignments`）。但有三块没有覆盖：

1. **五类资源（代理/技能/MCP/插件/工作流）没有归属概念**——全局共有，admin 写、全员读。
   多人使用时无法表达「这是我的代理，只分享给指定同事」。
2. **节点级指派机制后端休眠**——表 + API + 决策权检查分支都在
   （tasks.ts:227/247、reviews.ts:74、clarify.ts:73），但启动器前端从未落选人 UI，实际
   从来没人能指派；任务 collaborator 同样没有任何配置 UI。
3. **评审/反问的归属记录粗糙**——`review_comments.author` / `doc_versions.decided_by` /
   `clarify_rounds.answered_by` 只有单一 user id，无角色快照、无逐题归属、无
   「最终提交人 vs 逐题修改人」之分，界面也不显示是谁做的。

## 目标

1. **资源级 ACL**：代理/技能/MCP/插件/工作流五类资源各自带单一 owner + 授权用户列表 +
   「全员可用(public)」开关。owner（与 admin）可改/可删/可转让/可管成员；授权用户可查看、
   可使用；未授权用户**完全不可见**（列表过滤、详情 404、选择器不出现、引用处显示无权限占位）。
   所有登录用户都可创建，创建者即 owner。
2. **任务成员补全**：沿用 tasks.ownerUserId + task_collaborators，本次补齐 UI（启动时选初始
   用户 + 详情页成员面板）；任务用户与 owner **同权**（取消/重试/恢复/诊断修复都可），仅成员
   增删、owner 转让、任务删除保留给 owner+admin。
3. **评审/反问权限继承任务**：任务 owner 和任务用户（+admin）都可以查看并回答其下所有评审
   （意见 + 批准/拒绝/迭代决策）和反问；顺势**移除休眠的节点级指派机制**（node_assignments
   表 + API + 检查分支 + task_collaborators 的 reviewer/clarify_target 角色）。
4. **归属记录 + 界面展示**：评审意见、评审决策、反问提交均记录 user id + 任务关系角色快照
   （取值 {owner, user, admin}，成员身份优先：是 owner 记 owner、是任务用户记 user、都不是
   但凭 admin 介入才记 admin）；界面显示「displayName（角色）」。
5. **反问多人协作草稿**：答案逐题自动保存为服务端草稿，多人可分别编辑不同题；并发同题
   last-write-wins；每题记录最后修改人（user id + 角色 + 时间）；任一有权用户可提交，提交人
   单独记录并冻结逐题归属。WS 实时推送草稿变更（「XX 刚刚更新了本题」）。
6. **归属信息与 agent 上下文严格隔离**：以上所有用户信息仅落库 + 界面展示，**绝不进入任何
   agent prompt**（`renderCommentsForPrompt`、`buildPromptContext`、
   `buildClarifyPromptBlock` 等渲染面保持只输出问题/答案/意见文本），并加单测 + 源码层
   grep 双重回归防护。
7. **记忆随权限走**：agent 记忆只有能看到该 agent 的人可读，workflow 记忆同理；repo/global
   记忆全员可读。记忆的管理操作（审批/驳回/编辑/归档/删除）随 scope 资源 owner（+admin）；
   repo/global 记忆仍 admin-only。运行时注入逻辑（memoryInject.ts）不变。
8. **来源目录开放**：skill_sources 所有用户可登记，记录创建者；其扫描导入的 external 技能
   owner 自动继承来源创建者。

## 非目标

- 仓库(repos)、全局设置、OIDC、备份、用户管理：保持现状（settings/repos 写仍 admin-only，
  repos 全员可见可用）。
- 记忆蒸馏 jobs 页面与 distiller 行为：保持现状（不按 scope 过滤 job 列表，单独 follow-up）。
- 不做 viewer-only 授权档位（v1 只有 owner / 用户 两级 + public 开关）。
- 不做工作流定义 JSON 的逐 viewer 脱敏：工作流可见者在定义 JSON 里能看到所引用 agent 的
  **名字**（UI 层显示无权限占位，但 API payload 不重写）——已知轻微元数据泄露，v1 接受。
- 不改 opencode 注入、runner、scheduler 的任何运行时行为（daemon 以 `__system__` admin 全权
  运行，不受 ACL 影响）。
- 不动 RFC-058 保留的 legacy `clarify_sessions` / `cross_clarify_sessions` 镜像表（归属新列
  只加在权威表 `clarify_rounds` 上）。

## 决策登记（5 轮反问的最终答复）

| #   | 问题             | 决策                                                                          |
| --- | ---------------- | ----------------------------------------------------------------------------- |
| D1  | 未授权可见性     | 完全不可见；详情 404；引用处无权限占位；admin 全可见全可改                     |
| D2  | 存量归属         | owner=最早创建的 admin（无 admin 时 `__system__`）；引入 public 档位，存量全部 public |
| D3  | 依赖传递         | 启动任务只校验工作流本身可用；引用闭包随工作流隐式可用                         |
| D4  | 创建权           | 所有用户可创建五类资源，创建者即 owner                                         |
| D5  | 评审/反问归属    | 完全继承任务成员，不单独维护授权列表                                           |
| D6  | 指派机制         | 顺势移除（表 + API + 检查分支）                                                |
| D7  | 角色记录         | 任务关系角色 {owner,user,admin} + user id，**界面要显示**                      |
| D8  | 反问草稿         | 服务端草稿 + 逐题记录最后修改人 + 提交人单独记录                               |
| D9  | owner 管理       | 单一 owner；owner+admin 可转让、可管用户列表（含 public 开关、删除）           |
| D10 | 任务成员配置     | 启动时选 + 详情页可改；owner+admin 管理                                        |
| D11 | 范围             | repos/settings 保持现状；skill_sources 全员可登记、导入技能随源创建者          |
| D12 | 记忆             | 读可见性随 scope 资源；管理操作随 scope 资源 owner；repo/global 仍 admin       |
| D13 | 任务用户操作权   | 用户同权（除成员管理/owner 转让/删除任务）                                     |
| D14 | 草稿并发         | 逐题 last-write-wins + WS 实时提示                                             |
| D15 | 保存校验         | 只校验**新增**引用（工作流加 agent、agent 加 skills/mcp/plugins/dependsOn）    |
| D16 | 成员列表可见性   | 资源可见者皆可见成员列表（只读），owner+admin 可改                             |
| D17 | 角色快照优先级   | 成员身份优先：owner > user > admin                                             |
| D18 | 新建资源默认档位 | **public（全员可用）**，owner 可随时收紧为 private（用户批准 RFC 时修订）     |
| D19 | 单用户模式       | 沿用 RFC-036 multiUserEnabled gating：daemon/单用户下 `__system__`=admin，行为零变化 |
| D20 | 任务默认私有     | （2026-06-12 用户「调整下要求，任务默认私有，其他默认public」）任务**不随 D18**：无 visibility 开关、恒为成员制私有——仅 owner + 任务用户 + admin 可见（列表/详情/评审/反问/WS 全链路），非成员 403/不可见；五类资源维持 D18 默认 public。实现上任务本就如此（tasks 表无 visibility 列），本条把不对称默认值钉为正式要求，防止后续把任务并入 D18 | 

## 用户故事

1. 用户 A 创建「合规审计代理」并收紧为 private；把同组 B 加进用户列表。B 能在自己的工作流
   里挂这个代理；C 在代理列表里根本看不到它。
2. A 用含该代理的工作流启动任务，把 B、C 选为任务用户。C 虽看不到代理本身，但能看到任务、
   能回答任务里的评审和反问（D3 隐式可用 + D5 继承）。
3. 反问弹出 5 个问题：B 答了 1–3 题（草稿自动保存，逐题记下 B），C 补答 4–5 题并点提交。
   记录里 1–3 题归 B、4–5 题归 C、提交人是 C；任务详情界面按题显示「B（用户）」「C（用户）」，
   而重跑 agent 的 prompt 里只有问题与答案文本。
4. admin 不在任务成员里，但介入替 A 拍了一个评审决策——记录显示「admin 介入」（角色=admin）。
5. A 离职，admin 把 A 名下资源与任务 owner 转给 B；历史归属记录不变。

## 验收标准

- [ ] 非成员非 admin 用户：五类资源列表查不到他人 private 资源、详情 404、画布侧栏/下拉不
      出现；public 资源与被授权资源正常可见可用。
- [ ] owner 与 admin 可改/删/转让/管成员；非 owner 授权用户改写 → 403；创建者自动成为 owner。
- [ ] 存量迁移后：全部资源 owner=最早 admin（或 `__system__`）、visibility=public，任何既有
      用户的可见/可用行为与升级前完全一致（零破坏）。
- [ ] 启动任务仅要求工作流可用；保存工作流/代理时新增引用不可用 → 422 列出缺失项。
- [ ] 任务成员可在启动时选择、详情页增删；任务用户能取消/重试/恢复；非成员对任务不可见
      （沿用既有闭包）。
- [ ] 评审/反问：任务成员皆可答；node_assignments 表与 assignments API 移除（POST /api/tasks
      的 `assignments` 字段拒收——**Breaking for automation**）。
- [ ] 评审意见/决策、反问提交均落 user id + 角色快照；反问逐题落最后修改人；评审/反问详情页
      显示归属（displayName + 角色 chip）；历史行（'local'）渲染兼容。
- [ ] 反问草稿：多人先后编辑不同题各自记名；同题并发后写胜；提交冻结；WS 推送草稿变更。
- [ ] Prompt 隔离：单测断言渲染产物不含任何 userId/displayName/角色字样 + 源码层 grep 锁定
      渲染函数不引用归属列。
- [ ] 记忆：agent/workflow 记忆列表与详情按 scope 资源可见性过滤；scope 资源 owner 可审批/
      编辑/归档/删除自己资源的记忆；repo/global 仍 admin。注入产物 byte-equal 不变。
- [ ] WS：/ws/workflows、/ws/memories 逐帧按可见性过滤（复用 tasks-list 的逐帧过滤模式）。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 smoke +
      e2e（双用户流程）。
