# RFC-132 任务分解与 PR 拆分

> 配套 `proposal.md` / `design.md`。高风险（行为变更 + 20+ 调用点 + 双路径合一 + 迁移）——强序分批 + 每 PR golden/派生锁 + Codex adversarial gate（broker 恢复后）。

## 任务分解

### T1 — 平铺渲染纯函数 `renderFlatClarifyQueue`
- 输入 entries（问 + 答 + kind + manual_body），输出单一 `## Clarify Q&A` 平铺块：无轮次、无 sibling scope、无 directive trailer、零 attribution、顺序稳定（dispatched_at/id 序）。
- 单测：self/questioner/designer/manual 混合 golden；空队列→undefined；顺序稳定。
- 依赖：无。可独立落库（未接入）。

### T2 — 统一 selection + 派生老化 helper `selectAgentQueue`
- 抽 deferred selection（现 buildClarifyNodeQueueContext:618-716 ≈ buildNodeQueueExternalFeedback:1669-1803 的 ~60 行重复）：`task_questions` where effectiveTarget==node AND dispatched AND (sealed OR manual) → `!isTargetNodeConsumed` 过滤 → 回捞答案。
- **拆纯 select + 独立 bind**（可测）：`selectAgentQueue`（纯读）+ `bindTriggerRun`（写 trigger_run_id）。
- 单测：老化三态 / round N+1 / review-superseded / manual / sealed 过滤。
- 依赖：T1（渲染）无关，可并行。

### T3 — 统一注入器 `buildClarifyQueueContext` + scheduler 单调用
- 组装 T2（select+age+bind）+ T1（render）。签名见 design §2。
- scheduler XOR（`:2725-2822`）删除，替换单调用（design §3）。designer 进同 block（`crossClarifyContext` 独立分支删）。
- prior-output 后处理保留。
- 集成测试：scheduler runTask 多轮 self-clarify 平铺注入（保 `01KWDKBS`）+ designer+self 同 block。
- 依赖：T1、T2。**热点 scheduler，Codex gate 每轮。**

### T4 — 废弃 consumed_by 消费戳（全派生）
- 删 `markClarifyRoundsConsumedBy`（clarifyRounds.ts:106）+ runner 调用点；`consumed_by_*` 列停写（保列，design §9 回退安全）。
- 所有曾用戳的 non-deferred caller 改派生 `isTargetNodeConsumed`。
- 删 `rfc070-aging-stamp-grep-guards` 戳锁。
- 依赖：T3（注入统一后戳无 reader）。

### T5 — designer 渲染合并（External Feedback → 平铺块）
- 删 `buildExternalFeedbackBlock`（shared/clarify.ts:453）+ `## External Feedback` / `{{__external_feedback__}}` token；designer 走 T1 平铺块。
- **前置审**：agent inventory / prompt 模板是否硬依赖 `## External Feedback` 字面（design §10 失败模式）——有则先改模板。
- graphOwned / sourcesCsv / manual：并入平铺条目（design §5）。
- 依赖：T3。

### T6 — 自动下发（quick-channel 收敛）+ 迁移垫片
- `submitClarifyAnswers` / `sealRoundQuestions` 成功路径末尾自动调 `dispatchTaskQuestions`（设 dispatched_at + 节点反问状态 + mint 承接 rerun）——与显式下发同代码（design §6）。
- 删 quick-channel 即时 mint continuation + 整轮注入（RFC-125 路径）。
- 迁移垫片：在飞 non-deferred round（无 dispatched_at）升级后 selection 容忍/补下发（design §9）。
- 集成：非 deferred 答完自动继续（UX 等价旧 quick-channel）。
- 依赖：T3、T4。

### T7 — 节点反问状态收敛（per-round directive → 节点状态）
- `continue`/`stop` 唯一存 `task_node_clarify_directives`；下发时设。
- `clarify_rounds.directive` 停止驱动注入（降级历史）。
- persistent-stop（scheduler）数据源收敛为节点状态。
- 依赖：T6（下发即设 directive）。

### T8 — 废弃 flag + 死代码清理
- `deferredQuestionDispatch` flag 停读（列保留）。
- 删死代码：`buildPromptContext` cross-designer 分支 + `selectAnsweredRoundsForConsumer` cross-designer arm + `buildQuestionerCrossClarifyContext`（crossClarify.ts:1876，仅测试引用）。
- 旧注入器 `buildClarifyNodeQueueContext` / `buildNodeQueueExternalFeedback` / `buildPromptContext`：若已无 reader→删；否则降为 thin wrapper 转调 `buildClarifyQueueContext`（渐进）。
- 依赖：T3-T7。

### T9 — golden-lock 处理 + 回归网
- 删整轮 byte-for-byte 锁（`rfc128-p5-bc:482` 那批）+ 戳锁（T4 已删）。
- 新增平铺渲染 golden 锁（T1）+ 扩展派生老化锁（RFC-131 套件）。
- 迁移回归：在飞任务升级不丢答案。
- 依赖：T1-T8。

## PR 拆分建议

| PR | 内容 | 风险 |
|----|------|------|
| PR-1 | T1 + T2（纯函数/helper + 单测，未接入） | 低 |
| PR-2 | T3（统一注入器 + scheduler 单调用） | 🔴 高（热点调度器 + 行为变更） |
| PR-3 | T4 + T7（戳废弃 + directive 收敛） | 🟡 中 |
| PR-4 | T5（designer 渲染合并 + 模板审） | 🟡 中（agent prompt 结构变） |
| PR-5 | T6（自动下发 + 迁移垫片） | 🔴 高（quick-channel 合一 + 在飞迁移） |
| PR-6 | T8 + T9（死代码/flag 清理 + golden 网） | 🟡 中 |

每 PR 独立门禁（typecheck + test + format + 单二进制 smoke + Codex impl gate）+ CI 绿。**PR-2/PR-5 强制 Codex adversarial gate**（热点 + 迁移）。

## 依赖图

```
T1 ─┐
T2 ─┴→ T3 ─┬→ T4 ─→ (T7)
           ├→ T5
           └→ T6 ─→ T7
   T4..T7 ─────────→ T8 ─→ T9
```

## 验收清单（交付前必绿）

- [ ] 单一注入器 `buildClarifyQueueContext` 覆盖 self/questioner/designer；4 条旧选路收敛（无平行 fork）
- [ ] 单一派生判据；consumed_by 戳 + markClarifyRoundsConsumedBy 废弃
- [ ] 单一平铺渲染块；无 `### Round N`/历史轮/sibling scope；designer 无独立 External Feedback
- [ ] 节点反问状态唯一（下发时设）；无 per-round directive
- [ ] deferredQuestionDispatch flag 停读；quick-channel 收敛为自动下发（UX 等价）
- [ ] 行为保持：多轮丢历史修复 / 老化 / review-reject 老化 / prior-output / 借壳改派
- [ ] 迁移：在飞 deferred + non-deferred 任务不丢答案、不错误重问
- [ ] 死代码清理（cross-designer 分支 + buildQuestionerCrossClarifyContext）
- [ ] 平铺 golden 锁新增；整轮/戳锁删除无悬空
- [ ] typecheck×3 + 全量 backend test + format + 单二进制 smoke + CI 全绿 + Codex gate（broker 恢复）

## 风险与缓解

- **热点 scheduler（PR-2）**：Codex adversarial impl gate 每轮 + 分批小步 + 派生老化锁兜底。
- **designer prompt 结构变（PR-4）**：前置审 agent 模板/inventory 对 `## External Feedback` 的依赖；有依赖先改模板。
- **quick-channel 合一 + 在飞迁移（PR-5）**：迁移垫片 + 自动下发复用 dispatch in-flight gate；e2e 覆盖非 deferred 自问自答等价。
- **golden 行为变更**：平铺是**有意变更**（proposal 验收 #7）——删旧整轮锁、立平铺新锁，PR 说明清「哪些是有意变更、哪些必须等价」。
- **回退**：schema 废弃列不删（consumed_by / directive / flag 保留），回退到旧代码即恢复双路径；本 RFC 不含删列（后续清列 RFC）。
- **Codex gate 缺**：broker.sock 挂时以本地全量 + golden + 派生锁兜底，broker 恢复补审 PR-2/PR-5。
