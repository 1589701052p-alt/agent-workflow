# RFC-115 — 节点执行策略全局化 + RFC-113 死资产彻底清理 + Agent 运行时列

> 状态：Draft
> 触发：2026-06-27 用户「工作流编排时不开放节点的重试次数 / 超时时间覆盖了，全都全局配置」+「agent 列表增加一列显示本 agent 使用的是哪个运行时」+「清理这些能力时要清理彻底，死代码、死数据库列也同步清理」。

## 1. 背景与动机

RFC-111/112/113 把「运行时」演进为完整执行 profile：代理只**选**运行时（不带参数），生成参数（model / variant / temperature / steps / maxSteps）收归运行时行，节点不再覆盖生成参数。这一线收敛留下了**两条尾巴**：

1. **节点仍能覆盖「执行策略」**。RFC-113 删节点 model 类覆盖时，**有意保留**了节点级 `retries`（重试次数）/ `timeoutMs`（超时）——理由是「它们是节点执行策略、不是运行时参数」（见 `NodeInspector.tsx:1239-1242` 注释）。用户现在判定：这两项也不该按节点散配，应与运行时参数一样统一收归**全局**。

2. **RFC-113 的「弃用契约收口」（plan T6）实际没落地**。审计确认：执行层迁移已彻底完成（runner 一律从运行时 profile 取参数，**无任何执行路径再读 agent 的参数列**），但 **agent 参数 DB 列、shared schema、markdown 导入、节点 override 提取链、6 个 config 字段** 仍原样保留，成为**死代码 + 死数据库列**。它们能 typecheck、能跑，但永远不被消费——是纯负债，且持续误导读代码的人以为「agent / 节点还能带参数」。

3. **Agent 列表看不到运行时**。RFC-113 让代理只选运行时，但 `/agents` 列表页没有任何一列展示「这个 agent 跑在哪个运行时」，用户无法一眼核对归属。

本 RFC 一次性收完这三条尾巴：**把节点执行策略（retries/timeout）全局化**、**彻底清除 RFC-113 遗留的所有死资产（死代码 + 死 DB 列 + 死 config 字段）**、**给 agent 列表补一列运行时**。

## 2. 目标 / 非目标

### 目标

- **G1 节点执行策略全局化**：工作流编辑器去掉节点级「重试次数 / 超时」两个覆盖控件；调度统一用全局值。
  - 超时：复用既有全局项 `config.defaultPerNodeTimeoutMs`（30min，Settings 已有输入框）。
  - 重试：**新增全局可配项** `config.defaultNodeRetries`（默认 3，行为不变），Settings 页可调，与超时对称。
- **G2 彻底清理 RFC-113 死资产**（用户「清理彻底」要求）：
  - 死代码：节点 override 提取链（`pickOverrides` / `AgentOverrides` / runner overrides 字段）、一次性迁移函数 `migrateAgentParamsToRuntimes`、agent 参数读写（create/update/rowToAgent/markdown/schema）。
  - 死 DB 列：`agents` 表 `model/variant/temperature/steps/max_steps` 5 列；`node_runs.agent_snapshot`（从未被填充、写恒 NULL）。
  - 死 config 字段：`defaultModel / defaultVariant / defaultTemperature / defaultSteps / defaultMaxSteps / defaultClaudeModel`（6 个，已被运行时 profile 取代）。
  - 死 i18n key：随上述删除而无引用的中英文案（17 个）。
- **G3 Agent 列表运行时列**：`/agents` 列表新增「运行时」列，显示 `agent.runtime`；未显式指定的 agent 显示「<全局默认运行时名>（默认）」标记。

### 非目标

- **不**改运行时 profile 机制本身（`runtimes` 表的 model 类列、`node_runs.runtime_params_json`、driver / 冻结 / 注入全是 RFC-111/112/113 的**活**资产，原样保留）。
- **不**改 `readonly` 归属（仍是 agent 级、节点不可覆盖——RFC-113 不变）。
- **不**动 `config.defaultRuntime / opencodePath / claudeCodePath / claudeCodeEnabled`（运行时相关**活**字段，最易被「彻底清理」误删）。
- **不**改 commit&push / distiller / fusion 等内部 agent 的模型配置。
- **不**触碰 MCP 的 `timeoutMs`（`mcps.fieldTimeoutMs`，与节点 timeout 同名但语义无关）。
- **不**引入节点级重试/超时的任何替代覆盖入口——这是「收归全局」，不是「换个地方配」。

## 3. 用户故事

- **作为工作流作者**，我在画布上选中一个 agent 节点时，抽屉里只剩「代理 / prompt 模板」等真正属于节点的配置；不再看到「重试次数 / 超时」这种本应全局统一的旋钮，也不会因为忘了在某个节点上调它而踩到不一致。
- **作为平台管理员**，我在 Settings 的执行限制页里能同时看到「默认节点超时」和「默认节点重试次数」两个全局旋钮，一处改动对所有任务的所有节点生效。
- **作为读代码 / 接手的人**，我 grep `agents.model` 不再撞见一堆「写了但永不消费」的死代码，DB schema 里也不再有 5 个恒 NULL 的迷惑列——「agent 不带生成参数」这个事实在代码与库结构上都成立。
- **作为运维 / 配置者**，我在 `/agents` 列表一眼就能看到每个 agent 跑在哪个运行时（`opencode-opus` / `claude-sonnet` / …），没显式选的显示「默认（opencode）」，不必逐个点进详情核对。

## 4. 验收标准

- **AC1**：工作流编辑器 agent 节点抽屉不再出现「重试次数 / 超时」控件；既有工作流定义里残留的 `node.retries` / `node.timeoutMs` 被忽略（不再影响调度），并在下次保存 / 导出时不再写回。
- **AC2**：新增全局 `config.defaultNodeRetries`（默认 3）；Settings 执行限制页可读写；调度对未显式覆盖的节点使用该全局值；缺该字段的旧 config 自动 backfill 为 3。行为对齐 RFC-042（默认 3 次重试）不回归。
- **AC3**：`agents` 表 5 个参数列、`node_runs.agent_snapshot`、6 个 config 字段、override 死链、`migrateAgentParamsToRuntimes`、相关 i18n key 全部删除；`bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 build smoke 通过（migration 嵌入、无模块环）。
- **AC4**：`/agents` 列表出现「运行时」列；显式指定运行时的 agent 显示其运行时名（无标记），未指定的显示默认运行时名 + 「默认」标记。复用公共 `StatusChip`，中英 i18n 对称。
- **AC5**：DROP 列用本仓既定 12 步表重建模板（0041 先例），migration 配套列名快照 / 列计数测试守卫，确保不误删 / 不漏列；`runtimes` 活列与 `node_runs.runtime_params_json` 不受影响。
- **AC6**：每项改动带测试（新功能正向 + 死资产删除的回归锁，如「`NodeInspector` 不再含 retries/timeout 控件」「agent SELECT 不含 5 列」「config round-trip 含 defaultNodeRetries」）。

## 5. 与现有功能的关系

- **延续 RFC-111/112/113**：本 RFC 是「运行时即执行 profile」收敛的**收尾**——把 RFC-113 有意留尾的执行策略（retries/timeout）和未落地的契约收口（T6）一次性做完。
- **复用 RFC-108 接线**：`defaultNodeRetries` 完全照 `defaultPerNodeTimeoutMs` 的 `resolveLaunchRuntimeConfig` → `StartTaskDeps` → scheduler 展开式注入模板，零新机制。
- **复用 RFC-074/0041 迁移模板**：agents / node_runs 列 DROP 用 0041 确立的 12 步重建法（pre-prod hard-cut）。
- **复用 RFC-112 运行时数据**：运行时列直接用 `['runtimes']` 查询的 `isDefault` 标记，无新 API。
