# RFC-113 — 运行时即执行 profile（技术设计）

配套 `proposal.md`（决策 D1–D8）。

---

## 0. 现状锚

- `runtimes`（RFC-112）：`{id,name,protocol,binary_path,builtin,last_probe_json,created_by,created_at,updated_at}`。本 RFC 加 5 列。
- runner `buildInlineAgentEntry(agent, overrides)`（runner.ts ~1620）：`model = overrides.model ?? agent.model`；`variant = overrides.variant ?? agent.variant`；`temperature = overrides.temperature ?? agent.temperature`；`steps = agent.steps`。本 RFC 改为读**运行时**。
- `AgentOverrides`（runner.ts:90）= 节点级 override（model/variant/temperature/...）。本 RFC 去其参数项。
- agent schema：`model/variant/temperature/steps/maxSteps`（106–119）+ `readonly`。本 RFC 弃用前五、留 readonly。
- 节点 override：`AgentOverrides`（来自工作流节点 config）。本 RFC 去参数项。
- config 模型/生成默认 + opencodePath/claudeCodePath：迁入内置运行时行。
- dispatch 二进制：`node_runs.runtime`(protocol)+`runtime_binary` 冻结（RFC-112）。

## 1. 数据模型

### 1.1 `runtimes` 加列（migration，手写 + statement-breakpoint〔注释勿含字面量〕）

```sql
ALTER TABLE `runtimes` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `variant` text;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `temperature` real;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `steps` integer;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `max_steps` integer;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `runtime_params_json` text;
```

均 nullable。variant/temperature/steps 仅 opencode 协议有意义（claude 行恒 NULL、UI 不显）。**name 仍唯一、binary_path 无唯一约束** → 同二进制多运行时天然支持（D4，无 schema 改动）。

### 1.2 agent 参数弃用 / 节点 override 去参数（Codex P2-2 写读契约收口）

- `agents.model/variant/temperature/steps/maxSteps`：**弃用**。**保留列**（不 DROP，避 12-step 重建风险）直到迁移稳定；schema 标 `@deprecated RFC-113`。**但「保留列」≠「保留写读契约」**（Codex P2-2）——迁移后必须全链路停读写：`CreateAgentSchema`/`AgentSchema` 去这 5 字段（新写**忽略**——`agent.ts` 服务层 create/update 不再 set 这些列）；`rowToAgent` 不再映射；markdown 导入/导出/详情不再 surface；前端 AgentForm 去字段。即「列在 DB 但对所有 API/UI/runner 不可见」——单一事实源=运行时。
- `AgentOverrides`（节点 override）：移除 `model/variant/temperature/steps`；工作流节点 config schema 去这些项。**旧定义残留**（Codex P3-2）：runner **忽略**（不读 overrides 参数）；且工作流**下次保存/导出时剥离**这些死字段（不在 YAML/JSON 里留 dead model 设置）。

### 1.3 node_runs 冻结 params（Codex P1-2）

`node_runs` 加 `runtime_params_json` text（migration，与 RFC-112 `runtime`/`runtime_binary` 同段）：dispatch 时把解析出的运行时 params（model/variant/temperature/steps/maxSteps）JSON 冻结；resume 读它（§2.1）。NULL=legacy/无（回退重解析）。

## 2. 后端解析改读运行时（D5）

### 2.1 运行时参数解析 + **冻结**（Codex 设计 gate P1-2 修订——参数随 protocol/binary 一起冻结）
- 调度派发点（RFC-112 已解析 `resolveAgentRuntime`→`{name,protocol,binary}`）：扩展返**全 profile**（含 model/variant/temperature/steps/maxSteps）。
- **冻结**：在 `node_runs` 新增 `runtime_params_json`（migration），dispatch 时把解析出的 params 一并冻结（与 `runtime`(protocol)+`runtime_binary` 同源）。**resume 读冻结 params**——避免「session 在 model X 下创建、运行时 model 改成 Y 后 retry/clarify-rerun 用 Y 续跑」的漂移（与 RFC-112 P1 的 protocol/binary 冻结+`frozenRuntimeOfSession` 继承同规则：resume/retry 携带 session 时一并继承源行 params_json）。
- 透传给 runNode：`opts.runtimeParams: { model?, variant?, temperature?, steps?, maxSteps? }`（dispatch 从冻结 params_json 取；mock 测试可省）。

### 2.2 buildInlineAgentEntry + **claude spawn** 都改读 runtimeParams（Codex P1-3 修订——claude model 路径同源）
- `buildInlineAgentEntry(agent, runtimeParams)`：`model = runtimeParams.model`；`variant`；`temperature`；`steps = runtimeParams.steps`；**`maxSteps = runtimeParams.maxSteps`**（Codex P2-3——maxSteps 也进执行映射，emit 到 inline `max_steps`，与 steps 同路；**校正：现状 buildInlineAgentEntry 漏了 maxSteps，本 RFC 一并补**）。**不再读 agent.model/overrides.model**。readonly 仍 `agent.readonly`。
- **claude 分支**（runner.ts:793 `buildClaudeSpawn({ model: opts.overrides?.model ?? opts.agent.model })`，Codex P1-3 实锤）：改 `model: opts.runtimeParams?.model`——claude 运行时的 model 同样来自运行时 profile，不再读 agent.model。两条执行路径（opencode inline / claude spawn）model 单源=runtimeParams。

## 3. 两段一次性迁移（D6 + D8）

`cli/start.ts` seed 后顺序执行（均幂等）：

### 3.1 config→内置行（`migrateConfigIntoBuiltins`）
`??=` 只填 NULL 列：opencode 行 ← `opencodePath`(binary_path)/`defaultModel`(model)/`defaultVariant`/`defaultTemperature`/`defaultSteps`/`defaultMaxSteps`；claude 行 ← `claudeCodePath`(binary_path)/`defaultClaudeModel`(model)。

### 3.2 agent 参数→去重 profile + 重指向（`migrateAgentParamsToRuntimes`）

**排除内部/内置 agent**（Codex P1-4）：`builtin=1` 的 agent（fusion 等 RFC-104 持久化内置）+ 合成内部 agent（commit&push/distiller，非持久化 agent 行、model 来自 `config.commitPushModel` 等）**不参与本迁移**——它们不走「选运行时」模型，保留各自 model 来源（commit&push 仍 opencode + commitPushModel）。仅迁移**用户 agent**（builtin=0）。

对每个用户 agent 计算**当前有效 profile**（**规范化** Codex P3-1）：
- `protocol` = `resolveRuntimeByName(agent.runtime ?? config.defaultRuntime).protocol`
- `binary` = 该运行时行的 binary_path（规范化：NULL/'' 归一为 null）
- `model/variant/temperature/steps/maxSteps` = agent 当前列值（规范化：`undefined`→`null`；`temperature` 按定点字符串序列化进 key 避 REAL 浮点等值裂分，如 `t.toFixed(4)`）
- **裸 agent（全 NULL 参数）跳过 → 采用其运行时**（实装细化 Codex P1-1 + 幂等根因）：只迁移**至少有一个非 NULL 参数**的 agent。原 P1-1 拟给 model=null 的 agent 建独立「省略 model」运行时，但实装发现这与**幂等**不可兼得——迁移清空 agent 参数后，全 NULL 的 agent 无法与「已迁移(haiku) 的 agent」区分，重跑会误重建。结论：**裸 agent（无显式参数）跳过**——它本就无 model 偏好，在「运行时决定」新模型里直接采用其运行时 profile；黄金不变式只锁**有显式参数**的 agent（它们各自得到承载其参数的运行时）。这同时让重跑天然 no-op（迁移后所有用户 agent 参数全 NULL→全跳过）。

匹配/建库（**优先当前运行时** Codex P2-1）：
1. **若 agent 当前 `runtime` 指向的行 profile 恰等于其有效 profile → 保持不动**（不 re-point，保自定义运行时身份）。
2. 否则在**全部运行时行**找 profile 相等者 → 复用其 name。
3. 仍无 → 建新运行时：name = `{protocol}-{N}`（N 从 1 起、**跳过任何已占用名**〔含用户已建的 `opencode-1`〕；确定性：候选组按规范化 profile-key 字典序排序后顺序赋号），profile = 该组。
4. agent.runtime 设为该 name + 清空 agent 的 model/variant/temperature/steps/maxSteps（避双源）。

**幂等**（Codex P2-4 含「已编辑内置」）：再跑——用户 agent 参数已空 + runtime 已指向 → 有效 profile=运行时行自身 → 命中规则①不动。注：本迁移在 §3.1（config→内置行）**之后**跑，故「内置行的 profile」已是迁移后的值；不变式以**迁移后内置行**为准（admin 后续编辑内置行不回溯改 agent 指向——agent 已固化指向某 name，运行时行参数变 = 该运行时所有 agent 一起变，符合「运行时即 profile」语义）。

**黄金不变式**：迁移前某用户 agent 经 `buildInlineAgentEntry(agent, agent当前参数)` 得到的 inline (model?, variant?, temperature?, steps?, maxSteps?)（含「model 省略」态），与迁移后经 `buildInlineAgentEntry(agent, 其运行时行参数)` 得到的**逐字一致**（NULL 态保「省略」、非 NULL 保值）。

### 3.3 seed 调整（保留值）
`seedBuiltinRuntimes` 内置行存在时只锁 `protocol`+`builtin=1`，**保留** binary_path/model/variant/temperature/steps/max_steps（admin/迁移写的值不被 hard-reset 抹）；protocol 错/builtin=0 仍纠正（RFC-112 P2 脏行防护）。

## 4. 注册表 CRUD 扩展（D8）

- `runtimes` 5 新列纳入 create/update/`runtimeRowToView`；校验（temperature 0–2、steps/maxSteps 正整数、model 非空或 null）。
- **内置守卫拆分**：`assertBuiltinIdentityImmutable`（删除/改名/改协议→内置 403）；改 binary/model/params→内置允许。
- 同二进制多运行时：createRuntime 不校验 binary 唯一（仅 name 唯一，本就如此）。
- `isDefault`：runtimeRowToView 加 `row.name === config.defaultRuntime`（路由注入 config）。

## 5. 二进制收口（同 RFC-112 P2 收尾）

- 移除 RFC-112 P2 的 `claudeCodePath` 透传链（launchRuntimeConfig→StartTaskDeps→派发→runNode）；claude head fallback 简化回 `pickRuntimeHead(runtimeBinary, runtimeCmd)`（built-in claude 二进制=内置行 binary_path→runtimeBinary）。
- `resolveOpencodeCmd` 注入保留但失效化（built-in opencode 行 binary_path 非空→runtimeBinary 胜）；mock 测试覆盖（opencodeCmd/runtimeCmd 在内置行 binary_path=NULL 时回退）不变。

## 6. 前端

### 6.1 AgentForm = 只剩运行时选择器（D2）
删除 model（ModelSelect）/variant/temperature/steps/maxSteps 字段；保留运行时 `<Select>`（RFC-112 来自 /api/runtimes）+ readonly 等代理项。`isClaude`/模型命名空间逻辑随之删（模型不在 agent 选）。

### 6.2 工作流节点抽屉去参数 override（D3）
NodeInspector / 节点编辑：移除 model/variant/temperature/steps override 控件；保留 prompt 模板/超时/重试/单多进程。节点 config schema 去参数项。

### 6.3 RuntimeFormDialog = profile 编辑（D1/D4）
加 model（`<ModelSelect>` 按协议）+ variant/temperature/steps/maxSteps（仅 opencode 协议显）。同二进制多运行时：name 不同即可（无额外约束）。内置行 name/protocol 锁、binary/profile 放开、无删除。

### 6.4 运行时页签纯表 + 行级默认（D7）
settings RuntimeTab 删 SectionForm 只留 RuntimeList；行级「设为默认」标记→`PUT /api/config {defaultRuntime}`，`isDefault` 高亮；删 defaultRuntime 下拉。

### 6.5 全局项搬迁（D7）
并发→limits 页；logLevel→appearance；commit&push→自有分区。原 key+save 复用，仅换页签。

### 6.6 agents.new 预填
去 `cfg.defaultModel/...` 预填（agent 已无参数字段）；新建只需选运行时（默认=config.defaultRuntime）。

### 6.7 i18n
runtimes profile 字段 + setDefault/isDefault 中英对称；删 agentForm 参数字段 key（或留作弃用）；搬迁字段 key 复用。

## 7. 失败模式

- **迁移行为漂移**：§3.2 黄金不变式（迁移前后 inline 参数逐字一致）+ 幂等（再跑无改动）。
- **双源（agent 参数 + 运行时参数都在）**：迁移清空 agent 参数；runner 只读运行时 → 单源。
- **seed 抹掉迁移值**：§3.3 保留。
- **同二进制多运行时命名碰撞**：name 唯一约束 + 确定性赋号跳占用名。
- **节点旧定义残留参数 override**：schema 忽略；runner 不读 overrides 参数。
- **二进制收口回归**：黄金断言（内置行 binary_path→head=[path]；NULL+测试→mock）。

## 8. 测试策略

- 数据层：5 列 CRUD+校验；同二进制多运行时（同 binary 不同 name+不同参数并存）；seed 保留；内置守卫拆分（改 binary/model OK、改 name/protocol/删 403）；runtimeRowToView 新列+isDefault；upgrade-rolling/migration 计数。
- 解析：`buildInlineAgentEntry(agent, runtimeParams)` 从 runtimeParams 取（不读 agent.model）；调度透传 runtimeParams。
- **迁移（重中之重）**：config→内置行；agent 参数→去重 profile（同参数多 agent→共享一个；不同参数→各自 profile；无 model 的 agent→内置；既有匹配 profile→复用不新建）；**黄金不变式**（迁移前后某 agent 解析出的 inline model/variant/temp/steps 逐字一致）；幂等（跑两次 DB 不变）。
- 前端：AgentForm 无参数字段（源码文本断言：AgentForm 不含 ModelSelect/temperature）；节点抽屉无参数 override；RuntimeFormDialog 含 profile 字段按协议显隐；运行时页签纯表；行级默认 PUT config；全局项在目标页签。

门禁：typecheck×3 + backend bun test + 前端 vitest + format + lint + binary smoke + Codex 设计/实现 gate。

## 9. Codex 设计 gate fold 记录

2026-06-27 第一轮（codex-cli read-only，范围限定 RFC-113、排除 RFC-111/112）。verdict=needs-rework，**10 findings 全部 fold**：

| # | 级别 | finding | 处置 |
|---|---|---|---|
| 1 | P1 | NULL model 迁移破坏黄金（agent model=null 并入 model=defaultModel 内置 → inline 从省略变显式） | §3.2：model=null 保留为独立维度，只匹配 model=null 运行时；「裸 opencode」与「内置 opencode(defaultModel)」是两个 profile。 |
| 2 | P1 | 运行时 params 不冻结、resume 重解析 → session 在 model X 创建、运行时改 Y 后 retry 漂移 | §1.3/§2.1：新增 `node_runs.runtime_params_json` 冻结；resume 读冻结、携带 session 时继承源行（同 RFC-112 P1 规则）。 |
| 3 | P1 | buildInlineAgentEntry 非唯一执行面——claude spawn 的 model 也来自 agent.model | §2.2：claude 分支 `model` 改读 `runtimeParams.model`；两执行路径 model 单源。 |
| 4 | P1 | 内部 agent（commit&push/distiller/fusion）无 profile 方案；fusion 是持久化 builtin 会被迁移扫到 | §3.2：迁移**排除 builtin=1 + 合成内部 agent**；commit&push 保 config.commitPushModel；仅迁用户 agent。 |
| 5 | P2 | dedup 可能把 agent 从其自定义运行时 re-point 走 | §3.2 规则①：agent 当前运行时 profile 匹配则**保持不动**，再全局 dedup。 |
| 6 | P2 | 弃用列仍是写读契约（API/import/export/rowToAgent 仍接收/暴露） | §1.2：留列但全链路停读写（schema 去字段、create/update 不 set、rowToAgent 不映射、import/export 不 surface）。 |
| 7 | P2 | maxSteps 在 profile key 却不在执行映射 | §2.2：maxSteps 进 buildInlineAgentEntry 执行映射（emit max_steps），补现状遗漏。 |
| 8 | P2 | 已编辑内置 + config backfill 的不变式未明 | §3.2：迁移在 config→内置行之后跑、不变式以**迁移后内置行**为准；幂等含「已编辑内置 + 老 agent」用例。 |
| 9 | P3 | profile-key 规范化（REAL 浮点等值、命名排序/tie-break） | §3.2：undefined→null 归一、temperature 定点字符串序列化、name `{protocol}-{N}` 跳占用名 + key 字典序赋号。 |
| 10 | P3 | 旧节点 override 留存为死数据 | §1.2：runner 忽略 + 工作流下次保存/导出剥离。 |

（实现 gate 各 PR 复审后续在此追加。）
