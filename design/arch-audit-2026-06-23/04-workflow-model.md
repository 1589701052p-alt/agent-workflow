# 工作流模型 / 校验 / YAML 导入导出 — 架构审计 (2026-06-23)

> 子系统 key=04-workflow-model。证据均为相对仓库根的 `file:line`。
> 与既有审计交叉印证处已显式标注「已被 <报告> 覆盖」。

## 0. 健康度一句话

模型层（DB JSON + Zod）干净简洁，但**校验器是一条 1645 行的命令式 if/switch 巨链**、且「节点种类有哪些端口」这一核心知识被前端画布 / 后端校验器 / 调度器**各写一份**（已漂移出过 bug）——加一个新 NodeKind 或新内置 prompt 变量会被迫扫改 16-24 个文件、且校验器与运行时存在数条静默不一致（RFC-066 多仓 token 漏登记会**误报阻止 launch**）。

## 1. 当前架构与职责（含关键文件）

工作流定义以 JSON 字符串存 `workflows.definition`，在 service 边界用 `WorkflowDefinitionSchema`（permissive `.passthrough()`）解析。校验分两段：**Zod 结构校验**（写入/读取边界）+ **`validateWorkflowDef` 语义校验**（5 大类规则，编辑器手动调 + launch 硬门）。版本有两套：`workflows.version`（每次 PUT +1）与 `definition.$schema_version`（NodeKind 演进，靠 `migrateDefinitionToLatest` 读时升级）。YAML 仅是传输层（DB 才是 source of truth）。

关键文件：
- `packages/shared/src/schemas/workflow.ts` — Zod 模型 + NodeKind 枚举 + 各 NodeKind 子 schema + 端口名常量。
- `packages/backend/src/services/workflow.ts` — CRUD + `migrateDefinitionToLatest`。
- `packages/backend/src/services/workflow.validator.ts` — 1645 行语义校验器（**热点**）。
- `packages/backend/src/services/workflow.yaml.ts` — YAML 导入导出 + 冲突解决。
- `packages/backend/src/routes/workflows.ts` — REST 路由 + ACL 投影。
- `packages/shared/src/node-kind-behavior.ts` — 试图集中化的「per-NodeKind 行为矩阵」（**多数维度未接线**）。
- `packages/backend/src/services/task.ts:424` — launch 硬校验门。

## 2. 设计问题（Design）

**[WFM-01] 校验规则是命令式 if/switch 巨链，无声明式规则注册表** — P1｜design/extensibility｜证据 `workflow.validator.ts:98-1393`（单函数 1300 行，内含 §1~§5 + §4b/4b.5/4c/4d/4e 等十余个手写规则块，规则间靠注释编号而非数据结构组织）｜影响 每加一条约束都得在巨函数里找正确插入点（RFC-094 design.md 通篇在描述「插在 :229 之后 / 边规则区 / case 块内」这类脆弱定位），规则顺序耦合（§4b.5 pre-pass 必须先于 §4c/§4d），无法单测单条规则的隔离、无法按 NodeKind 注册扩展。｜建议 抽 `WorkflowRule` 接口（`{ code, severity, run(ctx): Issue[] }`）+ 规则数组；ctx 预算一次性派生（nodeById/innerToWrapper/outputPorts/inbound/reverseAdj 现在散落在函数体内重复构建）。

**[WFM-02] `workflows.schema_version` DB 列恒为默认值 1，与真实版本（`definition.$schema_version`=4）永久背离，且被 API 暴露** — P2｜design/coupling｜证据 列声明 `db/schema.ts:319`（`.default(1)`）；create/update **从不写它**（`workflow.ts:46-57` insert、`workflow.ts:79-88` update 的 set 里都无 `schemaVersion`）；却照样投影进响应 `workflow.ts:182` + `WorkflowSchema` 暴露 `schemaVersion` 字段 `schemas/workflow.ts:214`｜影响 这是一个**始终撒谎**的字段（永远返回 1，真实是 4），前端无人消费（grep 证实前端只读 `definition.$schema_version`），属纯误导状态、未来若有人信它做迁移判断会出错｜建议 要么删列+API 字段，要么在 create/update 里写入 `WORKFLOW_SCHEMA_VERSION` 并作为权威（与 `definition.$schema_version` 二选一，不要并存两个版本号）。

**[WFM-03] `$schema_version` 升级是「纯元数据 bump」，migrate 框架是空壳但每次新 NodeKind 都强行 +1** — P2｜design｜证据 `workflow.ts:208-228`，v1→v2→v3→v4 四步全是 `{ ...current, $schema_version: n+1 }`，无任何结构变换；注释自陈「pure version-number bump」｜影响 版本号承载的语义≈0（旧文档本就不含新 NodeKind，根本不需要迁移），却制造了「每次 RFC 加 NodeKind 必须同步改 3 处：`NODE_KIND` 枚举、`WORKFLOW_SCHEMA_VERSION`、`migrateDefinitionToLatest` 加一段 if、`WORKFLOW_SCHEMA_VERSIONS` 数组、`$schema_version` union」的样板税。｜建议 NodeKind 增加属于「向后兼容的加法」，不该 bump schema 版本；把 `$schema_version` 保留给**真正破坏性结构迁移**（端口重命名、字段搬迁），新 NodeKind 不动版本号。

**[WFM-04] YAML 导入只做 Zod 结构校验，不做语义校验** — P2｜design｜证据 `workflow.yaml.ts:74-94` `previewWorkflowYaml` 只 `WorkflowDefinitionSchema.safeParse`；`importWorkflowYaml:96-157` 全程无 `validateWorkflowDef` 调用（grep 确认 yaml.ts 零引用）｜影响 一份拓扑断裂 / 端口悬空 / 聚合器放错位置的 YAML 能成功导入并入库，只在 launch 时才报错；导入时机本是给用户清晰反馈的最佳点（冲突对话框已在），却放过了｜建议 `previewWorkflowYaml` 之后跑一次 `validateWorkflowDef`（warnings 不阻断、errors 进 preview 让用户知情），与编辑器同源。

**[WFM-05] launch 硬门与 `/validate` 端点的校验上下文不一致（plugins 缺失）** — P1｜design/impl-bug｜证据 `validateWorkflowById` 传 `plugins: await listPlugins(db)`（`workflow.validator.ts:81`）；但 launch 门 `task.ts:424-427` 只传 `{ agents, skills }`，**不传 plugins**｜影响 RFC-031 的 `plugin-not-found` / `plugin-disabled` 规则在 launch 门**永远 no-op**（校验器 ctx.plugins===undefined 时整段跳过，`workflow.validator.ts:115-120`）：引用了未知/已禁用插件的工作流编辑器标红但能正常 launch，运行时才暴露。两个校验入口对「什么算合法」给出不同答案。｜建议 launch 门补传 `plugins: await listPlugins(db)`；更根本地，应有单一 `buildValidatorContext(db)` 让两个入口共享，杜绝再漏维度。

## 3. 实现问题 / Bug（Impl）

**[WFM-06] RFC-066 多仓内置 prompt 变量未登记进校验器 builtin 集 → `{{__repos__}}` 等误报、阻止 launch** — P1｜impl-bug｜证据 校验器 builtin 集 `workflow.validator.ts:46-64` 缺 `__repos__` / `__repo_names__` / `__repo_count__`（RFC-066）+ `__external_feedback_iteration__` / `__external_feedback_sources__`（RFC-056）；运行时替换引擎 `shared/src/prompt.ts:238-277` 这些**都支持**；rule 5 `workflow.validator.ts:1374-1388` 对非 builtin 且无入边的 token 报 `prompt-template-unresolved`（error 级 → launch 门拒绝 `task.ts:428`）｜影响 用户在多仓工作流里写合法的 `{{__repos__}}`/`{{__repo_count__}}`，编辑器与 launch 都报错、无法启动，但运行时本可正确替换——校验器比运行时更严苛，直接挡掉合法功能。无任何校验器测试覆盖这些 token（grep `packages/backend/tests/workflow-validator*` 无 `__repos__`）｜建议 校验器 builtin 集应从 `shared/src/prompt.ts` 的 `BUILTIN_VARS` **import 同一份**（见 WFM-07），而不是手抄。

**[WFM-07] 内置 prompt 变量集在校验器与替换引擎里各维护一份（drift 已发生）** — P1｜coupling／test-gap｜证据 校验器 `workflow.validator.ts:46-64`（14 项）vs 替换引擎 `shared/src/prompt.ts:238-277`（23 项）；两份是两个不同的 `new Set([...])` 字面量，无任何共享或一致性测试｜影响 这是 WFM-06 的根因：替换引擎加 token 时校验器没跟，导致「运行时能替、校验器误报」的单向漂移；反向（校验器列了引擎不替的 token）会导致 token 字面量泄漏进 prompt。已被 dedup-audit「公共原语被绕过各写一份」的总论覆盖，但**这一具体两处尚未在 dedup 清单逐项列出**，且已经漂移成 WFM-06 的 launch-blocking bug｜建议 把 `BUILTIN_VARS` 提升为 `@agent-workflow/shared` 单一导出，校验器与替换引擎都 import 它；加一条「两端集合相等」的源码层断言测试。

**[WFM-08] `migrateDefinitionToLatest` 的「未来版本 round-trip」注释与实际行为矛盾** — P2｜impl-bug（注释失实）｜证据 `workflow.ts:222-226` 注释称「unknown future version (e.g. v4 …) round-trips unchanged」；但读路径 `rowToWorkflow:152-161` 先 `WorkflowDefinitionSchema.safeParse`，而该 schema 的 `$schema_version` 只接受 `union(1,2,3,4)`（`schemas/workflow.ts:194`）——任何 v5 行会在 safeParse 失败、抛 `workflow-definition-corrupt`，**根本走不到** migrate 的 round-trip 分支｜影响 「向后/向前兼容」是假承诺；新 daemon 写的 v5 被旧 daemon 读会报「损坏」而非优雅降级；注释的「e.g. v4」也已过期（4 现在是 current）｜建议 删除失实注释；若真要前向兼容，schema 的 `$schema_version` 应用 `z.number().int().positive()` + 单独 range 警告，而非硬枚举。

**[WFM-09] `UploadInputSchema`（防路径穿越的严格 schema）实际从未在写路径执行，doc 注释撒谎** — P2｜impl-bug／security-adjacent｜证据 `schemas/workflow.ts:153-157` 注释明言「services/workflow.ts runs this against each upload entry **at write time**」；但 grep 全仓 `UploadInputSchema` 仅 `routes/tasks.ts:16,596` 使用（launch/multipart 期），`workflow.ts`/`workflow.yaml.ts`/`routes/workflows.ts` 零引用｜影响 工作流 create/update 时 upload input 的 `targetDir` 穿越校验**只**依赖语义校验器（`upload-input-target-dir-invalid` `validator.ts:777`），而校验器不是 save 门（WFM-04/§7）——一份带 `targetDir: '../../etc'` 的工作流能存进库，仅靠 launch 期 tasks.ts 的 safeParse 兜底。深度防御缺了写入这一层，且注释让人误以为有｜建议 在 create/update 对 `kind:'upload'` 项实跑 `UploadInputSchema`（兑现注释），或修正注释为「校验在 launch 期」。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 重点

**[WFM-10] 加一个新 NodeKind 要扫改 16-24 个文件，因为「NodeKind→端口」知识被三处各写一份** — P1｜extensibility｜
- 未来场景：加一个 `wrapper-parallel` / `subworkflow` / `transform` 节点（产品迟早要的组合原语）。
- 根因：「这个 NodeKind 暴露哪些 input/output 端口」这条核心知识没有单一函数，而是被**三份命令式 switch** 复制：① 后端校验器 `workflow.validator.ts:283-366`（建 `outputPorts`/`inputPorts`）；② 前端画布 `WorkflowCanvas.tsx:1230-1322`（建 Handle）；③ 调度器运行时端口解析（`scheduler.ts` 的 `git_diff`/`reviewApprovedPortName`/`approval_meta` 等散落，见 `scheduler.ts:4221` 等）。
- 现在加功能要碰：`NODE_KIND` 枚举 + `$schema_version` union + `WORKFLOW_SCHEMA_VERSION` + `migrateDefinitionToLatest`（5 处样板，见 WFM-03）+ 校验器 3 个 switch（端口集 :283、edge 规则 :402-464、reference :552）+ 画布 switch :1230 + 调度器派发 + `node-kind-behavior.ts` 矩阵 + 前端 `nodePalette.ts`/`KindSelect.tsx`/`NodeInspector.tsx`。grep 实测：单 `'agent-single'` 字面量出现在 24 个非测试文件、`wrapper-fanout` 16 个。
- 证据已漂移成 bug：`WorkflowCanvas.tsx:1296-1300` 注释自陈曾把 review 输出硬编码成 `approved_doc`、与校验器 `reviewApprovedPortName` 漂移、导致 `accepted` 端口的合法下游边在画布看着对却 `edge-source-port-missing`。三份 switch 的漂移**已经**坑过人。
- 目标形态：在 `@agent-workflow/shared` 出一个 `deriveNodePorts(node, def, agentByName): { inputs: Port[], outputs: Port[] }`（纯函数，单一事实源），校验器/画布/调度器全部 import 它；新 NodeKind 只需在这一处加 case。这正是 scheduler-audit-2026-06-10.md:280 列的 `computeNodeOutputs 抽共享` 待办——**已被 scheduler-audit 覆盖**，本审计补证其为整个子系统扩展性的 #1 瓶颈并给出更宽的目标契约（含 inputs）。

**[WFM-11] 校验规则无 NodeKind 维度注册，新 NodeKind 的约束只能继续往 1645 行巨函数里塞** — P1｜extensibility｜
- 未来场景：新 NodeKind 要带自己的拓扑约束（如 `subworkflow` 不可自引用、`transform` 必须恰好 1 入 1 出）。
- 根因：见 WFM-01，规则无接口、无注册表；NodeKind 专属规则（clarify §4c、cross-clarify §4d、fanout §4d/4e）都是巨函数里手写的 case 块 + 共享派生数据（reverseAdj 在 §4b 和 §4d 各建一遍：`validator.ts:869-873` 与 `:1106-1111`）。
- 现在加功能要碰：在 1300 行函数里找正确插入点、手动复用或重建派生 map、注意规则顺序（pre-pass 必须先跑，`validator.ts:990` 注释强调）。
- 目标形态：`WorkflowRule { code, appliesTo?: NodeKind[], severity, run(ctx) }` + 规则注册数组；`ctx` 一次性派生（nodeById/innerToWrapper/outputPorts/inbound/reverseAdj/loopOf），规则只读 ctx。NodeKind 专属规则随 NodeKind 定义就近声明。

**[WFM-12] `node-kind-behavior.ts` 集中矩阵只有 1/5 维度接线，其余 4 维是「文档」不是「行为」** — P2｜extensibility／observability｜证据 `node-kind-behavior.ts:15-21` 自陈「**Today**: only `retryCascade` is consulted at runtime … the other four dimensions document intended behavior」；`limits`/`orphanReap`/`gc`/`shutdown` 四维无任何运行时消费者（grep `NODE_KIND_BEHAVIORS` 仅 task.ts retry 路径用）｜影响 这是一个**看似已集中、实则假集中**的陷阱：新 NodeKind 作者会以为填了矩阵就万事大吉，但 limits/orphan/gc/shutdown 的真实路径仍是 kind-blind 的散装逻辑（注释承认「Their values can disagree with the current code paths without breaking anything」）。`isWrapperKind` 维度甚至还没进矩阵——dedup-audit #4 已记录 wrapper-kind 谓词 13 处散写、连 scheduler 自己 import 了 `WRAPPER_KINDS` 还在别处手写（**已被 dedup-audit 覆盖**）。｜建议 要么把四维真正接线（让 limits/orphans/gc/shutdown 去查表），要么删掉假维度只留接线的，避免「填了表却没用」的认知陷阱；`isWrapperKind` 补进矩阵并令后端 Set 派生。

**[WFM-13] 加一个新内置 prompt 变量要同时改两份手抄 Set，否则漂移成 launch-blocking** — P1｜extensibility｜见 WFM-06/WFM-07 的根因。未来场景：任何新 RFC 引入 `{{__xxx__}}` 系统 token（多仓 RFC-066 就踩了）。目标形态同 WFM-07：单一 `BUILTIN_VARS` 共享导出 + 相等性断言测试。

## 5. 耦合 / 分层违规

**[WFM-14] `countFanoutAggregators` 调用时手工拼造假 definition** — P3｜coupling｜证据 `validator.ts:1290-1294` 调 `countFanoutAggregators({ $schema_version: 4, inputs: [], nodes, edges }, …)`——硬编码 `$schema_version: 4` 拼一个伪 def 喂给 shared 工具｜影响 该工具签名要的是完整 def，但校验器只有 nodes/edges，于是塞个假 4；当 `WORKFLOW_SCHEMA_VERSION` 升到 5 时这个硬编码 4 不会自动跟，且暴露了「工具签名粒度过粗」的接口设计问题｜建议 `countFanoutAggregators` 改收 `{ nodes, edges }` 而非整个 def。

**[WFM-15] 校验器在巨函数内重复构建派生结构** — P3｜coupling/perf｜证据 `reverseAdj` 在 review §4b（`:869-873`）与 cross-clarify §4d（`:1106-1111`）各全量重建一次；`buildLoopMembership(nodes)` 被调 3 次（`:479` `:1005` `:1112`）｜影响 同一份图派生重复 O(E)/O(N) 计算、且两份 reverseAdj 若将来一处改判定就会偷偷不一致｜建议 函数头部统一派生一次（并入 WFM-11 的 ctx）。

## 6. 测试 / 可观测性缺口

**[WFM-16] RFC-066 多仓 token 在校验器侧零测试覆盖** — P1｜test-gap｜证据 `grep __repos__ packages/backend/tests/workflow-validator*` 无命中；shared 侧 `prompt-multi-repo-vars.test.ts` 只测替换、不测校验器是否接受｜影响 WFM-06 的 launch-blocking bug 正因无跨端一致性测试而潜伏｜建议 加「校验器接受全部 `prompt.ts:BUILTIN_VARS` token」+「两端 Set 相等」断言。

**[WFM-17] launch 门 vs `/validate` 端点的上下文差异无对比测试** — P2｜test-gap｜证据 WFM-05 的 plugins 缺失无测试守护（两个入口分别有测试，但无「两入口对同一 def 给出相同 issue 集」的对比测试）｜影响 校验上下文每加一个维度（RFC-031 plugins 已漏一次）都可能再漏｜建议 共享 `buildValidatorContext` 后加对比测试。

**[WFM-18] YAML 导入无语义校验测试** — P3｜test-gap｜证据 `workflow-yaml.test.ts` 不断言导入拓扑断裂工作流会被语义层拦/警告（因为本就没接，WFM-04）｜影响 若将来接上语义校验易回归｜建议 接上 WFM-04 后补测。

## 7. 目标形态（Target architecture）

1. **单一 NodeKind 描述符注册表**（`@agent-workflow/shared/node-kinds/`）：每个 NodeKind 一个对象，声明 `{ kind, deriveInputPorts(), deriveOutputPorts(), rules[], behavior(retry/limits/orphan/gc/shutdown), paletteMeta }`。校验器、画布、调度器、`node-kind-behavior` 矩阵全部从它派生。加 NodeKind = 加一个文件、改一处 `NODE_KIND` 枚举，TS 穷尽性兜底。
2. **声明式校验规则**：`WorkflowRule` 接口 + 注册数组，ctx 一次性派生；NodeKind 专属规则随描述符就近声明（消化 WFM-01/11/15）。
3. **单一 builtin prompt 变量源**：`BUILTIN_VARS` 提升为 shared 导出，校验器与替换引擎共享 + 相等性测试（消化 WFM-06/07/13/16）。
4. **统一校验入口**：`validateWorkflow(def, buildValidatorContext(db))`，编辑器 / `/validate` / launch 门 / YAML import 全走同一上下文（消化 WFM-05/04/17/18）。
5. **版本号语义收敛**：`$schema_version` 只为破坏性迁移而升；NodeKind 加法不 bump（消化 WFM-03）。`workflows.schema_version` 列与 `$schema_version` 二选一，不并存（消化 WFM-02）。
6. **写时严格 / 读时宽松边界归一**：upload 等严格子 schema 在 create/update 真正执行（消化 WFM-09）。

## 8. Top 风险与建议优先级（排序表）

| 优先级 | ID | 标题 | 类型 | 一句话理由 |
|---|---|---|---|---|
| P1 | WFM-06 | RFC-066 多仓 token 误报阻止 launch | impl-bug | 合法 `{{__repos__}}` 工作流无法启动，运行时本可替换 |
| P1 | WFM-10 | NodeKind→端口 三处各写一份 | extensibility | 加 NodeKind 扫改 16-24 文件、已漂移成 review 端口 bug（scheduler-audit 已列） |
| P1 | WFM-05 | launch 门漏传 plugins，校验规则静默失效 | design/impl | RFC-031 plugin 校验在 launch 永不触发 |
| P1 | WFM-07 | 内置 token 集双份维护已漂移 | coupling | WFM-06 的根因 |
| P1 | WFM-11 | 校验规则无注册表、塞 1645 行巨函数 | extensibility | 新约束无处可加、规则顺序/派生耦合 |
| P2 | WFM-09 | UploadInputSchema 写路径从未执行（注释撒谎） | impl/security | targetDir 穿越校验缺写入层、深度防御漏一层 |
| P2 | WFM-04 | YAML 导入只做结构校验不做语义校验 | design | 断裂工作流可入库、到 launch 才报 |
| P2 | WFM-02 | `schema_version` DB 列恒为 1 与真实背离且暴露 | design | 始终撒谎的 API 字段 |
| P2 | WFM-03 | `$schema_version` 升级是空 migrate、每个 NodeKind 强行 +1 | design | 版本号语义≈0、徒增样板税 |
| P2 | WFM-08 | migrate「未来版本 round-trip」注释失实 | impl | 前向兼容是假承诺、v5 读取报 corrupt |
| P2 | WFM-12 | node-kind-behavior 矩阵 4/5 维未接线（假集中） | extensibility | 填了表却没用的认知陷阱（dedup-audit #4 部分覆盖） |
| P2 | WFM-17 | launch vs /validate 上下文差异无对比测试 | test-gap | 维度每加必漏 |
| P3 | WFM-14/15 | countFanoutAggregators 拼假 def / 派生结构重复构建 | coupling | 接口粒度粗 + 重复计算 |
| P3 | WFM-16/18 | 多仓 token / YAML 语义校验无测试 | test-gap | 漂移无守护 |
