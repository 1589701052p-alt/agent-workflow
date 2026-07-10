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
- **RFC-163-T4b（Codex 设计门 P2 · 实现期勘误——降级不变式，不加守卫）**：初版「service 加
  asker-dispatched 409 守卫 + 详情页门收紧」打红 **19 个存量 cross-designer 场景测试**——「答完/
  asker 已下发后让上游修订」是 RFC-162 一等流程（quick 通道答完即自动下发）。终解＝Codex 第二解法：
  **不加守卫**、`ClarifyQuestionHandler` 保持 `phase !== 'done'`；「已下发 asker + 未下发 designer」
  ＝修订流常态（分组域只含未下发条目 ⇒ 新 designer 自成待指派单卡，case-4，下发经级联再跑 asker）。
  锁：dispatched asker 改派 → added-designer/未下发/asker 不动 + 撤回修订可删 designer + 详情页
  processing/awaiting_confirm 仍可改派（三者注明防回退意图）。
- **RFC-163-T5（i18n + CSS）**：handler 行标签（提问节点/上游/下游/手动）双语 key；分组卡 `.task-
  questions__card-handlers` 之类命名空间样式（最小、贴既有）。
- **RFC-163-T6（组件测试 + 源码锁）**：改派不新增卡（同卡 +1 行）/ 组级 stage 调用次数 / 批量下发
  展开 / 下发后拆开；源码文本锁「未下发列走 `groupBoardEntries`」。
- **RFC-163-T7（门禁 + 收尾）**：typecheck/lint/format/前端 vitest/binary smoke；Codex 设计门 +
  实现门；`STATE.md` / `design/plan.md` 索引 Draft→Done。

## 依赖序

T1 → T2 → (T3, T4, T5 并行) → T6 → T7。

## 验收清单

- [x] AC-1 下发前同问题未下发条目收拢一张卡；改派＝卡内增/删一行、卡数不变（lib case-2 + 组件测试）
- [x] AC-2 下发后各处理节点各自单卡、可分别确认（lib case-3 + 组件「下发后拆开」测试）
- [x] AC-3 stage/批量下发组级；不可只下发提问节点遗漏共存上游（组级 stage 调用数 + 批量下发展开
      整组〔含 off-filter 兄弟〕测试；P1 先分组后过滤）
- [x] AC-4 manual / 单处理节点仍单卡（lib case-1/5）
- [x] AC-5 filter/计数对齐（per-handler chip 计数不变；命中任一 handler ⇒ 整组保留）
- [x] AC-6 门禁四项 + 前端 vitest（typecheck×3/lint 0/format/后端全量 0 fail/前端 3253-0/binary smoke）
- [x] AC-7 复用公共原语（Card/StatusChip/Select/.btn；handlers 行贴 meta 语汇）、视觉明暗 repro 核验
- [x] Codex 设计门（2 findings 修：P1 落地；P2 实现期勘误为降级不变式——初版守卫打红 19 存量测试撤销，
      三枚反向回归锁）；实现门 Codex runtime 连续空响应（"Reviewer failed to output a response"×2），
      以 19-测回归信号 + 全门禁 + CI 代偿，恢复后可补审
- [x] STATE.md / design/plan.md 索引更新

## 风险与回滚

- 纯前端、单组件、单 PR，可整体回滚。最高风险＝分组与相位分列的边界（混态/竞态）——由 §2 保守落列
  + T1 逐格单测钉死。组级 stage 是唯一「行为微调」（一张卡一个 stage 动作），与 RFC-162 统一下发一致、
  且顺带修 board 手动路径的部分下发隐患。
