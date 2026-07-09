# RFC-163 任务分解

单 PR（纯前端，无 migration、无后端契约变更）。

## 子任务

- **RFC-163-T1（纯函数 + 单测）**：`groupBoardEntries(entries) → BoardCard[]`（未下发按
  `(originNodeRunId, questionId)` 聚合、已下发/manual 各自单卡、handlers 保序、卡 phase 派生）。
  逐格单测（design §5 的 7 个 case）。**先行**——它是单一事实源。
- **RFC-163-T2（TaskQuestionList 接线）**：未下发列渲染改走 `groupBoardEntries`；分组卡布局（问题
  标题 + handler 行列表，每行 target 节点标签 + 相位/角色 chip）；已下发列保持 per-entry 单卡。复用
  `Card` / `StatusChip` / `.btn--sm/xs`，不自写 chrome。
- **RFC-163-T3（卡级动作编排）**：stage 组级（`Promise.all` 对全部 handler 调 `/stage`）；批量下发
  `entryIds` 从 staged 卡展开全部 handler id；改派 `Select` 作用于提问节点条目（manual 作用自身）；
  confirm 仅已下发单卡。
- **RFC-163-T4（filter/计数对齐）**：**先分组后按组过滤**（filter 命中任一 handler ⇒ 整组保留 +
  下发全套；**不**先滤条目——否则批量下发只发命中 id、部分下发，Codex 设计门 P1）；chip 计数不变
  （per-handler）；dispatch `entryIds` 来自未裁剪的整组。
- **RFC-163-T4b（后端守卫 + 前端门对齐 · Codex 设计门 P2）**：`reassignTaskQuestion` add-designer
  分支加「提问条目 `dispatched_at IS NOT NULL` ⇒ 拒（`task-question-asker-dispatched`）」；
  `ClarifyQuestionHandler.editable` 收紧为 `phase ∈ {pending,staged}`。后端 409 用例 + 前端不可改派
  断言。使 §1「改派仅下发前」不变式成立。
- **RFC-163-T5（i18n + CSS）**：handler 行标签（提问节点/上游/下游/手动）双语 key；分组卡 `.task-
  questions__card-handlers` 之类命名空间样式（最小、贴既有）。
- **RFC-163-T6（组件测试 + 源码锁）**：改派不新增卡（同卡 +1 行）/ 组级 stage 调用次数 / 批量下发
  展开 / 下发后拆开；源码文本锁「未下发列走 `groupBoardEntries`」。
- **RFC-163-T7（门禁 + 收尾）**：typecheck/lint/format/前端 vitest/binary smoke；Codex 设计门 +
  实现门；`STATE.md` / `design/plan.md` 索引 Draft→Done。

## 依赖序

T1 → T2 → (T3, T4, T5 并行) → T6 → T7。

## 验收清单

- [ ] AC-1 下发前同问题未下发条目收拢一张卡；改派＝卡内增/删一行、卡数不变
- [ ] AC-2 下发后各处理节点各自单卡、可分别确认
- [ ] AC-3 stage/批量下发组级；不可只下发提问节点遗漏共存上游
- [ ] AC-4 manual / 单处理节点仍单卡
- [ ] AC-5 filter/计数对齐（per-handler 计数不变、命中展示整组）
- [ ] AC-6 门禁四项 + 前端 vitest
- [ ] AC-7 复用公共原语、视觉对齐
- [ ] Codex 设计门（落档后）+ 实现门
- [ ] STATE.md / design/plan.md 索引更新

## 风险与回滚

- 纯前端、单组件、单 PR，可整体回滚。最高风险＝分组与相位分列的边界（混态/竞态）——由 §2 保守落列
  + T1 逐格单测钉死。组级 stage 是唯一「行为微调」（一张卡一个 stage 动作），与 RFC-162 统一下发一致、
  且顺带修 board 手动路径的部分下发隐患。
