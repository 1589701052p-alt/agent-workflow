# RFC-115 任务分解 — 节点执行策略全局化 + 死资产清理 + Agent 运行时列

> 5 PR。PR-A/B 独立小、立即见效；PR-C 大原子（含 migration 0057）；PR-D config 死字段；PR-E 最高风险（node_runs 重建，可回退）。每个子任务带测试（见 design §6）。
> 全程 main 分支直推（feedback_main_branch_only）；push 前 `bun run typecheck && bun run test && bun run format:check` 全绿，push 后查 CI（feedback_post_commit_ci_check）。

## PR-A — G1 节点执行策略全局化 + override 死链清理（无 migration）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T1** | `config.ts`：新增 `defaultNodeRetries: z.number().int().nonnegative()`（紧跟 defaultPerNodeTimeoutMs:77）+ `DEFAULT_CONFIG` 加 `defaultNodeRetries: 3`（:322 后）。 | — |
| **T2** | `launchRuntimeConfig.ts`：返回类型 + `out` + try 块加 `defaultNodeRetries`（仿 timeout，不加 `>0` 守卫）。 | T1 |
| **T3** | scheduler opts 类型(:167) 加 `defaultNodeRetries?`；`:1721` 改 `opts.defaultNodeRetries ?? 3`（删 `pickNumber(node,'retries')`）；`:1714/3686/3956` 删 `pickNumber(...,'timeoutMs')` 直用 `opts.defaultPerNodeTimeoutMs`。 | T2 |
| **T4** | StartTaskDeps 透传：`task.ts` 类型(:124)+3 kick(:946/:1371/:1959)；`fusion.ts` 类型(:70)+2 kick(:463/:851)；`routes/fusions.ts:50,55` 显式解构下传。 | T3 |
| **T5** | override 死链整删：`scheduler.ts` `pickOverrides`(:4727-4738)+nodeOverrides(:1722/3687/3957)+透传(:2423/3731/3998)+import(:115)；`runner.ts` `AgentOverrides`(:100-104)+`RunNodeOptions.overrides`(:121)+log 字段(:872)。 | — |
| **T6** | 前端：`NodeInspector.tsx` 删 :1198-1199 变量 + :1239-1255 控件 + :6 注释；`settings.tsx` LimitsTab 加 `defaultNodeRetries` 输入(:166 数组 + 仿 :207-214)。 | T1 |
| **T7** | i18n：新增 `settingsForm.nodeRetries`(+Hint)；删 `inspector.fieldRetries/fieldRetriesHint/fieldTimeoutMs/fieldTimeoutMsHint`（**勿删 mcps.fieldTimeoutMs**）。中英对称。 | T6 |
| **T8** | 测试：`config.test.ts` defaultNodeRetries round-trip/默认 3/backfill；scheduler「node retries/timeout 被忽略、取全局」；`scheduler-node-overrides.test.ts` 简化为纯忽略；翻转 `node-inspector.test.tsx:309` 为控件消失 + 源码文本兜底；settings 含输入。 | T1–T7 |

**验收**：节点抽屉无 retries/timeout 控件；全局 `defaultNodeRetries`(默认3) 可配且生效；override 死链清空；行为对齐 RFC-042 不回归。

## PR-B — G3 Agent 列表运行时列（纯前端）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T9** | `agents.tsx`：新增 `['runtimes']` 查询（复用 `RUNTIMES_QUERY_KEY` from RuntimeList.tsx:28）取 `isDefault?.name`；表头 colReadonly(:64) 后插 `<th>colRuntime</th>`；行内插 `<td>`：`a.runtime ?? defaultName` + 未指定时 `StatusChip kind="neutral" size="sm"`「默认」。import StatusChip。 | — |
| **T10** | i18n：`agents.colRuntime`(en Runtime/zh 运行时)+`agents.runtimeDefaultTag`(en default/zh 默认)。对称。 | T9 |
| **T11** | 测试：`agents.tsx` 集成 `findByRole('columnheader',{name:/运行时|Runtime/})`；指定运行时行显名无 chip；未指定行显默认名 + 「默认」chip。 | T9–T10 |

**验收**：`/agents` 列表显示每 agent 运行时；未指定显默认名 + 标记；复用公共 StatusChip。
**勿动**：`inventory/AgentsTable.tsx`（读 InventoryAgent.modelId，语义正确）。

## PR-C — G2 agent 参数契约收口 + DROP `agents` 5 列（migration 0057，大原子）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T12** | shared：`agent.ts` `AgentSchema`(106/115/116/118/119)+`CreateAgentSchema`(173/177/178/180/181) 删 5 字段（UpdateAgent 自动）；`agent-md.ts` `KNOWN_KEYS`(:34-38) + 解析体(:135-194) 改为遗留键路由进 `extras`/frontmatterExtra（D5，不进 partial）。 | — |
| **T13** | backend：`agent.ts` createAgent insert(:77-83)/updateAgent set(:135-140)/rowToAgent map(:495-503) 删 5 列；`schema.ts` agents 5 列定义(:35,39,40,42,43) 删（**与 migration 同 PR**）。 | T12 |
| **T14** | 迁移退役：`runtimeRegistry.ts` `migrateAgentParamsToRuntimes`(:488-623)+`profileKey`(:467-479) 整删；`cli/start.ts:218,226` import+调用删（**保留** seedBuiltinRuntimes/migrateConfigIntoBuiltins）。**勿删** runtimeProfileOf/resolveRuntimeByName。 | — |
| **T15** | migration `0057_rfc115_drop_agent_params.sql`：12 步重建 agents（显式列 = 当前全列−5；无二级索引免重建）；journal 追加 idx:56/version:"6"/breakpoints:true；embed 自动打包。 | T13 |
| **T16** | 前端：`agents.detail.tsx` agentToDraft 删 :131-135；`AgentImportDialog.tsx` 删 ROUTE_KEYS 5 键(:29-33)+add() 5 行(:113-117)。 | T12 |
| **T17** | i18n：删 `agentForm.importDialog.routedTo.{model,variant,temperature,steps,maxSteps}`(5，保留 name/description/permission/bodyMd/frontmatterExtra)。对称。 | T16 |
| **T18** | 测试：删 `runtime-profile-migration.test.ts`（随函数退役）；`migration-0057-*.test.ts`（agents 列名快照/行数不变/5 列消失）；`agent-md.test.ts` 遗留键→frontmatterExtra 红→绿；agents-new-snapshot/node-inspector/canvas-agents-late-load/agent-import-* 测试去 5 字段 fixture；源码文本「agents.detail 不含 a.model」；upgrade-rolling 列计数更新。 | T12–T17 |

**验收**：agent 无生成参数（schema/DB/markdown/前端皆无）；DROP 5 列后 typecheck/SELECT/smoke 全绿；老 agent.md 的 model 进 frontmatterExtra 不丢。
**勿删（活）**：`runtimes.*` profile 列、`node_runs.runtime_params_json`、runtimeProfileOf、resolveRuntimeByName、`RuntimeList` profile、`AgentForm`。

## PR-D — G2 config 死字段清理（无 migration，zod strip 自然丢弃）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T19** | `config.ts` 删 6 死字段 schema：`defaultModel(:57-58)/defaultVariant(:59)/defaultTemperature(:60)/defaultSteps(:61-67)/defaultMaxSteps(:68)/defaultClaudeModel(:50-51)`。 | — |
| **T20** | `runtimeRegistry.ts` `migrateConfigIntoBuiltins`(:418-463)：删 6 字段参数类型(:423-428)+backfill 读(:453-457,461,453)；**保留** opencodePath(:452)/claudeCodePath(:460) backfill（函数不整删）。 | T19 |
| **T21** | i18n：删 `settingsForm.{defaultModel,defaultModelHint,defaultVariant,defaultTemperature,defaultSteps,defaultStepsHint,defaultMaxSteps,defaultMaxStepsHint}`(8 漏删死 key)。**勿删** defaultRuntime*/defaultClaudeModel 的 runtime 相关项。对称。 | T19 |
| **T22** | 测试：`config.test.ts` 删 defaultModel/defaultSteps round-trip 系列(:43-130)；`agents-new-snapshot.test.tsx:61-65` cfg() mock 去 default* 键；`runtime-profile-migration.test.ts` 已随 T18 删；`admin-only-gate.test.ts:76` patch 样例换活字段（如 logLevel）。 | T19–T21 |

**验收**：6 死 config 字段 + 8 死 i18n key 清空；migrateConfigIntoBuiltins 仅 backfill 二进制路径；`defaultRuntime/opencodePath/claudeCodePath/claudeCodeEnabled` 不动。

## PR-E — G2 `node_runs.agent_snapshot` 清理（migration 0058，最高风险·可回退）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T23** | 代码引用删：`review.ts` 写(:783,807)/读(:2408)/arg 类型(:706)；`shared/schemas/review.ts:163` + ReviewVersion DTO 字段；`schema.ts:849` 列定义。 | — |
| **T24** | migration `0058_rfc115_drop_agent_snapshot.sql`：12 步重建 node_runs（显式列 = 0041 全列 + 0042-0056 增量 − agent_snapshot；**重建索引** idx_node_runs_task/parent）；journal idx:57。 | T23 |
| **T25** | 测试：`migration-0058-*.test.ts`（node_runs **列名集合快照** + 行数不变 + runtime_params_json 等活列值保留）；review 测试去 agentSnapshot。 | T23–T24 |

**验收**：agent_snapshot 代码引用 + DB 列彻底删；列名快照守卫无漏/多列；活列值保留。
**可回退点**（D7）：若 Codex 设计 gate / 复审判定 node_runs 重建风险 > 收益 → PR-E 降级为「仅 T23 删代码引用，DB 列留 follow-up（恒 NULL 无害）」，跳过 T24/T25 的 DROP。

## 落档勾选

- [ ] 三件套 proposal/design/plan
- [ ] `design/plan.md` RFC 索引登记 RFC-115（Draft）
- [ ] `STATE.md` 顶部追加「进行中 RFC-115」
- [ ] Codex 设计 gate（实现前，feedback_codex_review_after_changes）
- [ ] ExitPlanMode / 用户批准 → 进入实现
- [ ] 实现各 PR + Codex 实现 gate + CI 绿

## 总「勿删」清单（防「彻底清理」误伤）

`config.defaultRuntime / opencodePath / claudeCodePath / claudeCodeEnabled` · `runtimes.{model,variant,temperature,steps,max_steps}` · `node_runs.runtime_params_json` · `runtimeProfileOf` · `resolveRuntimeByName` · `migrateConfigIntoBuiltins`(整体) · `RuntimeList` profile 字段 · `inventory/AgentsTable`(modelId) · `AgentForm` · `mcps.fieldTimeoutMs` · `settingsForm.defaultRuntime*` · `defaultClaudeModel` 的 runtime 相关 i18n。
