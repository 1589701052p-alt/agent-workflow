# RFC-167 design——动态 Workflow 空间技术设计

> 配套 proposal.md（拍板 9 条）。前置 RFC-166。所有对现有代码的断言经调研核实，
> file:line 基于 2026-07-10 工作树。

## 0. 总览与关键抉择

三阶段任务：**生成 →（park 确认门）→ 执行**。几乎全复用既有机制。

| 抉择 | 方案 | 依据（file:line） |
| --- | --- | --- |
| 生成的 DAG 满足 tasks.workflow_id/snapshot NOT NULL | builtin 宿主锚点 + per-task 合成快照（工作组同款） | workgroupLaunch.ts:112 `ensureWorkgroupHostWorkflow`；task.ts:1096 snapshot 注入点 |
| 执行走哪个引擎 | 确认后 swap 真 DAG 进 snapshot，走 `runScope`（**不走** workgroup 回合引擎） | scheduler.ts:497-510 分流点（读列布尔）；runScope 918 |
| 生成阶段怎么跑编排 agent | 宿主快照含一个内置 orchestrator 节点，跑一次输出 workflow JSON | buildMergeAgent 先例 mergeAgent.ts:35；内部运行时 runtimeRegistry.ts:272 |
| 确认门 | 生成后 mint awaiting_review holder run + 任务泊 awaiting_review（wg-gate 手法） | workgroupRunner.ts:658 openCompletionGate；review.ts park/resume |
| snapshot 运行中改写 | `resumeKick` + `extra.workflowSnapshot`（lifecycle 白名单放行） | task.ts:1522 resumeKick；lifecycle.ts:225-226 extra 白名单；syncTaskWorkflow 1792 范例 |
| 生成质量守门 | `validateWorkflowDef(def, ctx)` | workflow.validator.ts:89 ~55 错误码 |
| 只读预览 | `WorkflowCanvas readOnly` | WorkflowCanvas.tsx:130 |

**核心抉择：动态 workflow 任务用什么驱动？** 生成阶段需要跑编排 agent（一个 run），执行阶段
走真 DAG。两阶段用**同一个任务**、两次 park/resume + 一次 snapshot swap 串起来：

```
launch → 宿主快照(orchestrator 节点) → orchestrator run 产出 def
       → validateWorkflowDef → 生成 holder park awaiting_review
   人确认 → swap task.workflow_snapshot = 生成的 def → resume
       → runScope 执行真 DAG → done
   人驳回(带意见) → orchestrator 带意见重跑 → 再 park
```

分流：动态 workflow 任务**不进** workgroup 引擎。它用一个新的轻量分流（`task.dwspace_id` 非空
且未进入执行阶段 → 生成引擎；进入执行阶段 → snapshot 已是真 DAG，走 runScope）。见 §3。

## 1. 数据模型

### 1.1 `dynamic_workflow_spaces`（第七类 ACL 资源）

```sql
CREATE TABLE dynamic_workflow_spaces (
  id TEXT PRIMARY KEY,            -- ULID
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  agent_pool_json TEXT NOT NULL DEFAULT '[]',   -- string[] agent 名（可编排池；每个可多次）
  owner_user_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- ACL：`resource_grants.resourceType` 枚举加 `'dynamic_workflow_space'`（第七类，
  `services/resourceAcl.ts` 注册；list 过滤 / detail 404 同形）。
- `agent_pool_json`：agent 名软引用（同 workflow 节点 agentName）；保存时校验新增引用可用
  （`services/resourceRefs.ts`）；启动时校验非空 + 均存在启用。
- 可空保存（快速创建同 RFC-164 决策 #21 风味），启动时才要求池非空。

### 1.2 `tasks` 增列（migration）

```sql
ALTER TABLE tasks ADD COLUMN dwspace_id TEXT;              -- NULL=非动态workflow任务
ALTER TABLE tasks ADD COLUMN dwspace_config_json TEXT;     -- 启动快照 + 阶段/生成态
CREATE INDEX idx_tasks_dwspace ON tasks(dwspace_id);
```

`dwspace_config_json` = `{ spaceId, spaceName, goal, agentPool:[{name, ...能力卡快照}],
phase: 'generating'|'awaiting_confirm'|'executing'|'rejected', generatedDef?: <workflow def>,
rejectionComment?, generateAttempts }`。任务运行读它（不回读空间表；空间后续改只影响新任务）。

### 1.3 宿主锚点 workflow（builtin，懒建）

固定 builtin 行 `__dynamic_workflow_host__`（照 `WORKGROUP_HOST_WORKFLOW_ID` 懒建
`onConflictDoNothing`，workgroupLaunch.ts:112）——满足 `tasks.workflow_id` FK。

生成阶段快照（合成）：
```jsonc
{ "$schema_version": 4, "inputs": [], "nodes": [
    { "id": "__dw_orchestrator__", "kind": "agent-single", "agentName": "<orchestrator 占位>" }
  ], "edges": [] }
```
执行阶段快照 = 编排 agent 生成的真 DAG（确认后 swap 进来）。

## 2. 内置编排 agent（`buildOrchestratorAgent`）

`services/orchestratorAgent.ts`（新，照 `buildMergeAgent` mergeAgent.ts:35）：
- 不入 agents 表；`name = 'aw-workflow-orchestrator'`；inline `bodyMd`（编排协议）；
  声明单输出端口 `workflow`（承载 workflow JSON）；无 model（`resolveInternalAgentRuntime`
  runtimeRegistry.ts:272 解析）。
- 注入 prompt（生成阶段 `renderUserPrompt` 组装）：
  1. 目标文本（`dwspace_config.goal`）;
  2. **agent 池能力卡**（RFC-166 `renderRosterCapabilityCards(池内 agents)`）——每个 agent 的
     description/inputs/outputs（带 kind）/role/prompt 摘要;
  3. 编排协议块：v1 约束——只用 `agent-single` 节点（禁 wrapper/review）、每个 agent 可多次、
     节点间连线用 `{source:{nodeId,portName}, target:{nodeId,portName}}`、每节点生成
     `promptTemplate`（可用 `{{上游端口名}}` 引上游产出）、声明每节点消费的输入。
  4. 驳回重生时追加 `rejectionComment`（高优）。
- 输出端口 `workflow`：JSON 文本 → `WorkflowDefinitionSchema.safeParse` → `validateWorkflowDef`
  （§4）。协议块用 §5 的 envelope（照工作组 `parseWg*Port` workgroupRuntime.ts:235-277 的
  「JSON 端口 → zod」范式）。

## 3. 引擎分流与三阶段驱动（`services/dynamicWorkflowRunner.ts`）

`runTask`（scheduler.ts:497）分流扩展：
```
if (task.workgroupId !== null) → runWorkgroupEngine
else if (task.dwspaceId !== null && phase !== 'executing') → runDynamicWorkflowGenerate
else → runScope   // 普通 workflow + 动态 workflow 执行阶段（snapshot 已是真 DAG）
```
读 `dwspace_config_json.phase`（task 行已加载）判断阶段。

### 3.1 生成阶段 `runDynamicWorkflowGenerate`

- mint orchestrator run（`__dw_orchestrator__` 节点，借壳 `agentOverrideName` = orchestrator
  内置 agent，照工作组借壳 mint）；`runNode` 跑它（iso worktree 可选——生成不写 repo，可
  passthrough）。
- 解析 `workflow` 端口 → `WorkflowDefinitionSchema` → `validateWorkflowDef(def, {agents 池,...})`
  + v1 约束校验（只含 agent-single、agentName ∈ 池）。
- 校验失败 → 带错误列表重试（bounded，`generateAttempts < N`）；耗尽 → 任务 failed + 错误呈现。
- 校验通过 → 写 `dwspace_config.generatedDef` + `phase='awaiting_confirm'` → mint awaiting_review
  holder run（wg-gate 手法，workgroupRunner.ts:658）→ 引擎返回 `{kind:'awaiting_review'}` →
  runTask 泊任务 awaiting_review（scheduler.ts:526）。

### 3.2 确认门（REST）

`POST /api/dynamic-workflow-tasks/:taskId/confirm` body `{decision:'approve'|'reject', comment?}`
（任务成员制门禁，同工作组 confirm workgroupTasks.ts:411）：
- approve：关 holder run（awaiting_review→done）；**swap** `task.workflow_snapshot = generatedDef`
  + `phase='executing'`（经 `resumeKick` extra.workflowSnapshot，task.ts:1522 / lifecycle 白名单
  225-226）；resume → runScope 执行真 DAG。
- reject（必带 comment）：写 `rejectionComment` + `phase='generating'` + `generatedDef=null` →
  resume → 生成阶段带意见重跑 orchestrator。
- 另存：`POST .../save-as-workflow` → `createWorkflow(db, {name, definition: generatedDef}, {owner})`
  （workflow.ts:36）落 workflows 表复用。

### 3.3 执行阶段

snapshot 已是真 DAG，`task.dwspaceId` 非空但 `phase='executing'` → 分流走 runScope（§3）。
runScope 从新快照重算 frontier（resumeKick 重 kick runTask 重解析快照，scheduler.ts:365）→
DAG 确定性执行到 done。任务详情渲染真 workflow 画布（节点状态上色，tasks.detail 现成机制）。

## 4. 生成校验（守门）

`validateWorkflowDef(def, {agents: 池内 agents, skills, plugins})`（workflow.validator.ts:89）——
调研确认能兜住：agent-not-found（引用池外 agent）、topology-cycle、edge-*-port-missing（端口
不通）、prompt-template-unresolved（`{{token}}` 无对应入边）等 ~55 码。**v1 额外约束**（本 RFC
新增小校验，在 validateWorkflowDef 之上）：
- 所有节点 `kind === 'agent-single'`（含 wrapper/review/clarify → 拒绝，触发重试）。
- 所有 `agentName ∈ agent 池`。
- 至少一个节点、DAG 连通（validateWorkflowDef 的 topology 已覆盖环，补「孤儿节点」提示）。

校验失败的错误列表注入 orchestrator 重试 prompt（照工作组 malformed 重试）。

## 5. envelope 协议（orchestrator 专用端口）

orchestrator 输出端口 `workflow`（JSON），zod 载荷（shared `dynamicWorkflow.ts`）：
```
DwGeneratedWorkflowSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(), agentName: z.string(),
    promptTemplate: z.string(),
    // 声明该节点消费的输入（对齐 RFC-166 agent inputs / 上游端口）
    inputs: z.array(z.object({ port: z.string(), from: z.object({nodeId,portName}) })).default([]),
  })),
  edges: z.array(z.object({ source: PortRefSchema, target: PortRefSchema })).default([]),
})
```
解析后**转换**为标准 `WorkflowDefinition`（nodes→agent-single、inputs→edges、补 input/output
IO 节点）再喂 validateWorkflowDef。转换纯函数 `dwGeneratedToWorkflowDef`（可单测）。

## 6. 前端

### 6.1 空间资源页 `/dynamic-workflow-spaces`（照 RFC-164 workgroups 骨架）

列表 + 快速创建弹窗（名称+描述）+ 详情（agent 池编辑——复用 RFC-166 `AgentCapabilityCard`
预览候选能力 + 池成员管理卡片，照 RFC-164 WorkgroupMemberCards）。启动页（goal 多行 + repo
source picker 复用）。

### 6.2 任务详情：确认门 + 执行画布

- `phase='awaiting_confirm'`：任务详情主视图 = **生成的 workflow 只读预览**（`WorkflowCanvas
  definition={generatedDef} readOnly`，WorkflowCanvas.tsx:130）+ 确认门操作卡（确认/驳回带意见
  Dialog）+「另存为 workflow」按钮。
- `phase='executing'/done`：走普通 workflow 任务详情（`workflow-status` 画布节点上色，
  tasks.detail.tsx 现成——动态 workflow 执行任务 `workgroupId=null`、有真 snapshot，天然复用）。
- tab 接线：动态 workflow 任务默认 tab 按 phase 切（awaiting_confirm→确认预览；executing→
  workflow-status 画布）。
- WS：生成/确认/阶段切换经既有 per-task 频道（node.status + 新 dw.phase 帧或复用 task.status）。

## 7. ACL 与 prompt 隔离

- 第七类资源 `dynamic_workflow_space`；启动校验空间可用（引用闭包隐式授权，RFC-099 D3）；
  保存校验新增 agent 池引用。
- 任务成员制私有（同工作组/普通任务）。
- **prompt 隔离**：orchestrator prompt 含目标 + 能力卡（RFC-166，无 user_id）；生成的 workflow
  节点 prompt 由 orchestrator 产出，不含用户身份。沿 RFC-099 不变式。

## 8. 失败模式

| 失败 | 处理 |
| --- | --- |
| orchestrator 输出非法 JSON / schema | malformed 重试（注错误）；耗尽 → 任务 failed + 错误呈现 |
| 生成的 def validateWorkflowDef 失败 | 错误列表注入重试；耗尽 failed |
| 生成含 wrapper/review（v1 禁） | v1 约束校验拒绝 → 重试提示「只用 agent-single」 |
| 人一直驳回 | 每次驳回重跑；generateAttempts 上限 → 任务 failed（文档化） |
| daemon 重启 | 状态全落 dwspace_config_json + node_runs；autoResume 按 phase 重建（生成中/待确认/执行中） |
| 执行阶段某 agent 节点失败 | 走 runScope 既有失败语义（frontier firstFailure → 任务 failed） |
| swap snapshot 与 resume 竞态 | resumeKick CAS（task.ts:1551 isTaskActive + 状态 CAS），单驱动者胜 |

## 9. 测试策略

- shared：`DwGeneratedWorkflowSchema` 解析 + `dwGeneratedToWorkflowDef` 转换（节点→agent-single、
  inputs→edges、IO 节点补全）；空间/池 zod。
- backend：
  - 空间 CRUD + ACL（第七类，404 同形、池引用校验）；
  - 生成引擎（fake runner 桩）：orchestrator 产出 → validateWorkflowDef 通过 → park
    awaiting_review + holder run（不变式）；产出非法 → 重试 → 耗尽 failed；含 wrapper → 拒绝重试；
  - 确认门：approve → swap snapshot + phase=executing + resume；reject → 带意见重生；
  - 执行阶段分流：phase='executing' 走 runScope（不进生成引擎）——源码锁 + 行为锁；
  - swap snapshot 后 runScope 用新快照（resumeKick extra 行为锁）；
  - 另存为 workflow；
  - migration（journal +1、tasks 全字段 +2、dwspace 建表、resource_grants 枚举）；
  - prompt 隔离（orchestrator prompt 无 user_id）。
- frontend：空间资源页（列表/快速创建/池管理+能力预览）；确认门只读画布预览 + 确认/驳回；
  执行阶段复用 workflow-status 画布对照锁；启动页 body builder（goal 字段断言，防丢）。
- 源码锁：runTask 三分流（workgroup / dw-generate / runScope）断言；动态 workflow 执行任务
  不进 workgroup 引擎。

## 10. 依赖与顺序

- **前置 RFC-166**（能力卡 + 声明式 inputs）：orchestrator 注入能力卡、生成时按 inputs/outputs
  kind 匹配。RFC-166 未落则 orchestrator 只能靠 description+prompt 语义（可作为降级，但设计以
  RFC-166 已落为准）。
- 复用：workflow 数据模型/validator/画布、工作组 builtin 锚点+合成快照+借壳 mint+wg-gate 确认门
  手法、resumeKick snapshot swap、内置 agent（buildMergeAgent 范式）、DAG 执行引擎 runScope。
- 迁移 ×1（dwspace 表 + tasks 两列 + builtin 锚点懒建不入迁移，同 RFC-164）。
