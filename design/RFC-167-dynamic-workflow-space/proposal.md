# RFC-167 动态 Workflow 空间——内置 agent 编排 DAG · 人确认 · 现有引擎执行

> 状态：Draft
> 引出：用户 2026-07-10「我还想增加一个动态 workflow 模式……创建了一个动态 workflow 的空间，
> 那所能编排的 agent 就是这个空间所选的所有 agent，每个 agent 可以使用多次。然后由于需要调用
> 多 agent，所以内置 agent 要具备理解现有 agent 能力并给这个 agent 注入用户提示词并校验输出
> envelop 的能力……由内置 agent 根据已有 agent 进行工作流编排，然后给人去确认或者不确认 workflow，
> 然后顺序执行该 workflow」。
> 经两路调研（workflow 生成/校验 · DAG 执行引擎/确认门）+ 两轮反问对齐后落档。
> **前置依赖 RFC-166「agent 能力层」**（能力卡 + 声明式 inputs）。

## 背景

RFC-164 工作组给了两种运行时协作形态——leader-worker（leader 逐轮派活）、free_collab（无
leader 共享清单），都是**回合制、聊天室主视图**。它们适合「流程要在运行时才决定」的场景，但
有两个局限：① 全过程 AI 自主，人只能中途插话，无法「先审整个计划再执行」；② 没有确定性的
可复现执行图。

**动态 workflow 空间**补上第三种形态：**AI 编排 + 人确认 + 确定性执行**。
- 无 leader。一个**内置编排 agent**读懂空间里 agent 池的能力（RFC-166 能力卡），根据人给的目标
  编排出一个**真 workflow DAG**（每个节点选池里一个 agent + 注入 prompt + 声明输出 envelope +
  连线，每个 agent 可用多次）。
- 人看生成的图**整体确认或驳回重生**（决策：只看结果图、可带意见驳回）。
- 确认后走**现有确定性 DAG 引擎**（`runScope`）执行——所以动态 workflow 任务详情**渲染真
  workflow 画布**（节点状态上色，和普通工作流任务一样），不是聊天室。

调研（design/RFC-167 附研究）证实这几乎全是「拼装现有积木」：workflow 数据模型 + validator +
只读画布 + 一次性 snapshot（工作组先例）+ 内置 agent（buildMergeAgent 先例）+ 两阶段 park/resume
（clarify/review/wg-gate 先例）+ 运行中 snapshot swap（resumeKick extra）全部现成。

## 目标

1. **动态 workflow = 工作组第三种执行模式**（决策修订 2026-07-11，用户「工作组有三种执行模式：
   leader 模式、自由模式、动态工作流模式」）：工作组 `mode` 枚举加 `dynamic_workflow`，与
   `leader_worker` / `free_collab` 并列。**不新增资源**——复用 RFC-164 工作组资源/成员/ACL/启动
   基建。该模式下：**agent 成员即可编排的 agent 池**（每个可在生成的 workflow 里出现多次；human
   成员 / leader / 三开关 / maxRounds 等在此模式不适用，按 mode 条件收敛，同 free_collab 已有先例）。
   〔**原 v1 稿曾拍「独立 `dynamic_workflow_spaces` 资源、第七类 ACL」——已被本决策推翻并回退。**〕
2. **内置编排 agent**（`buildOrchestratorAgent`，照 buildMergeAgent 先例，不入 agents 表）：
   - 输入：**工作组章程（instructions，固定背景）+ 启动时填的本次目标**拼接（决策修订：两者结合）
     + 工作组 agent 成员的能力卡（RFC-166 `renderRosterCapabilityCards`）。
   - 产出：一个 `WorkflowDefinition` JSON（`agent-single` 节点链 + 连线，可分支/并行；
     **v1 不允许 wrapper（loop/fanout/git）和 review 节点**——纯约束的 agent 节点链，决策）。
   - 每个节点：从池选 `agentName` + 生成 `promptTemplate`（给那个 agent 注入的用户提示词）+
     声明该节点消费的输入端口 / 依赖上游哪个节点的哪个输出。
3. **生成→确认→执行三阶段**（决策：整体确认/驳回重生）：
   - 生成：任务启动后跑编排 agent（宿主快照里一个内置节点），输出 workflow JSON →
     `validateWorkflowDef` 校验（引用 agent 存在/无环/端口连通/prompt token 解析——生成质量的
     天然守门员）。
   - 确认门：任务泊 `awaiting_review`（复用 RFC-164 wg-gate 手法：mint awaiting_review holder
     run）；人在任务详情看**只读画布预览**（复用 `WorkflowCanvas readOnly`）；整体**确认**→执行，
     或**驳回**（可带意见）→ 编排 agent 带意见重新生成（park/resume 回合）。
   - 执行：确认后把生成的 DAG **swap 进 `task.workflow_snapshot`**（resumeKick extra），
     resume → 走 `runScope` 确定性执行到 done。
4. **生成物一次性 + 可选另存**（决策）：生成的 workflow 默认只活在 `task.workflow_snapshot`
   （工作组「共享 builtin 锚点 + per-task 合成快照」先例，不污染 workflow 列表）；人确认后可选
   「另存为 workflow 资源」按钮沉淀到 `workflows` 表复用。

## 非目标（v1）

- **v1 生成的 workflow 不含 wrapper（loop/fanout/git）和 review 节点**：纯 agent-single 节点链
  （可分支/并行）。降低生成复杂度与校验/执行风险；wrapper/review 生成留后续。
- **不做编辑后确认**（决策：整体确认/驳回重生）：人只读预览，不在确认前改图；要改则驳回重生。
  「进编辑器微调」留后续。
- **不做生成过程流式**（决策：只看结果图）：编排 agent 生成是一次内置 run，人只看最终图。
- **不做 agent 输入端口强校验编排**：编排靠 RFC-166 能力卡（inputs/outputs kind）确定性匹配
  + description/prompt 语义推断 + `validateWorkflowDef` 兜底 + 人确认，不要求池内 agent 都声明
  inputs。
- ~~**不改工作组**：动态 workflow 是独立资源，不是工作组 mode。~~ **（2026-07-11 推翻）** 改为
  工作组第三种模式 `dynamic_workflow`；工作组三种形态 = leader_worker / free_collab /
  dynamic_workflow。复用工作组成员作 agent 池、复用工作组启动/ACL/资源基建。
- **不做多轮生成对话**：驳回重生是「带意见重跑编排 agent」，不是聊天式往返。

## 用户故事

1. 我建「支付重构空间」，选 agent 池：`analyzer`(分析现状)、`coder`(改代码)、`test-writer`
   (补测试)、`auditor`(审计)。
2. 我点「启动」，选 repo，给目标：「把支付回调改成幂等，补齐测试，最后审计」。任务创建，
   编排 agent 跑起来——它读 4 个 agent 的能力卡，编排出：analyzer → coder → test-writer → auditor
   的节点链（每节点带它生成的 prompt + 连线）。
3. 任务泊在确认门。我在任务详情看到**生成的 workflow 图**（只读画布，4 个节点连成链），
   检查每个节点选的 agent 和 prompt 合理。我点「确认执行」。
4. 任务 resume，走 DAG 引擎顺序执行 analyzer→coder→test-writer→auditor，画布节点依次上色到
   done。产出 = git diff。
5. 若我看图觉得不对（比如漏了 test-writer），点「驳回」写「测试环节漏了」→ 编排 agent 带这条
   意见重新生成 → 我再确认。
6. 满意后我点「另存为 workflow」把这个图沉淀成可复用工作流。

## 验收标准

- AC-1 空间资源：`dynamic_workflow_spaces` CRUD + ACL（第七类，未授权 404/过滤同形）；agent 池
  配置（选一组 agent，可空保存、启动时校验非空）。
- AC-2 内置编排 agent：`buildOrchestratorAgent`（不入 agents 表，走内部运行时）；注入目标 +
  能力卡；输出经 zod 解析为 `WorkflowDefinition`。
- AC-3 生成→校验：编排 agent 产出的 def 经 `validateWorkflowDef`（引用/环/端口/prompt-token）；
  校验失败 → 编排 agent 带错误重试（bounded）→ 仍失败任务 failed + 错误呈现。
- AC-4 确认门：生成后泊 `awaiting_review`（holder run 满足生命周期不变式）；只读画布预览；
  确认→执行 / 驳回（带意见）→ 重生（park/resume 回合）。
- AC-5 执行：确认后 swap snapshot 走 `runScope`；任务详情渲染真 workflow 画布（节点状态上色）；
  跑到 done；产出 = git diff。
- AC-6 一次性 + 另存：默认只活 `workflow_snapshot`（不落 workflows 列表）；确认后可「另存为
  workflow 资源」。
- AC-7 v1 约束：生成的 def 只含 agent-single 节点（含 wrapper/review 则校验/生成阶段拒绝或
  重试收敛）；每 agent 可多次（同 agentName 多节点）。
- AC-8 门禁 + Codex 设计/实现门 + 前端复用公共组件（WorkflowCanvas readOnly / Dialog / ...）+
  零回归（工作组 / 普通 workflow / DAG 引擎全绿）。

## 决策记录（2026-07-10，两轮）

| # | 问题 | 拍板 |
| --- | --- | --- |
| 1 | 空间定位 | 独立「动态 workflow 空间」资源（非工作组 mode） |
| 2 | 生成物去向 | 一次性 snapshot，可选另存为 workflow 资源 |
| 3 | 确认门粒度 | 整体确认 / 驳回重生（不在确认前编辑） |
| 4 | 输入 gap | （见 RFC-166）给 agent 增补声明式输入端口；编排靠能力卡 + 语义 + 校验 + 人确认 |
| 5 | 能力卡粒度 | 完整卡（含 system prompt 摘要）——RFC-166 |
| 6 | 生成观测 | 只看结果图 + 可驳回重生（生成过程不流式） |
| 7 | 存量迁移 | inputs 可选（RFC-166） |
| 8 | 生成形态 | 目标文本 → 约束的 agent 节点链（v1 无 wrapper/review） |
| 9 | RFC 拆分 | 能力层（RFC-166）+ 动态 workflow（本 RFC）两个 RFC；本 RFC 依赖 RFC-166 |
