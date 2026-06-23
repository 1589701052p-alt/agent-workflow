# Codex 核验：工作流模型 / 校验 / YAML (04-workflow-model)

> 对应报告：`design/arch-audit-2026-06-23/04-workflow-model.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- WFM-05 属实，P1 合理：`/validate` 通过 `validateWorkflowById` 传入 `plugins`（`packages/backend/src/services/workflow.validator.ts:78-82`），但 launch 门只传 `agents/skills`（`packages/backend/src/services/task.ts:424-427`）。插件校验在 `ctx.plugins` 缺失时 no-op（`packages/backend/src/services/workflow.validator.ts:112-120`），会导致 `plugin-not-found/plugin-disabled` 在启动时漏检（`packages/backend/src/services/workflow.validator.ts:597-610`）。
- WFM-06 / WFM-07 / WFM-13 属实，P1 合理：validator 的内置变量集合缺 `__external_feedback_iteration__`、`__external_feedback_sources__`、`__repos__`、`__repo_names__`、`__repo_count__`（`packages/backend/src/services/workflow.validator.ts:46-64`），运行时替换支持这些变量（`packages/shared/src/prompt.ts:238-277`、`packages/shared/src/prompt.ts:360-371`）。模板校验会把非 builtin 且无入边的变量报 error（`packages/backend/src/services/workflow.validator.ts:1368-1388`），launch 会拒绝（`packages/backend/src/services/task.ts:421-434`）。
- WFM-02 属实，P2 合理：DB `workflows.schema_version` 默认 1（`packages/backend/src/db/schema.ts:308-319`），create/update 不写该列（`packages/backend/src/services/workflow.ts:46-57`、`packages/backend/src/services/workflow.ts:79-88`），响应仍暴露 `schemaVersion`（`packages/backend/src/services/workflow.ts:173-183`、`packages/shared/src/schemas/workflow.ts:204-215`）。
- WFM-08 属实，P2 合理：读路径先用 `WorkflowDefinitionSchema.safeParse`（`packages/backend/src/services/workflow.ts:149-162`），而 schema 只允许 1-4（`packages/shared/src/schemas/workflow.ts:188-195`），所以 future v5 走不到 `migrateDefinitionToLatest` 的 round-trip 注释（`packages/backend/src/services/workflow.ts:222-226`）。
- WFM-09 基本属实，但建议降到 P3 / doc-contract bug：`UploadInputSchema` 注释说 write time 执行（`packages/shared/src/schemas/workflow.ts:153-157`），实际工作流 create/update/import 未调用；严格执行在 task multipart 路由（`packages/backend/src/routes/tasks.ts:589-606`）。不过 validator 已有语义规则（`packages/backend/src/services/workflow.validator.ts:762-783`），启动门会挡住，安全影响没有报告写得那么强。
- WFM-01 / WFM-11 / WFM-15 属实但偏架构债：`validateWorkflowDef` 是 1645 行文件中的巨型函数入口（`packages/backend/src/services/workflow.validator.ts:98-1393`），端口派生、引用校验、拓扑、prompt 校验等规则混在一起，且重复构建 `reverseAdj` / loop membership（`packages/backend/src/services/workflow.validator.ts:868-874`、`packages/backend/src/services/workflow.validator.ts:1005`、`packages/backend/src/services/workflow.validator.ts:1106-1112`）。
- WFM-10 大体属实：端口知识仍分散在 validator（`packages/backend/src/services/workflow.validator.ts:280-366`）和 canvas（`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1247-1320`）；review 端口漂移的历史注释也真实存在（`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:1292-1300`）。但报告说“调度器也有完整端口 switch”略夸张，调度器更多是运行时产物写入，如 `git_diff`（`packages/backend/src/services/scheduler.ts:4182-4222`）。
- WFM-12 属实，P2 可接受：`node-kind-behavior.ts` 明确说目前只有 `retryCascade` 被运行时消费，其余维度是 intended behavior（`packages/shared/src/node-kind-behavior.ts:15-21`）。
- WFM-14 属实但 P3：validator 为 `countFanoutAggregators` 拼了硬编码 `$schema_version: 4` 的伪 definition（`packages/backend/src/services/workflow.validator.ts:1289-1294`），而 helper 实际只需要 nodes/edges/agent lookup（`packages/shared/src/wrapperFanout.ts:87-100`）。
- WFM-16 / WFM-17 / WFM-18 方向属实：共享 prompt 测试覆盖多仓变量，但 validator 侧没有接受这些 token 的测试；插件校验入口差异和 YAML 语义校验也缺对比测试。

## REFUTED / 伪问题（给反证 file:line）

- WFM-04 “YAML 导入不做语义校验”证据属实（`packages/backend/src/services/workflow.yaml.ts:74-94`、`packages/backend/src/services/workflow.yaml.ts:96-157`），但“应阻止入库”不完全成立：本系统明确是“校验失败不阻止保存，但阻止启动 task”（`packages/backend/src/services/task.ts:421-423`），普通 create/update 路由同样只做 Zod + ACL，不跑语义 validator（`packages/backend/src/routes/workflows.ts:62-97`）。更准确的问题是：YAML preview/import 没把语义 issues 返回给用户，而不是必须阻断导入。
- WFM-03 的“新增 NodeKind 不该 bump schema version”是有争议的建议，不是明确 bug。当前代码和测试把 NodeKind 增加与版本 bump 绑定（`packages/shared/src/schemas/workflow.ts:6-27`、`packages/shared/tests/cross-clarify-rfc056-shared.test.ts:31-58`）。旧 daemon 也会因 `NodeKindSchema` 拒绝未知 kind（`packages/shared/src/schemas/workflow.ts:31-47`），所以“不 bump 就向后兼容”并不成立。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- 节点 / 边 ID 没有唯一性校验 — P1 — `packages/shared/src/schemas/workflow.ts:87-90`、`packages/shared/src/schemas/workflow.ts:132-138`、`packages/backend/src/services/workflow.validator.ts:227-228`、`packages/backend/src/services/scheduler.ts:668-670` — schema 只要求非空，validator 只校验了 input key 重复（`packages/backend/src/services/workflow.validator.ts:749-760`），没有 `node.id` / `edge.id` 唯一性规则；运行时大量用 `Map(node.id)`，重复 id 会覆盖、合并 node_run 状态、错误调度或错误解析边。
- 同一节点可被多个 wrapper 声明为 inner，未被 validator 真正拦截 — P2 — `packages/backend/src/services/workflow.validator.ts:234-247`、`packages/backend/src/services/workflow.validator.ts:817-850`、`packages/backend/src/services/scheduler.ts:4920-4957` — validator 注释说 RFC-016 会抓“node listed in two wrappers”，但实际 RFC-016 规则只检查坐标越界且只覆盖 git/loop wrapper；scheduler `buildContainerMap` 对重复归属采用 innermost/先写策略，会让 wrapper 边界、loop membership、fanout placement 判断与画布结构不一致。
- wrapper-fanout boundary-input 可把非 shardSource 输入接到 per-shard inner，但运行时只注入 shardSource — P2 — `packages/backend/src/services/workflow.validator.ts:1317-1325`、`packages/backend/src/services/scheduler.ts:3234-3247`、`packages/backend/src/services/scheduler.ts:3567-3575` — validator 只检查 source port 已声明、target 在 inner 中；dispatch 时只对 `e.source.portName === shardSourcePortName` 注入 shard value，非 shardSource boundary-input 到 per-shard inner 会静默依赖普通 `resolveUpstreamInputs`，容易渲染为空或语义错误。至少应禁止非 shardSource boundary-input 指向 per-shard inner，或明确按 broadcast 注入。
- wrapper-fanout input 名称未校验唯一 — P3 — `packages/backend/src/services/workflow.validator.ts:198-223`、`packages/backend/src/services/workflow.validator.ts:1408-1422`、`packages/frontend/src/components/canvas/NodeInspector.tsx:669-680` — validator 只校验 shardSource 个数和 kind，不检查 `inputs[].name` 重复；canvas 允许编辑成重复名。重复端口会让 handle、boundary edge 和 prompt input 覆盖，属于低成本的模型不变量补洞。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的“单一 NodeKind 描述符注册表 + 规则注册表”方向正确，但一次性把 ports、rules、behavior、paletteMeta、scheduler 全塞进大注册表有过度设计风险，容易把 shared 包变成前后端与运行时的混合依赖中心。更稳的拆法是先抽纯函数事实源：`deriveNodePorts(def,node,agentLookup)`、`BUILTIN_PROMPT_VARS`、`buildValidatorContext(db)`，先消灭已发生 drift 的点。

规则注册表建议分阶段做：先把现有 validator 内的派生 ctx 前置并拆出 5-8 个纯规则函数，保持调用顺序显式；等规则边界稳定后再上通用 `WorkflowRule` 接口。当前 RFC-097 状态机 CAS、RFC-099 prompt 隔离、opencode env 合并优先级不应被这个重构触碰，尤其不要把调度器运行状态或 ACL actor 信息塞进 shared NodeKind 描述符。

版本建议不要简单采纳“新增 NodeKind 不 bump”。更优解是区分 `definitionFormatVersion` 和 `minReaderVersion`，或者保留 bump 但修正 future-version 注释与 schema 策略。否则旧 daemon 对未知 NodeKind 仍会拒绝，只是错误更隐蔽。

YAML 导入建议与现有保存语义一致：不强制阻断语义错误，但 preview/import response 应返回 validator issues；launch 仍是唯一硬门。这样不会破坏“可保存草稿”的编辑器不变量。

## 总评（sound / mostly-sound / flawed + 一句理由）

mostly-sound：报告抓住了真实的高风险 drift（plugins 上下文、builtin vars、端口派生重复），但把 YAML 导入语义校验和 schema version bump 的目标形态说得过硬，并漏掉了 node id 唯一性这类更基础的模型不变量。
