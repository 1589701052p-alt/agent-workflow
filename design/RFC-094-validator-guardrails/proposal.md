# RFC-094 — validator 守门：禁入已知破碎拓扑 + boundary 边误报修复 + 失实注释清账

> 状态：Draft。来源：`design/scheduler-audit-2026-06-10.md` 改进路线 **WP-6a**（含缺口 ⑥-9 与
> S-26 收尾、S-18 文档归一）。触发：2026-06-11 用户「继续」（WP 队列推进）。

## 背景

调研确认两类拓扑在当前运行时**静默产出错误结果**，而 validator 零规则放行：

- **S-6（P1）**：loop 嵌 loop——node_runs 行键 `(taskId, nodeId, iteration)` 没有父作用域轴，
  外层第 2 轮起内层 frontier 命中第 1 轮的 done 行 → 内层整体 no-op，任务正常 done 但结果是
  旧数据。现状已被 `scheduler-audit-s06-nested-loop-inner-noop.test.ts` 锁定。根治（行键加
  scopePath）是大改造（WP-6c/RFC 另立）；在那之前 validator 必须把这类工作流挡在启动门外。
- **S-5（P1）**：fanout 内 per-shard 链 A→B（B 非 aggregator）——scope 计算侧支持链式
  promote，但派发侧 `resolveUpstreamInputs` 过滤掉全部 shard child 行，B 的对应端口被渲染成
  空字符串，任务全绿产出垃圾。现状已被 `scheduler-audit-s05-fanout-inner-chain.test.ts` 锁定
  （其 validator 层用例文件头写明"修复 WP-6a 时应翻为 error"）。
- **⑥-9（测试网落地时新发现）**：validator 规则 2（edge-port-existence）对 `boundary:
'wrapper-input'` 边误报 `edge-source-port-missing`——这种边的 source 就是 fanout wrapper
  本体（wrapper 输入口向内转发），而端口收集 switch 无 `wrapper-fanout` case → 输出端口集
  恒空。规则 4 的 `boundary-input-port-not-declared` 本就对这种边做精确校验，规则 2 属双重
  校验缺豁免。**误报是 error 级，会卡死所有带 boundary 边 fanout 工作流的 createTask 门**。
- **S-18（P2）文档-实现矛盾**：fanout 失败语义实现为 fail-all-after-join（任一 shard 失败 →
  整 wrapper failed、跳过聚合），设计文档却承诺部分容忍 + errors port；scheduler.ts 注释还
  自称 "fails-fast"（也不准确）。
- **S-26（P2）失实注释**：RFC-076 留下成体系腐化注释——dispatchFrontier.ts 头部与
  scheduler.ts deriveFrontier 块仍称 "PURE, currently UNWIRED / NOT yet called by runScope"
  （实际早已是生产派发路径）、对已删除的 `rescanScopeForNewPendingRows` 的安全论证引用、
  wrapperProgress.ts 复活协议描述与现实不符、review.ts 引用废弃比较器。routes/clarify.ts 与
  reviews.ts 两处已在 RFC-092 修正，其余在本 RFC 清账。

## 目标

1. validator 新增两条 **error** 级规则：loop（传递）嵌 loop；fanout 内 inner→inner 数据边
   （target 非 aggregator）。错误信息指明根因（S-6/S-5）与替代写法。
2. 修复 ⑥-9：规则 2 对 boundary 边不再误报（boundary 边由规则 4 精确校验）。
3. S-18 归一（默认推荐 **方案 A**，最终以批准时用户选择为准）：
   - 方案 A（文档固化现状）：design/design.md fanout 失败语义改写为「v1 = fail-all-after-join
     （只要有 shard 失败即整体失败、跳过聚合；errors port 未实现）」，修正 scheduler.ts:2763
     一带 "fails-fast" 注释；部分容忍 + errors port 作为产品决策挂入 WP-6b 待办。
   - 方案 B（实现部分容忍）：按 RFC-060 §7.5 落地 done-only 聚合 + errors port——工作量与
     回归面大，建议另立 RFC 而不并入本包。
4. S-26 失实注释清账（纯注释，零行为变化）。

## 非目标

- 不动运行时调度行为（S-5/S-6 的根治分别归 WP-6b/6c）。
- 不动既有 warning 级规则（wrapper-fanout-nested 警告保持警告——其语义是成本提示而非破碎）。
- 不改 validator 的"错误阻止启动、不阻止保存"门控位置（task.ts:408-422 不动）。
- clarify / cross-clarify 通道边（`__clarify__` / `questions` / `answers` / `to_*`）不受
  inner-to-inner 新规则影响（显式豁免——通道边本就不参与数据派发）。

## 用户故事

1. 我在画布上把 loop 拖进另一个 loop：保存正常（草稿不受阻），启动任务时被明确告知「loop 嵌
   loop 在当前版本会导致外层第 2 轮起内层不执行（审计 S-6），请改用单层 loop 或等待 WP-6c」，
   而不是任务静默跑出旧数据。
2. 我在 fanout 里画了 audit→fix 链：启动时被告知「fanout 内 per-shard 链尚不支持（审计
   S-5），fix 会收到空输入；请把 fix 提为 aggregator 或拆成两级 fanout」。
3. 我画了一个正常的 git→fanout 工作流（boundary 边）：不再被 `edge-source-port-missing`
   误杀，任务正常启动。

## 验收标准

- [ ] 新增 validator 测试：loop 嵌 loop（直接 + 隔层传递）→ error；loop 嵌 git / git 嵌 loop /
      fanout 嵌 loop → 不误伤；fanout inner→inner 数据边 → error；inner→aggregator 边、
      clarify 通道边、boundary 边 → 不误伤。
- [ ] `scheduler-audit-s05-*` validator 层两条按头指引翻转（eChain → error；boundary 边误报
      → 消失）；运行时层现状锁定保持不变（S-5 根治前仍锁空输入现状）。
- [ ] `scheduler-audit-s06-*` 不受影响（运行时现状锁定；其工作流不过 validator 门）。
- [ ] S-18 按所选方案落地（A：design.md + 注释；B：另立 RFC 占位）。
- [ ] S-26 清单内注释全部修正，且 `scheduler-audit-s13-*`/既有源码守卫不受扰。
- [ ] `bun run typecheck` + 根 `bun test` + `bun run format:check` 全绿；CI 全绿。
