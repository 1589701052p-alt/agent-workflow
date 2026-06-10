# RFC-094 — 技术设计

行号基线：`4d69670`（2026-06-11）。

## 1. validator 新规则（workflow.validator.ts）

### 1.1 `wrapper-loop-nested`（S-6 禁入，error）

位置：`innerToWrapper` 建好之后（:229-247 后）的规则区。对每个 `wrapper-loop` 节点沿
`innerToWrapper` 链上溯；任何祖先（不限直接父级——loop→git→loop / loop→fanout→loop 同样命中
S-6 的迭代轴冲突）为 `wrapper-loop` 即 push error：

```
code: 'wrapper-loop-nested'
message: wrapper-loop '<id>' is nested inside wrapper-loop '<ancestor>' — inner iterations
  silently no-op from the outer loop's 2nd round (audit S-6, scheduler-audit-s06); restructure
  to a single loop until nested-loop support lands (WP-6c)
```

注意与 :160-182 的 `wrapper-fanout-nested`（warning）形成对照：fanout 嵌 fanout 是成本提示，
loop 嵌 loop 是正确性破碎，必须 error。上溯走 `innerToWrapper`（不重复 :169 的全表扫描），
环防御：步数上限 nodes.length。

### 1.2 `fanout-inner-chain-unsupported`（S-5 禁入，error）

位置：边规则区。判定：**非 boundary** 边（`edge.boundary === undefined`），且
`innerToWrapper.get(source.nodeId)` 与 `innerToWrapper.get(target.nodeId)` 相等且非空，且该
容器 kind === 'wrapper-fanout'，且 target **不是** aggregator（`target.kind === 'agent-single'
∧ agentByName.get(agentName)?.role === 'aggregator'` 为 false），且不是 clarify 通道边——
豁免条件：source/target 任一端 kind ∈ {clarify, clarify-cross-agent}，或 source.portName 为
`__clarify__`，或 target.portName ∈ {`__clarify_response__`, `__external_feedback__`}。

```
code: 'fanout-inner-chain-unsupported'
message: edge '<id>' chains inner node '<src>' into non-aggregator inner node '<tgt>' inside
  wrapper-fanout '<wrapper>' — per-shard chains are not yet dispatched (the target reads an
  EMPTY port at runtime, audit S-5 / scheduler-audit-s05); route the result through the
  aggregator or split into sequential fanouts
```

inner→aggregator 边保持合法（聚合输入正是这么接的）；跨 fanout（source/target 分属不同
wrapper 或一端在顶层）不归本规则（boundary 规则与既有规则覆盖）。

### 1.3 ⑥-9 修复：规则 2 对 boundary 边豁免 source-port 检查

:346-372 的 edge-port-existence 循环开头：`if (edge.boundary === 'wrapper-input') continue`
之于 source 检查——精确做法是仅跳过 **source-port** 检查（target 侧检查保留，但
boundary='wrapper-input' 的 target 是 inner 节点，本就不会命中 output/wrapper-git/loop 分支；
boundary='wrapper-output' 的 source 是 aggregator agent-single，generic 检查可以正确通过，
不豁免）。即：

```ts
if (edge.boundary !== 'wrapper-input') {
  const outs = outputPorts.get(src.id) ?? new Set()
  if (!outs.has(edge.source.portName)) { …edge-source-port-missing… }
}
```

`boundary-input-port-not-declared`（:1244-1251）继续做该类边的精确 source 校验——职责单一，
不在端口收集 switch 里给 wrapper-fanout 造"伪输出端口集"（那会让非 boundary 的
wrapper→任意节点 边被错误放行）。

## 2. S-18 归一（默认方案 A）

- design/design.md fanout「失败语义」段改写：v1 = **fail-all-after-join**——所有 shard 跑完
  （join）后只要存在失败 shard，wrapper 整体 failed、跳过聚合、不写 outlet；errors port
  未实现。原"只看 done shard 聚合、全失败才 failed、自动 errors port"的描述标注为
  deferred（WP-6b 产品决策）。
- scheduler.ts:2763 一带 "fails-fast" 注释改为 "fail-all-after-join" 的准确描述并链
  scheduler-audit-s18 测试。
- 若批准时选方案 B：本节改为占位（另立 RFC-095），本 RFC 仅落 1/3/4 节。

## 3. S-26 注释清账（纯注释；实现时逐处核对现行行号）

| 位置                                                 | 问题                                                                                   | 改法                                                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| dispatchFrontier.ts:1-33 头部                        | "PURE, currently UNWIRED"；"runScope wiring … are PR-B (deferred)"                     | 改为：PR-B 已上线（runScope 经 deriveFrontier 消费本模块），保留设计编号注解，指向 derive-frontier.test.ts / dispatch-frontier.test.ts |
| scheduler.ts deriveFrontier 前注释块（原 :992-1005） | "PURE, currently UNWIRED … NOT yet called by runScope"                                 | 改为现状描述（runScope :620 每 tick 调用；RFC-092 增加 pending 锚点豁免）                                                              |
| scheduler.ts 原 :2211-2214 一带                      | 引用已删除的 rescanScopeForNewPendingRows 作为现行机制                                 | 改为引用 deriveFrontier / wrapperHasFreshInnerWork 的准确描述                                                                          |
| wrapperProgress.ts:9-13                              | wrapper 复活协议描述与 RFC-076 后现实不符                                              | 按 findResumableWrapperRun + isDispatchable(wrapper awaiting\_\*) 现实改写，链 scheduler-audit-s03                                     |
| review.ts:307 一带                                   | 描述引用废弃比较器口径                                                                 | 改为 isFresherNodeRun（纯 id 序）口径                                                                                                  |
| derive-frontier.test.ts 头部                         | "Currently UNWIRED — these validate the brain before the runScope rewrite wires it in" | 改为"已上线；本文件是 deriveFrontier 的纯函数锁"                                                                                       |

附带核查项：`freshness.ts` 的 `computeReadyNodes` 若全仓（src + tests）零引用则随注释清账
删除（孤儿抽取，审计 S-26 备注）；有引用则保留并补一行现状注释。**删除前必须 grep 证实零引用，
有任何引用即不删。**

## 4. 失败模式

| 风险                                  | 缓解                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 error 规则误伤既有合法工作流       | 错误只阻启动不阻保存（task.ts:408-422 既有门控）；豁免集（aggregator 目标 / clarify 通道 / boundary）逐条配反例测试；全量套件回归（既有 fanout/loop e2e 工作流若被新规则命中即测试红 → 修规则而非测试） |
| ⑥-9 豁免过宽（boundary 伪边绕过校验） | 仅豁免 `boundary === 'wrapper-input'` 的 source-port 检查；该类边的 source 端口由规则 4 `boundary-input-port-not-declared` 精确校验，且 `boundary-input-target-not-inner` 校验内向性                    |
| s05/s06 audit 锁定与新规则冲突        | s05 validator 层按其头指引翻转；s05/s06 运行时层走 runTask 不经 validator 门，不受影响（实现时跑通确认）                                                                                                |
| 注释清账误删生产代码                  | computeReadyNodes 删除有零引用 grep 前置条件；其余全部纯注释 diff                                                                                                                                       |

## 5. 测试策略

1. 新增 `rfc094-validator-guardrails.test.ts`：
   - loop 嵌 loop：直接嵌套 → error；隔 git 传递嵌套（loop→git→loop）→ error；loop→git、
     git→loop、fanout→loop、loop→fanout 单向组合 → 无此 error。
   - fanout inner-chain：inner A→B（B 非 aggregator）→ error；inner→aggregator → 无；
     clarify 通道边（inner agent.**clarify** → 同 fanout 内 clarify.questions）→ 无；
     boundary='wrapper-input' / 'wrapper-output' 边 → 无。
   - ⑥-9 回归：带 boundary='wrapper-input' 边的合法 fanout 工作流 → 零 error（含
     `edge-source-port-missing` 不出现）；source 端口未在 inputs[] 声明时仍报
     `boundary-input-port-not-declared`（规则 4 职责未被豁免掉）。
2. 翻转 `scheduler-audit-s05-fanout-inner-chain.test.ts` validator 层两条（eChain → 期望
   `fanout-inner-chain-unsupported`；boundary 误报 characterization → 期望消失）。
3. `scheduler-audit-s06-*` / s05 运行时层：跑通确认不受影响（不改动）。
4. S-18 方案 A：`scheduler-audit-s18-*` 文件头注释同步（设计文档已固化 fail-all，"翻转指引"
   改为指向 WP-6b 产品决策）；断言本体不动（仍锁 fail-all 现状，现在与文档一致）。
5. S-26：若删 computeReadyNodes，跑全量证零破坏；注释 diff 由 prettier + 全量套件兜底。
