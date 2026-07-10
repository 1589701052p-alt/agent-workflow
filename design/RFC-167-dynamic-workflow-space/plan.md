# RFC-167 plan——任务分解与 PR 拆分

> 规模：子系统级（新资源 + 内置编排 agent + 三阶段引擎 + 前端）。前置 RFC-166 落地。
> 4 PR，每个独立过全量门禁。改动即带测。

## PR-1 空间资源 + shared 生成协议（自洽，未接引擎）

- **T1** shared：`DynamicWorkflowSpace`/Create/Update schema；`DwGeneratedWorkflowSchema`
  （orchestrator 输出端口载荷）+ `dwGeneratedToWorkflowDef` 转换纯函数（节点→agent-single、
  inputs→edges、IO 补全）。测试：zod 正反例 + 转换矩阵（分支/并行/多次同 agent/孤儿）。
- **T2** migration A（journal +1）：`dynamic_workflow_spaces` 建表 + resource_grants 枚举加
  `'dynamic_workflow_space'`。测试：列锁 + 计数锁 bump + ACL 第七类注册。
- **T3** ACL + CRUD：`services/dynamicWorkflowSpaces.ts` + `routes/...`（照 workgroups）；
  resourceAcl/resourceRefs 注册第七类；池引用校验。测试：CRUD + 404 同形 + 池引用可用性门。
- **T4** 前端空间资源页：列表 + 快速创建弹窗 + 详情（池管理卡片 + RFC-166 AgentCapabilityCard
  预览）+ nav + i18n。测试：表单/池编辑/能力预览/列表。
- **T5** PR-1 门禁 + Codex 增量审查。

## PR-2 内置编排 agent + 生成引擎 + 确认门（后端闭环）

- **T6** `services/orchestratorAgent.ts` `buildOrchestratorAgent`（照 buildMergeAgent，不入表、
  内部运行时、单 `workflow` 输出端口、inline 编排协议 bodyMd）。测试：agent 对象形状 + 协议块
  文案锚点（v1 约束：只用 agent-single/禁 wrapper/每 agent 可多次）。
- **T7** migration B（journal +1）：`tasks` ADD dwspace_id + dwspace_config_json + 索引 +
  builtin `__dynamic_workflow_host__` 懒建（ensureDynamicWorkflowHost）。测试：tasks 全字段锁
  +2、seed 幂等、计数锁 bump。
- **T8** 启动：`StartDynamicWorkflowTaskSchema`（goal + repo 源复用）+ 合成生成阶段快照 +
  `startDynamicWorkflowTask`（空间可用门 / 池非空 / config 快照 / phase='generating'）+ 路由。
  测试：启动全链 + 池空拒绝 + 快照单节点。
- **T9** 生成引擎 `services/dynamicWorkflowRunner.ts` + runTask 三分流（scheduler.ts:497 扩展
  读 phase）：mint orchestrator 借壳 run → 解析 workflow 端口 → validateWorkflowDef + v1 约束 →
  通过则 park awaiting_review + holder run；失败重试 bounded → 耗尽 failed。测试（fake runner）：
  生成通过→park+holder（不变式）/非法 JSON 重试/校验失败重试耗尽/含 wrapper 拒绝/借壳 mint 行锁。
- **T10** 确认门 `POST confirm`（approve→swap snapshot〔resumeKick extra〕+phase=executing+resume；
  reject 带意见→phase=generating 重生）+ `save-as-workflow`。测试：approve/reject 两路 +
  swap 后快照生效 + 另存 + gate 未开 409。
- **T11** prompt 隔离锁（orchestrator prompt 无 user_id）+ 源码锁（runTask 三分流；执行阶段走
  runScope 不进生成引擎）。
- **T12** PR-2 门禁 + Codex 增量审查。

## PR-3 执行阶段 + 确认门前端

- **T13** 执行阶段验证：phase='executing' 分流走 runScope（snapshot=真 DAG）→ 跑到 done；
  daemon 重启按 phase 重建（autoResume）。测试：生成→确认→执行端到端（fake runner，DAG 顺序/
  分支）+ 重启恢复三 phase。
- **T14** 前端确认门：任务详情 phase='awaiting_confirm' → WorkflowCanvas readOnly 预览生成图 +
  确认/驳回（带意见 Dialog）+ 另存按钮；phase='executing'/done → 复用 workflow-status 画布
  （节点上色）；tab 按 phase 切。测试：只读预览渲染 / 确认 POST / 驳回带意见 / 执行画布对照锁。
- **T15** WS：生成/确认/阶段切换刷任务（复用 per-task 频道 + phase 帧或 task.status）+ 前端失效。
  测试：帧规则。
- **T16** PR-3 门禁 + i18n/CSS + 视觉自查。

## PR-4 收尾

- **T17** 全 AC-1..8 对照核验 + 失败模式测试补全（人反复驳回上限、swap/resume 竞态、执行 agent
  失败走 runScope 失败语义）。
- **T18** 全量门禁 + binary smoke + STATE.md 完工 + plan.md 索引 + Codex 实现门终审。

## 依赖 & 验收对照

| AC | PR |
| --- | --- |
| AC-1 空间资源 | PR-1 |
| AC-2 编排 agent | PR-2/T6 |
| AC-3 生成校验 | PR-2/T9 |
| AC-4 确认门 | PR-2/T10 + PR-3/T14 |
| AC-5 执行 | PR-3/T13-14 |
| AC-6 一次性+另存 | PR-2/T10 |
| AC-7 v1 约束 | PR-2/T9 |
| AC-8 门禁/复用/零回归 | 每 PR |

## 风险

- **生成质量**（最大风险）：LLM 编排的 DAG 可能连线错/prompt 差。三重防线——能力卡（RFC-166）
  确定性输入 + validateWorkflowDef 兜结构错 + 人确认门把关；驳回重生兜语义错。v1 限 agent-single
  节点链降低复杂度。
- **三阶段 park/resume 复杂度**：全复用既有原语（wg-gate / resumeKick extra / runScope），
  但「生成 park + swap + 执行 resume」是新组合——纯函数（转换/校验/phase 判定）先行落测，
  引擎壳只编排。
- **前置 RFC-166**：本 RFC 依赖能力卡 + inputs；RFC-166 未完则 orchestrator 降级只用
  description/prompt（设计以 RFC-166 已落为准，实现顺序 166→167）。
- 迁移 ×1 撞 journal/tasks 全字段锁；多人树精确路径提交。写完测试重跑 typecheck；push 查 CI。
