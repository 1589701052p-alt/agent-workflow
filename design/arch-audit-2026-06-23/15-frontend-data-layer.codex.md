# Codex 核验：前端：数据层 (15-frontend-data-layer)

> 对应报告：`design/arch-audit-2026-06-23/15-frontend-data-layer.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- FDL-01 属实，P2 合理：`useTaskSync` / `useTasksSync` / `useWorkflowSync` / `useClarifyWs` / `useMemoryWs` / `useMemoryDistillJobWs` 都是 `useWebSocket + onMessage + invalidateQueries` 手写映射，见 `packages/frontend/src/hooks/useTaskSync.ts:12`、`useTasksSync.ts:12`、`useWorkflowSync.ts:31`、`useClarifyWs.ts:39`、`useMemoryWs.ts:34`、`useMemoryDistillJobWs.ts:28`。
- FDL-02/03/09 主结论属实，P1 合理：后端 WS 只有 task/tasks-list/workflows/repo-import/memories/distill 六类，无 fusion/inbox 聚合 channel，见 `packages/backend/src/ws/server.ts:120`、`packages/backend/src/ws/broadcaster.ts:63`；root shell 没有挂全局 sync hook，见 `packages/frontend/src/routes/__root.tsx:43`；fusion 详情靠 `refetchInterval`，见 `packages/frontend/src/routes/fusions.detail.tsx:36`。
- FDL-04/10 主结论属实但需修正措辞：review/clarify 的 inbox/homepage/list/detail/pending-count key 家族确实碎片化，见 `InboxDrawer.tsx:51`、`InboxPreviewList.tsx:24`、`InboxFooterButton.tsx:26`、`useTaskSync.ts:50`。但 pending-count 并非“没被 WS 覆盖”，`useTaskSync` 已 invalidate `['reviews','pending-count']` 和 `['clarify','pending-count']`，见 `packages/frontend/src/hooks/useTaskSync.ts:50`、`useTaskSync.ts:65`。
- FDL-05 属实，P2 合理：review/clarify 两份 IDB facade 同库不同 version、独立 `dbPromise`，且 clarify 升级时知道并创建 `review-drafts`，见 `packages/frontend/src/lib/review/draftStore.ts:9`、`packages/frontend/src/lib/clarify/draftStore.ts:16`、`draftStore.ts:48`。
- FDL-06 属实但建议降为 P3：401 清 token 和 multipart 重复处理存在，见 `packages/frontend/src/api/client.ts:58`、`client.ts:137`；这是扩展性/UX 缺口，不是当前数据一致性主风险。
- FDL-07/08 属实，P3 合理：`workflow.updated` 无条件失效列表，见 `packages/frontend/src/hooks/useWorkflowSync.ts:47`；`node.status/node.event` 高频失效整组 node-runs，见 `packages/frontend/src/hooks/useTaskSync.ts:28`、`useTaskSync.ts:31`。
- FDL-13/14 属实：inbox 数据查询散在多个展示组件，见 `InboxDrawer.tsx:44`、`InboxFooterButton.tsx:26`、`InboxPreviewList.tsx:34`、`MemoryPendingBadge.tsx:26`；repo import 直接内联 `useWebSocket`，见 `packages/frontend/src/components/repos/BatchImportDialog.tsx:110`。
- FDL-15 属实，P3 合理：原始 token 进入 React Query key，见 `packages/frontend/src/hooks/useActor.ts:40`。
- FDL-18/19 属实：现有 WS hook 测试只覆盖上层 hook 连接/失效，注释也说明“不测重连”，见 `packages/frontend/tests/ws-hooks.test.tsx:1`；`useWebSocket` 对 error、非 JSON、重连状态无外部可观测输出，见 `packages/frontend/src/hooks/useWebSocket.ts:61`、`useWebSocket.ts:72`。

## REFUTED / 伪问题（给反证 file:line）

- “WS 只更新 review/clarify 的 `list`，不更新 pending-count”不成立：`useTaskSync` 明确 invalidate `['reviews','pending-count']` 与 `['clarify','pending-count']`，见 `packages/frontend/src/hooks/useTaskSync.ts:50`、`useTaskSync.ts:67`；review 提交成功路径也手动失效 pending-count，见 `packages/frontend/src/routes/reviews.detail.tsx:195`、`packages/frontend/src/components/review/MultiDocReviewView.tsx:111`。
- FDL-11 的安全严重级偏高：WS token query 是当前权威技术设计的一部分，见 `design/design.md:16`，不能直接按“违反设计”处理。作为未来安全改进成立，但在本地单 daemon 产品形态下更像 P3 hardening。
- “fusion 永远完全靠客户端轮询完成状态推进”表述过强：fusion 有后台 reconcile loop，每 60s 推进 running fusion，见 `packages/backend/src/services/fusion.ts:539`、`fusion.ts:549`；不过前端确实没有 WS 实时刷新，`fusions.detail.tsx:41` 仍需轮询展示变化。
- FDL-12 更像未来协同能力设想，不是当前数据层缺陷。`useWorkflowSync` 明确承诺“不覆盖未保存草稿”，见 `packages/frontend/src/hooks/useWorkflowSync.ts:5`；在没有多人自动合并需求/RFC 前，统一协同原语可能过早。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- Memory inbox key 也未被 memory WS 覆盖 — P2 — `packages/frontend/src/components/shell/InboxDrawer.tsx:44`、`packages/frontend/src/hooks/useMemoryWs.ts:45` — 抽屉用 `['memories','inbox','candidates']`，WS 只失效 `pending-count/candidates/all/scoped/detail`，即使 `/memory` 挂了 `useMemoryWs`，打开的 inbox memory tab 也不能实时刷新。
- Fusion 加入 inbox 后测试仍只覆盖 review/clarify — P2 — `packages/frontend/tests/inbox-footer-button.test.tsx:1`、`packages/frontend/tests/inbox-drawer.test.tsx:31` — 生产组件已查询 fusion count/list，见 `InboxFooterButton.tsx:39`、`InboxDrawer.tsx:66`，但测试 mock/断言仍围绕两类 feed，容易放过 fusion badge/drawer 回归。
- Fusion launch 成功不失效 inbox/count key — P3 — `packages/frontend/src/components/fusion/FuseDialog.tsx:77`、`FuseDialog.tsx:84` — 创建 fusion 后只导航详情，不 invalidate `['fusions']` / `['fusions','pending-count']`；若已有 shell/drawer 查询缓存，仍只能等轮询或重新挂载。
- `useMemoryWs` 只在 `/memory` 挂载，和 shell memory badge 注释形成实时性错觉 — P2 — `packages/frontend/src/components/shell/MemoryPendingBadge.tsx:11`、`packages/frontend/src/routes/memory.tsx:49` — 用户不在 `/memory` 时 memory badge 纯 60s 轮询，报告提到了全局徽标慢，但没点出注释与挂载位置共同导致的维护误判。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的方向基本对，但建议应拆小。优先做 `queryKey factory + useInboxFeeds + shell useInboxSync`，收益最大、风险最低；不必第一步就做“单条多路复用 WS + 首帧 auth”。

全局 inbox channel 可以做，但必须继承现有 per-frame ACL 模式：tasks-list 已按 actor 过滤，见 `packages/backend/src/ws/server.ts:314`；memory 也有 scope 可见性过滤，见 `ws/server.ts:399`。新 channel 不能把 review/clarify/fusion/memory 摘要粗暴广播给所有登录用户，否则会破坏 RFC-099 资源隔离。

`useResourceChannel({ routes })` 可行，但不要把所有 invalidation 变成过度抽象 DSL。更稳的落点是：每类资源先导出 query-key 工厂和一个小注册表，shell 聚合订阅只消费注册表；保留 `useWebSocket` 作为底层原语。

WS token 改造是安全 hardening，不应和 inbox 实时性绑定在同一个重构里。否则会同时改鉴权、连接生命周期、后端 upgrade、前端订阅模型，回归面过大。

## 总评（sound / mostly-sound / flawed + 一句理由）

mostly-sound：核心判断“前端数据层缺统一 inbox/query-key/订阅模型”成立，但报告有几处夸大实时缺口、把既有设计约定当安全缺陷，并漏掉了 memory/fusion 进入 inbox 后的新 key 与测试断层。
