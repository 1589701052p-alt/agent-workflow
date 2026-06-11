# RFC-099 — 任务分解

> 按本仓 main-branch 直推惯例（[feedback_main_branch_only]），拆 5 个 commit 批次 B1–B5，
> 每批独立可绿（typecheck + test + format:check 过了才推，推后查 CI）。
> 单 RFC 多批的理由：触面横跨 migration / 5 资源路由 / 任务 / 评审反问 / 记忆 / WS / 前端
> 公共组件 / 8+ 页面，单 commit 不可审。

## B1 — 模型与 ACL 核心（schema + shared + service）

- **T1** migration `0045_rfc099_ownership_acl.sql`：五表加列（visibility 默认 public，D18
  修订）+ owner backfill（最早 admin / `__system__` 兜底）、`resource_grants` 建表、
  `skill_sources.created_by`、归属四列（author_role / decided_by_role / submitted_by_role /
  answer_attributions_json + draft_answers_json）；drizzle schema.ts 同步加列。
  **collaborator 角色收编 + `DROP TABLE node_assignments` 挪到 migration 0046（B3/T7）**，
  与引用代码删改同批，保证 B1 独立编译。fixture 迁移断言（有/无 admin 两库）。
- **T2** shared：permission.ts baseline 扩容（5 资源 write + 4 memory 管理点）+ 快照测试
  更新；`TaskActorRole` / Acl schema / attribution schema / `clarify.draft.updated` ws 变体。
  **StartTaskSchema 删 assignments 挪到 B3/T7**（routes/tasks.ts 引用同批删）。
- **T3** `services/resourceAcl.ts`：canViewResource / requireOwner / visibleIdsFilter /
  resolveTaskRole + 全矩阵单测。

## B2 — 五资源路由 + 保存校验 + WS（依赖 B1）

- **T4** agents/skills/mcps/plugins/workflows 路由：列表过滤、详情 404、写 requireOwner、
  创建归属（owner=actor, private）、ACL GET/PUT 端点（owner 转让旧 owner 留列表）、YAML
  import/export 归属、skill reconciler 带 owner（随源创建者）+ skill_sources 全员可建。
- **T5** 引用校验纯函数 `extractResourceRefs / extractAgentRefs / diffNewRefs` + wire 到
  workflows PUT / agents POST·PUT（422 `acl-missing-refs`，存量宽限）。
- **T6** WS：workflows 通道逐帧过滤 + acl.updated 失效；memories 通道逐帧过滤（依赖 T9 的
  memory filter，可放 B3 一并交付——以实际依赖为准，在 commit message 注明）。

## B3 — 任务 / 评审反问 / 记忆（依赖 B1）

- **T7** 任务：`PUT /api/tasks/:id/members`（owner 转让事务）、cancel/resume/retry/repair/
  feedback 门槛放宽为 `requireTaskMember`、删除 assignments API + taskCollab 五个指派函数、
  POST /api/tasks 拒收 assignments。
- **T8** 评审/反问门槛统一 `requireTaskMember`（reviews.ts:49-74 / clarify.ts:51-98 翻转既有
  403 case）+ 归属写点三处（authorRole / decidedByRole / submittedByRole+冻结逐题归属），
  角色快照走 resolveTaskRole。
- **T9** 反问草稿：`PUT /api/clarify/:nodeRunId/draft`（成员 only、awaiting_human only、逐题
  LWW、归属更新、WS 广播）+ 提交端点合并草稿归属 + 清草稿；memory 可见性过滤
  `visibleMemoryFilter` + `canManageMemory` 接入全部写端点（byte-equal 注入不变量保持绿）。
- **T10** Prompt 隔离双层回归（渲染单测 + 源码层标识符 grep 断言）。

## B4 — 前端（依赖 B2/B3）

- **T11** 公共组件：`UserPicker.tsx` + `AclPanel.tsx`（含只读态）+ 单测。
- **T12** 资源页接入：5 列表 owner 徽标 + 详情「权限」section + 画布侧栏可见集/节点占位
  label + 多用户 gating。
- **T13** 任务链路：启动器「任务用户」选人 + 任务详情成员面板（增删/转让）。
- **T14** 评审/反问展示：归属 chip（'local' 历史兼容）、反问逐题 footer + 草稿自动保存
  （debounce 1s）+ WS toast + 提交人展示。
- **T15** 记忆页过滤 + canManage 按钮显隐；i18n 中英对称（~50 key）+ symmetry 测试。

## B5 — e2e + 收尾（依赖 B4）

- **T16** e2e 双用户 spec（proposal §用户故事 1–4 串联）。
- **T17** 文档收尾：design/plan.md 索引 → Done、STATE.md 完工行、CLAUDE.md Architecture
  concepts 补一句资源 ACL 模型；按 [feedback_post_commit_ci_check] 全批次 CI 核查。

## 依赖与风险

- B2/B3 可并行（共同依赖 B1）；B4 依赖两者的 API 形状。
- 风险 1：StartTaskSchema 删 assignments 是 automation breaking——release note 标注。
- 风险 2：单二进制 build smoke 对 shared 导出敏感（[reference_binary_build_module_cycle]）——
  B1 推前本地跑 `bun run build:binary`。
- 风险 3：多人并发 working tree——全程按路径精确 `git add`，不碰他人 in-flight 文件。

## 验收清单（与 proposal §验收标准一一对应，B5 收尾时逐项勾）

- [ ] 五资源 ACL 全链路（含迁移零破坏）
- [ ] 启动只查工作流 / 保存查新增引用
- [ ] 任务成员 UI + 同权操作 / 指派机制移除
- [ ] 评审/反问成员门槛 + 归属记录 + 界面展示
- [ ] 反问草稿协作（LWW + 逐题归属 + 提交冻结 + WS）
- [ ] Prompt 隔离双层防护
- [ ] 记忆随权限（读 + 管理）注入不变
- [ ] WS 双通道逐帧过滤
- [ ] 三绿 + binary smoke + e2e + CI 全绿
