# RFC-060 — Fanout as Wrapper（产品视角）

**状态**：Draft
**关联**：RFC-005 review / RFC-015 fanout-source-port-drag / RFC-016 wrapper-container-ux / RFC-023 clarify / RFC-049 port-content-repair-followup / RFC-053 lifecycle-hardening / RFC-055 fanout-sharding-strategy-inspector / RFC-056 cross-agent clarify
**前置依赖**：无（agent-multi 未上生产，可直接断代）

---

## 1. 背景

### 1.1 现状一句话

当前 fanout 是 NodeKind `agent-multi`：单个 agent 的多进程变体，由 backend 内置三种 sharding 策略（per-file / per-N-files / per-directory），输出固定走"按 shardKey 字典序 `\n` join"聚合。整套机制只服务 git_diff 一种数据形态，且与 review / clarify / cross-clarify 等节点 kind 互相排斥或要 special-case。

### 1.2 暴露的产品痛点

**痛点 A — `markdown_file × review` 失效**：
用户把 reviewer 挂在 fanout 的 `markdown_file` 输出 port 上时，整条流跑不通。

具体推演（已在主对话中复盘）：每个 shard 的 worker 在 envelope 里 emit 的是一个 `.md` 路径；fanout 聚合器**完全不看 `outputKinds`**，照样把 N 个路径用 `\n` 拼起来落到父 `nodeRunOutputs.content`；review 节点读父 row、调 `resolvePortContentDetailed({ kind: 'markdown_file' })` 把整段当**单个路径**校验 → 中间换行让 `readFileUtf8` 必然 fail，落到 `port-validation-markdown_file-missing-file`，review 节点变成 `kind: 'failed'`，**0 个 review 产出**。

源码里那条 `// Skip fan-out child rows — multi-process review fanout per-shard is RFC-005 T14`（`packages/backend/src/services/review.ts:339-341`）就是为这种场景预留的 TODO，从未落地。

**痛点 B — `fanout` 不是控制流，是 NodeKind**：
fanout 在语义上是"记录状态 → 跑 inner → diff/聚合"的控制流抽象（与 `wrapper-git` / `wrapper-loop` 同一档），但当前实现把它绑死成一个 agent 节点 kind：

- `clarify-cross-agent` 节点的 v1 验证显式禁 `agent-multi` 上游（`workflow.validator.ts:899` `clarify-cross-agent node must connect to an agent-single questioner; agent-multi is deferred to a follow-up RFC`）。
- review 节点的 freshness 选择跳过所有 fan-out 子 row（同上 TODO 注释）。
- clarify 节点在 fanout 下每个 shard 独立开会话——只是因为 fanout 本身硬编码而被迫的特殊处理（`db/schema.ts:629`），不是统一抽象。
- scheduler 里 `agent-multi` 走完全独立的调度分支（`scheduler.ts:168` 排除条件 + `:2171-2454` 整条 fanout 路径）。
- 前端 NodeInspector 给 `agent-multi` 单独画 sharding strategy 表单（RFC-055）。

每加一个新的节点 kind（reviewer / clarifier / aggregator / 未来的什么）都得给 fanout 写一遍 special-case。fanout-as-wrapper 模型下，这些 kind 直接落进 wrapper 的 inner subgraph，per-shard 语义由 wrapper 统一表达，**不再为每种 agent 写一份 fanout**。

**痛点 C — sharding 策略与上游耦合**：
当前 `shardingStrategy` 是 wrapper-fanout（实际是 `agent-multi`）的配置字段，但它只对 `git_diff` 这一种输入有意义；要支持 markdown 文档列表分片，需要在 backend 再加一套 `kind: 'per-markdown-file'`。每加一个分片源就要改 backend 算法。**正确的抽象层级是把"分片粒度"塞回到上游 agent 的输出 kind**：上游 agent 直接输出"列表 kind"，列表的每个 item 天然就是一个 shard，下游 fanout 不再关心策略。

### 1.3 设计变更动机

把以上三个痛点一次性收拾干净，需要的不是给 `agent-multi` 打补丁，而是抬升抽象层级：

1. **fanout → wrapper**：与 `wrapper-git` / `wrapper-loop` 同一类。inner 是任意子图。
2. **sharding → kind 系统升级**：引入参数化 kind `path<T>` 和 `list<T>`；上游 agent 输出 `list<T>` 即天然分片，下游 fanout `shardSource` 端口指向某个 `list<T>` 即开始 fan-out。
3. **聚合 → agent role 标志 + LLM 收口**：默认聚合 agent 复用整套 agent 创建 / 管理 UI，仅在 `agent.md` frontmatter 加 `role: 'aggregator'`；runtime 把所有 shard 的同名输出汇成 raw list 喂给聚合 agent 的 prompt（新模板循环语法），由 LLM 决定如何合并。
4. **review / clarify per-shard 自然落地**：作为 inner 节点放在 wrapper-fanout 里，每个 shard 一份独立的 review row / clarify session，不需要 fanout 自己实现 per-shard 分发。
5. **断代 `agent-multi`**：因为没人上线使用，直接删 NodeKind，不留语法糖。

### 1.4 时机

`agent-multi` 是 P-3-01 落地的，但截至本 RFC 起草时**未在任何生产工作流中上线使用**——`STATE.md` / `design/plan.md` 没有 agent-multi 上线 milestone 记录，DB 里也无相关 row。此刻是断代代价最小的窗口；推迟到有人用上之后，等价 schema 迁移 + 数据回填代价会陡增。

## 2. 目标 / 非目标

### 2.1 目标

- **G1**：把 `agent-multi` NodeKind 从 schema / validator / scheduler / frontend 完全移除，由 `wrapper-fanout` 新 NodeKind 替代。
- **G2**：引入参数化 kind 系统：`path<T>` 基类 + `list<T>` 列表泛型；`markdown_file` 重定义为 `path<md>` 别名（YAML 读保持兼容、内部统一）。
- **G3**：`wrapper-fanout` 支持任意 inner subgraph（含 `review` / `clarify` / `clarify-cross-agent` / 嵌套 `wrapper-git` / `wrapper-loop` / `wrapper-fanout`），全 NodeKind 开放。
- **G4**：sharding 不再是 wrapper 字段；上游 agent 输出 `list<T>` 即天然分片，每个 list item → 一个 shard，shardKey 由 list kind 注册的 `keyOf` 函数提取（无注册时退路 = 0-based index）。
- **G5**：默认聚合 agent 通过 `agent.md` frontmatter `role: 'aggregator'` 标记；只跑 LLM；prompt 模板新增 `{{#each port.shards}}…{{/each}}` 循环语法访问 raw list；runtime 给聚合 agent 跑 1 次、自动豁免"跨 shard scope 自动 promote"规则。
- **G6**：`signal` 作为普通 agent output kind 之一；signal port 不能被 prompt 模板 `{{}}` 引用；fanout 无聚合 agent 时 wrapper 自动 mint 一个 `__done__` (`kind: signal`) 输出，纯控制流。
- **G7**：`wrapper-git` 的 `git_diff` port kind 从 `string` 升级为 `list<path>`，作为 fanout 默认接入源；breaking change，但 wrapper-git 也未上线，与 agent-multi 同窗口断代。
- **G8**：`review` / `clarify` / `clarify-cross-agent` 节点放在 `wrapper-fanout` 内时，每个 shard 独立有一份 node_run（自然的 per-shard human gate）；reject / iterate 仅在该 shard 内重跑。
- **G9**：cartesian guard：schema-time warning（fanout-in-fanout 出现即提示）+ runtime hard limit（shard 总数阈值默认 256，可在 settings 调）。

### 2.2 非目标（v1 不做）

- **N1**：完整 kind subtype 推断 / covariance 校验。v1 只支持精确 kind 匹配；`list<path>` 不能接 `list<path<md>>`，反之亦然（这条交给后续 RFC，加完整 type system 时再放开）。
- **N2**：function 模式聚合 agent。默认聚合一律 LLM；要纯函数聚合的可以在 LLM agent 里 prompt "直接 join 后输出" 退路，未来再加 function flavor。
- **N3**：`agent-multi` 兼容层 / migration script。直接 schema 拒绝；DB 里若有 historical agent-multi row 由 manual cleanup 处理（实测无）。
- **N4**：多个聚合 agent / 一个 wrapper-fanout。v1 限 1 个，architecture 允许后续 v1.x 扩多个聚合 agent + outputs union。
- **N5**：`list<T>` 的 keyOf 自定义注册 UI。v1 keyOf 函数由 backend 代码注册（`path<*>` 取路径本身 / 其他默认 0-based 索引），用户无法在前端定义新的 keyOf。
- **N6**：`signal` 端口跨多个 source 的 join 语义（"所有上游 signal 全部 ready 才触发"）。v1 signal 是普通边，target 节点等"任一上游 ready"即可。AND / OR 语义留给 RFC 后续。
- **N7**：cross-shard cartesian 优化。fanout-in-fanout 严格 cartesian（N×M），不做"按 key 配对 zip"模式；想 zip 自己用 list<T> 的方式表达。

## 3. 用户故事

### 3.1 US-1：N 份 markdown 文档独立检视

**角色**：质量保证工程师

**场景**：批量审查工程师交付的多个设计文档（每个文档独立的 `.md` 文件）。

**当前痛点**（RFC-060 之前）：
- 把 designer agent 设为 `agent-multi`，shardSource 接某个文件路径列表 → 跑挂（markdown_file × fanout 聚合用 `\n` join 路径，下游 review 无法 resolve）。
- 退路只有"把 reviewer 当成 agent-multi 内的 worker，自审 + 自报"——但失去 review node 的归档 / iterate 语义。

**RFC-060 后的体验**：

1. designer agent 声明 output port `docs: list<path<md>>`；
2. 用户在 canvas 拖一个 `wrapper-fanout`，从 designer.docs 拖一条 boundary 边到 wrapper 的 `shardSource` 入口；
3. 在 wrapper 内画 reviewer 节点（kind=`review`），把 wrapper 边界 `shardSource` 拖到 reviewer 的 input；
4. wrapper 内画一个 role=aggregator 的聚合 agent，把 reviewer 的 approved 端口接到聚合 agent；
5. 启动 task：每个 doc 路径分一个 shard，reviewer 节点为每个 shard 独立 mint 一行 `awaiting_review` node_run，用户在 `/review` 界面看到 N 个待审 tile，独立 approve / reject；
6. 全部 approve 后 → 聚合 agent 跑 1 次、收 raw list（N 个 approved path），LLM 决定如何合并（如生成总结 markdown），输出经 wrapper 边界出去给下游。

### 3.2 US-2：fanout 内嵌 cross-agent clarify

**角色**：工作流设计者

**场景**：跨 agent 反问，但 questioner 是 fanout 出来的 N 个 shard。

**当前痛点**：v1 限制 questioner 必须是 `agent-single`，agent-multi 反问场景"deferred to a follow-up RFC"（`workflow.validator.ts:899`）。

**RFC-060 后的体验**：
- 把 `clarify-cross-agent` 节点放进 wrapper-fanout 的 inner subgraph；
- 每个 shard 独立 mint 一行 clarify-cross node_run + 一行 `clarify_rounds` row（kind=cross，RFC-058 合表后的）；
- 用户在 `/clarify` 界面看到 N 个独立的 cross-clarify 会话，每个会话独立 submit / reject；
- submit 仅触发该 shard 内 designer rerun；其他 shard 不受影响（per-shard cci 独立计）。

### 3.3 US-3：在 fanout 内嵌套 git wrapper

**角色**：审计员

**场景**：每个 shard（每个文件）需要独立的 git diff 快照。

**当前痛点**：agent-multi 内无法套 `wrapper-git`（NodeKind 互斥）。

**RFC-060 后的体验**：
- wrapper-fanout 的 inner subgraph 里再画一个 `wrapper-git`，里面放 worker agent；
- 每个 shard 跑一遍 git wrapper：前后快照 + worker 跑动 → 该 shard 的 git_diff；
- 聚合 agent 收 N 个 shard 的 git_diff（raw list），LLM 决定如何整体汇总。

### 3.4 US-4：fanout 无聚合 agent（纯并行执行）

**角色**：批处理脚本作者

**场景**：N 个文档每个跑一遍 lint，**不需要**汇总结果，只要 lint 全部跑完后触发下游通知。

**当前痛点**：必须给每条 fanout 路径凑一个 worker agent，否则 fanout 无法接下游。

**RFC-060 后的体验**：
- wrapper-fanout 不放聚合 agent；wrapper 自动 mint 一个 `__done__` (`kind: signal`) 输出端口；
- `__done__` 边连到下游 notification agent；signal kind 不传递数据，仅表达"所有 shard 都完成"控制流；
- notification agent 的 prompt 模板里不能 `{{__done__}}` 引用——validator 报错引导用户挪到 data 端口。

### 3.5 US-5：cartesian guard 阻挡过度并行

**角色**：维护者 / 审稿人

**场景**：用户不慎在 wrapper-fanout 内嵌一个 wrapper-fanout，外层 32 个 shard、内层 50 个 shard，蹦出来 1600 个 opencode 进程。

**RFC-060 体验**：
- Schema-time：editor 的 ValidationPanel 显示 `wrapper-fanout-nested` warning，文案"wrapper-fanout '{outerId}' contains nested fanout '{innerId}' — total shard count may grow cartesian-large at runtime"；
- Runtime：在外层 fanout 展开 shard 时累乘内层 shard 总数估算，超过阈值（默认 256，settings 可调）→ hard fail with errorCode `fanout-cartesian-limit`。

## 4. 验收标准

> 实施完成后必须满足以下 ALL；任一未满足 = 未完工。

### A1. NodeKind 收敛

- [ ] `NODE_KIND` 枚举（`packages/shared/src/schemas/workflow.ts`）移除 `agent-multi`、新增 `wrapper-fanout`；其他 kind 不动。
- [ ] backend / frontend 全仓库 grep `agent-multi` 命中 0（除 RFC-060 文档自身、迁移说明、test fixture 中明确标记 "rejected by validator" 的反例）。
- [ ] workflow.validator 见到 `kind: 'agent-multi'` 直接 `code: 'unknown-node-kind'` 报错。

### A2. kind 系统升级

- [ ] `AgentOutputKind` 字符串字面值支持 `path<T>` / `list<T>` 解析（T 可为 base kind 或参数化 kind，递归）。
- [ ] 注册表：`path<*>` / `path<md>` / `list<T>`（T = 任意已注册 base kind）默认创建，base kind 含 `string` / `markdown` / `signal` 等。
- [ ] `markdown_file` YAML 字面值读为 `path<md>`、内部统一存储；写回 YAML 时按内部统一规则输出（建议 `path<md>`，但保留 `markdown_file` 别名读路径）。
- [ ] `list<T>` 的 `keyOf` 注册表至少注册 `path<*>` → 路径本身（含子类 `path<md>`），其他 base kind → 0-based 索引。

### A3. wrapper-fanout schema

- [ ] `wrapper-fanout` NodeKind 含 `inputs[]`（其中 1 个 `isShardSource: true`，必须是 `list<T>` kind）、`nodeIds[]`（inner subgraph 引用，同 wrapper-git/loop 约定）。
- [ ] `outputs[]` 不存于 schema；前端/后端按统一推导规则：有聚合 agent → 直接 = 该 agent outputs（可经 wrapperPortName 重命名）；无聚合 agent → `[{name: '__done__', kind: 'signal'}]`。
- [ ] `edge.boundary: 'wrapper-input' | 'wrapper-output'` 字段在 `WorkflowEdgeSchema` 落地；validator 校验 boundary 边的 source/target 与 wrapper 边界 port 对齐。

### A4. shard scope + 聚合 agent

- [ ] scheduler 实现 "reachable from `shardSource`" 推断：仅可达 inner 节点为 per-shard（mint N 行 node_run，每行 shardKey = 该 list item 的 keyOf）。
- [ ] shared 节点（不可达）若被 reachable 节点 fan-in 一条 data 边 → 自动 promote 为 per-shard，**除非 target 是聚合 agent（role=aggregator）**。
- [ ] 聚合 agent 永远跑 1 次、看到每个 input port 是 `[{shardKey, content}, …]` 形态的 raw list。
- [ ] prompt 模板 `{{#each port.shards}}{{shardKey}}: {{content}}{{/each}}` 类语法在 runner prompt 渲染层支持。

### A5. agent role=aggregator + signal output

- [ ] `agent.md` frontmatter 新字段 `role: 'normal' | 'aggregator'`（默认 normal）；前端 agent 编辑器加该选项。
- [ ] `agent.outputs[i]` 新可选字段 `wrapperPortName?: string`（仅 role=aggregator 时生效，控制 promote 到 wrapper.outputs 时的命名）。
- [ ] agent.outputs[i].kind 接受 `signal`；signal port 在 prompt 模板被 `{{}}` 引用时 validator 报错 `signal-port-in-prompt`。

### A6. wrapper-git 升级

- [ ] `wrapper-git` 的 `git_diff` port kind 从 `string` 改为 `list<path>`，每个 item 是改动文件的 worktree-relative path。
- [ ] 任何之前依赖 `git_diff` 是单字符串的下游 prompt 模板使用 `{{git_diff}}` 处显示 path 列表换行 join（与 `list<T>` 的默认 prompt 字面渲染规则一致）。
- [ ] `git_diff_file_list` 这种"路径 + diff text 配对"形态**不**作为新增 kind 落地（v1 简化：只暴露 path 列表；要看 diff 文本上游 agent 自己读盘）。

### A7. per-shard review/clarify

- [ ] 把 `review` 节点放进 wrapper-fanout 的 reachable set 内时，每个 shard mint 一行独立 `awaiting_review` node_run；reject / iterate 仅在该 shard 内 cascade。
- [ ] `clarify` / `clarify-cross-agent` 节点同上：per-shard 独立 clarify session。
- [ ] review 节点 input 端口仍 **不允许接 `list<T>` kind**；要 per-item 检视必须放进 wrapper-fanout 内（validator 报错 `review-input-list-kind-not-supported`）。

### A8. cartesian guard

- [ ] Schema-time：wrapper-fanout 内嵌套 wrapper-fanout 触发 `wrapper-fanout-nested` warning。
- [ ] Runtime：scheduler 在展开 shard 时累乘嵌套 fanout 的 shard 总数估算，超过阈值 hard fail with `fanout-cartesian-limit`；阈值默认 256，从 `settings.fanoutMaxShardTotal` 读取（不存在时落默认）。

### A9. 测试覆盖

- [ ] backend ≥ 60 case：kind parser / list keyOf / wrapper-fanout validator / scheduler shard scope / 聚合 agent runtime / cross-set promote / cartesian guard / signal port enforcement。
- [ ] frontend ≥ 20 case：agent role 字段编辑 / wrapper-fanout 编辑器拖边界 port / cartesian warning 渲染 / 聚合 agent wrapperPortName 编辑。
- [ ] e2e ≥ 1 spec：`fanout-as-wrapper.spec.ts`，覆盖 US-1（markdown × review N 份） + US-3（fanout 内嵌 git wrapper）+ US-4（无聚合 agent placeholder signal）。

### A10. 文档 / 索引

- [ ] `design/plan.md` RFC 索引追加 RFC-060 行；
- [ ] `STATE.md` 顶部追加 "进行中 RFC: RFC-060"，PR 全部合入后改为完工记录；
- [ ] `proposal/init.md` 中"fanout 是 agent-multi 的多进程变体"措辞标注 "superseded by RFC-060"。

## 5. PR 拆分概览

详细见 `plan.md`。6 个 PR 强序：

- **PR-A**：kind 系统升级（`path<T>` / `list<T>` parser + 注册表 + `markdown_file` 别名兼容 + `signal` 加入 AgentOutputKind）。**纯 shared 层 + 单测**，无 runtime 影响。
- **PR-B**：agent role=aggregator + signal output kind 落地到 backend / frontend（agent 创建编辑界面 + frontmatter schema + 验证）。**无 wrapper-fanout，无 runtime 行为变更**。
- **PR-C**：wrapper-fanout NodeKind + schema + validator（含 boundary edges / shardSource / cartesian schema warning），**不接 scheduler**——纯 schema 落地 + validation。
- **PR-D**：scheduler 适配（reachable set / 聚合 agent runtime / signal port enforcement / cartesian runtime hard limit）。第一个**实际能跑 wrapper-fanout 端到端**的 PR。
- **PR-E**：断代 agent-multi + wrapper-git 升级 `list<path>`。**Breaking change PR**，需要把所有 agent-multi 引用 / git_diff string 假设全部清零。
- **PR-F**：frontend UI 收尾（wrapper-fanout 编辑器画布 chrome、cartesian warning 渲染、agent role 选项 polish）+ e2e + STATE.md 收尾。

每个 PR 自带测试 ≥ 阈值（见 plan.md）；六个 PR 都过 CI 后视为完工。
