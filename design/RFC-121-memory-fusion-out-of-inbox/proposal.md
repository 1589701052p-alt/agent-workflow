# RFC-121 记忆待办 / 融合待办移出收件箱，归并到记忆页面

> 状态：Draft
> 触发：2026-06-28 用户「记忆待办和融合待办不进收件箱，都收到记忆页面去」+ 两轮 AskUserQuestion 拍板（融合落点 = 记忆页新增独立 tab；侧栏记忆徽标计入融合）。

## 背景

当前**统一收件箱抽屉**（`InboxDrawer`，RFC-032）聚合了五类「待你处理」：

| tab | 数据源 | 受众 | 别处是否已有入口 |
|---|---|---|---|
| `reviews` | `/api/reviews?status=pending` | 任务成员 | `/reviews` 列表页 |
| `clarify` | `/api/clarify?status=awaiting_human` | 任务成员 | `/clarify` 列表页 |
| `fusion` | `/api/fusions?status=awaiting_approval` | admin / owner | **无**——唯一入口就是收件箱 |
| `memory` | `/api/memories?status=candidate`（admin-only） | admin | `/memory` 审批队列 tab |

其中 **fusion（融合待办）** 与 **memory（记忆待办）** 这两类，本质都属于「记忆/技能沉淀」域，与 reviews/clarify 这类「任务执行流程内的待处理」不同维度，混在同一个收件箱里使收件箱语义不纯，也让记忆相关的待办散落两处（记忆候选既在收件箱又在记忆页、融合只在收件箱）。

用户希望把这两类**从收件箱挪走，统一收到记忆页面**，让收件箱回归「任务流程待办（评审 + 反问）」，让记忆页成为「记忆/技能沉淀待办」的单一处理面。

## 目标

1. **收件箱只保留 reviews + clarify**：`InboxDrawer` 去掉 `fusion`、`memory` 两个 tab，`all` 聚合里不再出现这两类行。
2. **收件箱徽标去 fusion**：侧栏底部收件箱徽标（`InboxFooterButton`）= 待审 reviews + 待答 clarify，不再计入待审融合。（记忆候选本就不在此徽标内。）
3. **融合待办落到记忆页**：`/memory` 新增独立「融合」tab，列出 `awaiting_approval` 的融合，点击进 `/fusions/$id` 看 diff 审批。这也顺带补上了融合此前缺失的列表入口。
4. **记忆待办留在记忆页**：记忆候选已在 `/memory` 审批队列 tab，无需改动；只是不再于收件箱重复出现。
5. **侧栏「记忆」徽标计入融合待办**：侧栏记忆项徽标 = 待审记忆候选（admin-only，不变）+ 待审融合（admin/owner）。这样融合离开收件箱后侧栏仍有信号，且**有待办融合的 owner（非 admin）**也能在侧栏看到提示——弥补它从收件箱徽标移除后产生的信号缺口。

## 非目标

- **不做完整融合历史 / 状态过滤列表**：融合 tab 只列「待办」（`awaiting_approval`），与收件箱旧语义一致；running/done/rejected 的融合仍只能经直链 / 技能版本历史查看（与现状一致，无回归）。完整融合列表留作后续。
- **不动后端融合 / 记忆的可见性与 ACL**：沿用现状（融合 = admin 或 owner 可见；记忆候选审批 = admin / 资源 owner）。本 RFC **零后端 / API / schema / DB / migration 改动**。
- **不改首页「等你处理」预览**：`InboxPreviewList` 本就只含 reviews + clarify，无需改动。
- **不改融合详情页** `/fusions/$id` 本身的审批 / 退回 / 取消逻辑。

## 用户故事

- 作为**任务成员**，我打开收件箱只看到要我评审 / 反问的条目，不再被记忆候选、技能融合干扰，收件箱更短更聚焦。
- 作为**管理员**，我在侧栏「记忆」项上看到一个徽标，数字 = 待审记忆候选 + 待审融合；点进记忆页，「审批队列」tab 处理记忆候选，「融合」tab 处理技能融合——记忆/技能沉淀的所有待办集中在一个页面。
- 作为**发起了一次融合的普通成员（owner，非 admin）**，融合 diff 就绪后，我在侧栏「记忆」徽标看到提示（此前是收件箱徽标），点进记忆页「融合」tab 找到它、进详情审批。

## 验收标准

1. 收件箱抽屉只有 `all / reviews / clarify` 三个 tab；即便 `/api/fusions` 与 `/api/memories` 返回数据，收件箱（含 `all`）也不渲染任何 fusion / memory 行。
2. 收件箱徽标（footer）数字 = reviews + clarify 待办数；融合待办数不计入。
3. 记忆页出现第 5 个「融合」tab；点击后列出 `awaiting_approval` 融合，每行点击跳 `/fusions/$id`；无待办时显示空状态；接口失败显示可重试的错误。
4. 侧栏「记忆」徽标 = 待审记忆候选（admin）+ 待审融合（admin/owner）；非 admin 的 owner 有待办融合时该徽标出现。
5. `/fusions/*` 详情路由的侧栏分组高亮归到「记忆」组。
6. i18n zh / en 对称：新增 `memory.tab.fusion` + `memory.fusion.*`；清理因收件箱去 fusion/memory 而变死的 `nav.inbox.*` 键；所有 i18n parity / symmetry 测试绿。
7. `bun run typecheck && bun run test（前端 vitest）&& bun run format:check` 全绿；CI 全绿。
