# Codex 核验：Fan-out / wrapper 与分片 (03-fanout-wrappers)

> 对应报告：`design/arch-audit-2026-06-23/03-fanout-wrappers.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **FANW-D2 / FANW-X1 属实，P1 合理**：fanout 入口直接 `split('\n').trim().filter(...)`，会丢空项、拆多行项；且 shardKey 又在 registry 另一处解析。证据：`packages/backend/src/services/scheduler.ts:3129-3132`、`packages/backend/src/services/scheduler.ts:3170-3182`、`packages/shared/src/shardingRegistry.ts:56-64`。更严重的是仓内已有 `list<markdown>` 边界编码工具，但 fanout 没用：`packages/shared/src/listWire.ts:17-22`、`packages/shared/src/listWire.ts:41-73`。
- **FANW-D3 / X4 / X5 属实**：权威 `design.md` 仍写已删除的 `agent-multi`、`ShardingStrategy`、`GitHelper.split`；旧 `diffSplit.ts` 仍在但不走生产 fanout；i18n 仍保留 shardingStrategy 文案且组件无引用。证据：`design/design.md:580-596`、`design/design.md:655-658`、`design/design.md:767-787`、`packages/backend/src/services/scheduler.ts:4227-4229`、`packages/backend/src/util/diffSplit.ts:1-7`、`packages/frontend/src/i18n/zh-CN.ts:1432-1443`、`packages/frontend/src/i18n/en-US.ts:1507-1519`。
- **FANW-X2 属实，但应定位为 P1 扩展性阻塞，不是当前 bug**：validator 明确把 fanout 内非 aggregator 链路作为启动前错误，因为运行时 `resolveUpstreamInputs` 只选 top-level done rows。证据：`packages/backend/src/services/workflow.validator.ts:432-461`、`packages/backend/src/services/scheduler.ts:4449-4482`、`packages/backend/src/services/scheduler.ts:4537-4538`。
- **FANW-X3 属实，但“任意 wrapper 嵌套”是产品承诺与 v1 实现边界冲突**：loop 嵌套被传递闭包禁止，原因是裸 `iteration` 轴。证据：`packages/backend/src/services/workflow.validator.ts:251-277`、`CLAUDE.md:140-143`。
- **FANW-D1 / C2 大体属实，严重级 P2 合理**：三类 wrapper 调度入口确实分散；fanout shard/aggregator 与单节点 `runNode` 装配重复，且 clarify/review 明确关闭。证据：`packages/backend/src/services/scheduler.ts:1486-1493`、`packages/backend/src/services/scheduler.ts:2745`、`packages/backend/src/services/scheduler.ts:2948`、`packages/backend/src/services/scheduler.ts:4038`、`packages/backend/src/services/scheduler.ts:3445-3449`、`packages/backend/src/services/scheduler.ts:3662`、`packages/backend/src/services/scheduler.ts:3919`。
- **FANW-D4 属实但非新缺陷**：fail-all-after-join 与文档 deferred 一致。证据：`packages/backend/src/services/scheduler.ts:3281-3290`、`design/design.md:777-787`。
- **FANW-D5 属实，P3 合理**：`expectedShardCount` 只服务嵌套 fanout 估算，但嵌套/非 agent-single 会被运行时拒绝。证据：`packages/backend/src/services/fanout.ts:155-174`、`packages/shared/src/schemas/workflow.ts:437-445`、`packages/backend/src/services/scheduler.ts:3198-3210`。
- **FANW-IMPL1 只属文档漂移**：实现的 node_run=`exhausted`、任务返回 failed 与 CLAUDE 勘误一致；不是实现 bug。证据：`packages/backend/src/services/scheduler.ts:2921-2927`、`design/design.md:808-810`、`CLAUDE.md:143`。
- **FANW-IMPL3 / C1 / X6 / T1 / T2 / O1 基本属实但低优**：O(V·E)、`Record<string, unknown>`、单 aggregator 契约、换行 split 无专门回归、文档/i18n 漂移无守卫、fanout 汇总观测弱，证据分别见 `packages/backend/src/services/fanout.ts:86`、`packages/shared/src/wrapperFanout.ts:38-49`、`packages/shared/src/wrapperFanout.ts:67-130`、`packages/backend/src/services/scheduler.ts:3388-3393`。

## REFUTED / 伪问题（给反证 file:line）

- **FANW-IMPL2 的“shared inner 误接 shardSource 会复制第一个 shard 值”不成立**：代码在 `shard === null` 时不注入 shard 值；而且普通 inner 只要接了 shardSource boundary edge，就会被 scope seed 归入 perShard，不是 shared。反证：`packages/backend/src/services/scheduler.ts:3570-3576`、`packages/backend/src/services/fanout.ts:68-77`。成立的部分只是注释错误：`packages/backend/src/services/scheduler.ts:3292-3298`。
- **“加 WRAPPER_KINDS 常量”作为全新建议部分过时**：backend 已有 `WRAPPER_KINDS` 并用于 frontier；但前端和部分 validator/scheduler 分支仍有三连判。反证：`packages/backend/src/services/dispatchFrontier.ts:50-53`；残留证据：`packages/frontend/src/components/canvas/wrapperMembership.ts:85`、`packages/backend/src/services/workflow.validator.ts:236-240`。
- **“fanout nested 只需要实现 estimateShardTotal 就能支持”隐含不成立**：当前设计明确是 validator warning + runtime hard reject 的 v1 边界，不能把死字段单独当成可安全启用的实现缺口。反证：`packages/backend/src/services/scheduler.ts:2933-2940`、`packages/backend/src/services/scheduler.ts:3198-3210`。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **Aggregator 可接 wrapper-input boundary 但运行时完全忽略 — High — `packages/backend/src/services/workflow.validator.ts:1307-1329`, `packages/backend/src/services/workflow.validator.ts:1373-1387`, `packages/backend/src/services/scheduler.ts:3731-3752` — validator 允许 boundary-input 指向 fanout 内任意节点，包括 aggregator；prompt 校验也会认为该端口已入边满足。但 aggregator 派发只收非 boundary 的 inner-to-inner 边，直接 wiring `wrapper.shardSource -> aggregator.docs` 会验证通过、运行为空输入，属于 green 但错数据。**
- **fanout 输入 declared kind 与真实上游 output kind 无兼容校验 — Medium — `packages/backend/src/services/workflow.validator.ts:376-430`, `packages/backend/src/services/workflow.validator.ts:195-222`, `packages/backend/src/services/scheduler.ts:2966-2974` — validator 只校验端口存在和 fanout 自声明 `list<T>`，不校验上游实际输出 kind；运行时按 fanout 声明的 itemKind 做 split/keyOf，接错 `list<markdown>`/`list<path<md>>`/普通 string 时会静默按错误协议消费。**
- **已有 list wire codec 未纳入 fanout 单一协议 — Medium — `packages/shared/src/listWire.ts:17-22`, `packages/shared/src/listWire.ts:55-73`, `packages/backend/src/services/scheduler.ts:3129-3132` — 报告说需要新建编解码中心，但仓内已出现中心雏形；真正漏点是 fanout 没复用它，导致 review 的 `list<markdown>` 边界编码到 fanout 处退化成按行拆。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的目标形态方向对，但第 2 点“per-shard 走 runScope + scope 路径栈 + 任意嵌套一次到位”过大，容易同时触碰 RFC-097 状态机 CAS、retry/freshness、review/clarify、node_run 坐标模型。更稳的顺序应是：

1. 先做 **列表协议收敛**：让 fanout 使用现有 `listWire`，按 kind 选择 `splitListItems` / `splitMarkdownDocs`，再把 `encode/decode/keyOf` 收进 registry。
2. 再补 **validator 类型与 boundary 规则**：禁止 aggregator 直接接 wrapper-input；校验 fanout input kind 与上游 output kind 兼容。
3. 再抽 **dispatchAgentNode** 去重，保持现有 node_run 状态机与 opencode env 合并路径不变，只减少 fanout shard/aggregator/单节点三处漂移。
4. 最后另立 RFC 做 **scope path / per-shard runScope**。这是 schema/freshness 级迁移，不应作为普通重构夹带。

WrapperRunner 可以做，但不要先抽象后改行为；先把已知重复参数装配和 wrapper kind 集合收敛，避免破坏 RFC-098/097 已锁住的不变量。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：报告的主要证据真实、方向正确，但把若干 v1 有意禁入边界写得像当前 bug，并漏掉了 aggregator boundary-input 与 kind 不兼容这类更具体的静默错数据问题。
