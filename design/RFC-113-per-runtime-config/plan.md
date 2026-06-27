# RFC-113 — 任务分解与 PR 拆分

配套 `proposal.md` / `design.md`。强序 3 PR（A→B→C），每 PR 独立测试绿。

---

## PR-A — 数据层 + 两段迁移（profile 列 + seed 保留 + config→行 + agent 参数→去重 profile）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T1** | migration `00NN_rfc113_runtime_profile.sql`：`runtimes` ADD `model`/`variant` text + `temperature` real + `steps`/`max_steps` integer + **`node_runs` ADD `runtime_params_json` text**（Codex P1-2 冻结）。schema.ts 同步 + journal 顺延 + upgrade-rolling + migration-0041 node_runs 列计数。 | — |
| **T2** | `runtimeRegistry`：5 列纳入 create/update/`runtimeRowToView`+校验；内置守卫拆分 `assertBuiltinIdentityImmutable`（删/改名/改协议 403；改 binary/model/params 允许）；同二进制多运行时（不校验 binary 唯一）；`isDefault`（行名===config.defaultRuntime，路由注入）。 | T1 |
| **T3** | `seedBuiltinRuntimes` 调整：内置行存在只锁 protocol+builtin、保留 binary/model/params。 | T1 |
| **T4** | `migrateConfigIntoBuiltins(db,config)`（一次性幂等 `??=`）：opencode 行←opencodePath/defaultModel/defaultVariant/defaultTemperature/defaultSteps/defaultMaxSteps；claude 行←claudeCodePath/defaultClaudeModel。接 `cli/start.ts`。 | T1–T3 |
| **T5** | `migrateAgentParamsToRuntimes(db,config)`（一次性幂等，D6 + Codex P1-1/P1-4/P2-1/P3-1）：**仅用户 agent**（排除 builtin=1 + 合成内部）；**NULL model 保独立维度**（不并入 defaultModel 内置）；**优先保持 agent 当前运行时**若 profile 匹配，再全局 dedup→复用/建 `{protocol}-{N}`（跳占用名、key 字典序赋号、temperature 定点序列化）；agent.runtime 指向 + 清空 agent 参数列。接 `cli/start.ts`（T4 后）。 | T1–T4 |
| **T6** | 弃用契约收口（Codex P2-2）：config schema 标 8 字段 `@deprecated`；agent schema 去 model/variant/temperature/steps/maxSteps（CreateAgent/Agent）、`agent.ts` create/update 不再 set 这些列、`rowToAgent` 不映射、markdown 导入/导出/详情不 surface（留 DB 列不 DROP、但对 API/UI/runner 不可见）。 | — |
| **T7** | 测试：5 列 CRUD+校验+同二进制多运行时；seed 保留；守卫拆分；config→行幂等；**agent→profile 迁移多场景 + 黄金不变式 + 幂等**（同参数多 agent 共享/不同参数各 profile/无 model→内置/匹配既有→复用）；upgrade-rolling 计数。 | T1–T6 |

**验收**：运行时=完整 profile；同二进制多运行时；存量代理按参数去重归入运行时、行为不变（黄金）。

---

## PR-B — 后端解析改读运行时 + 节点去参数 + 二进制收口

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T8** | `buildInlineAgentEntry(agent, runtimeParams)`：model/variant/temperature/**steps + maxSteps**（Codex P2-3 补遗漏）从 runtimeParams 取（不读 agent.model/overrides）；**claude 分支**（runner.ts:793）`model` 也改读 `runtimeParams.model`（Codex P1-3 同源）；readonly 仍 agent。 | PR-A |
| **T9** | 调度派发点：`resolveAgentRuntime` 扩展返全 profile；**dispatch 冻结 params→`node_runs.runtime_params_json`**（Codex P1-2）；runNode `opts.runtimeParams` 从冻结取；**resume 读冻结 + 携带 session 时继承源行**（同 RFC-112 P1）。3 派发点（主/fanout/aggregator）。 | PR-A,T8 |
| **T10** | `AgentOverrides` + 工作流节点 config schema 去 model/variant/temperature/steps；runner 不读 overrides 参数（旧定义残留**忽略** + 工作流**下次保存/导出剥离**死字段，Codex P3-2）。 | T8 |
| **T11** | 二进制收口：移除 RFC-112 P2 `claudeCodePath` 透传链；claude head fallback 简化；`resolveOpencodeCmd` 失效化（runtimeBinary 胜）。 | PR-A |
| **T12** | 测试：buildInlineAgentEntry 从 runtimeParams 取（黄金，不读 agent.model）；调度透传 runtimeParams；节点旧参数 override 被忽略；二进制收口黄金（内置行 binary→head=[path]；NULL+测试→mock）。 | T8–T11 |

**验收**：runner 从运行时取参数；agent/节点参数不再生效；二进制单一来源=行。

---

## PR-C — 前端（AgentForm 选择器-only + 节点去参数 + 运行时页签纯表 + profile 编辑 + 行级默认 + 全局项搬迁）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T13** | `AgentForm` 删 model/variant/temperature/steps/maxSteps 字段（+ isClaude/模型命名空间逻辑）；只剩运行时 `<Select>` + readonly 等代理项。 | PR-A |
| **T14** | WorkflowCanvas/NodeInspector 删 model/variant/temperature/steps override 控件。 | PR-A |
| **T15** | `RuntimeFormDialog` 加 model(`<ModelSelect>` 按协议)/variant/temperature/steps/maxSteps（仅 opencode 协议显 variant/temp/steps）；同二进制多运行时；内置 name/protocol 锁、profile 放开、无删除。 | PR-A |
| **T16** | settings RuntimeTab 删 SectionForm 只留 RuntimeList；`RuntimeList` 行级「设为默认」标记+`isDefault` 高亮→`PUT /api/config {defaultRuntime}`；删 defaultRuntime 下拉；`agents.new.tsx` 去 model 预填。 | T13 |
| **T17** | 全局项搬迁：并发→limits 页；logLevel→appearance；commit&push→自有分区。保留 key+save、换页签。 | T16 |
| **T18** | i18n（profile 字段 + setDefault/isDefault 中英对称；搬迁字段 key 复用）+ 前端测试（AgentForm 无参数字段〔源码文本断言无 ModelSelect/temperature〕；节点抽屉无参数 override；RuntimeFormDialog profile 字段按协议显隐；运行时页签纯表；行级默认 PUT config；全局项在目标页签）。 | T13–T17 |

**验收**：代理只选运行时；节点无参数；运行时页签纯表 + 每行编辑全套 profile + 设默认；全局项各归页签；i18n 对称、公共组件优先。

---

## 全局验收清单

- [x] PR-A（`9f54502`）：profile 列（migration 0056）+ 同二进制多运行时 + seed 保留 binary/profile + 两段迁移幂等无损（黄金不变式 + 跳过全 NULL 裸代理保幂等）。
- [x] PR-B（`97902d4`）：runner buildInlineAgentEntry 读运行时参数 + agent/节点参数不生效 + 二进制单一来源。
- [x] PR-C（`bbaf94c`）：AgentForm/节点去参数 + 运行时页签纯表 + RuntimeFormDialog profile 编辑 + 行级默认 + 全局项搬迁（**全部并入 Limits 页**：并发/multiProcess/logLevel/commit&push 同处——比 T17「分散到 limits/appearance」更聚合，「全局执行旋钮」单页更顺）+ i18n。
- [x] 迁移无损（黄金：迁移前后 inline model/variant/temp/steps 逐字一致）+ 幂等（跑两次不变；`runtime-profile-migration.test.ts` 11 测试）。
- [x] 门禁全绿：typecheck×3 + backend bun test + 前端 vitest 2759 + format + lint。
- [x] Codex 设计 gate 10 findings fold。STATE.md/plan.md/proposal 索引 Done。实现 gate 跑中（base `97902d4`，含 smoke/NUL 修复）。

## 与 RFC-112 / 在途衔接
- 复用 RFC-112：runtimes 表/CRUD/runtimeBinary 冻结/pickRuntimeHead/RuntimeList——本 RFC 加 profile 列 + 改参数归属 + 两段迁移 + UI 重排。
- 多人共享树：migration 号 push 前查 journal 顺延；精确路径提交；i18n 纯新增不删他人 key。
