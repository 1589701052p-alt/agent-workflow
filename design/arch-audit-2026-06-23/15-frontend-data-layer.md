# 前端数据层（hooks / WS 同步 / TanStack Query / stores / api）— 架构审计 (2026-06-23)

> 范围：`packages/frontend/src/hooks/*`、`api/client.ts`、`stores/{auth,inbox}.ts`、`lib/clarify/draftStore.ts`、`lib/review/draftStore.ts`、`lib/diffViewed.ts`、`lib/rfc026-events.ts`、`lib/rfc031-events.ts`，以及它们的消费方（inbox / 首页 / 详情路由）。
> 与既有审计交叉：`design/dedup-audit-2026-06-13.md` 已对本子系统下结论——`idb-draft-store-facade` 判为「真重复」(§3.9/§4.8)，`ws-hook-subscribe-parse-invalidate` 判为「非可合并重复」(§4 反核验段)。本报告**不重复** dedup 视角，而是从**架构 / 扩展性**切入：底层传输原语 `useWebSocket` 很好，但缺一层「资源订阅 + invalidation 注册表」中间层，导致实时性在不同资源间严重不对称、query-key 家族碎片化。

---

## 0. 健康度一句话

底层 WS 传输原语（`useWebSocket`）和 fetch 封装（`api/client.ts`）设计干净、可复用度高；但**缺一层「资源 → channel → invalidation」的统一订阅注册表**，导致实时性高度不对称（review/clarify 半实时、fusion 纯轮询、shell 徽标完全靠 15s 轮询），同一「待办」语义被 4 套 query-key 各查一份且 WS 只更新其中 2 套——再加一类实时资源（典型：fusion 已经踩了这个坑）就要碰前后端 6+ 个点。整体 **P1 级健康**：能跑、有测试，但实时层是「每加一个资源各 fork 一份」的结构。

---

## 1. 当前架构与职责

底层传输是单一原语 `hooks/useWebSocket.ts`（指数退避重连、token/baseUrl 每次连接重读、JSON 解析、enabled 拆连）——这一层是好的、被所有 sync hook 复用。其上是 6 个**手写**的资源 sync hook（`useTaskSync` / `useTasksSync` / `useWorkflowSync` / `useClarifyWs` / `useMemoryWs` / `useMemoryDistillJobWs`），每个把 WS 消息映射成一组 `qc.invalidateQueries`。REST 走 `api/client.ts`（`api.{get,post,put,patch,delete,postMultipart}` + `ApiError`）。轻量全局态用「module emitter + `useSyncExternalStore`」模式手写两份（`stores/auth.ts`、`stores/inbox.ts`）。本地草稿持久化两份 IndexedDB facade（`lib/clarify/draftStore.ts`、`lib/review/draftStore.ts`）+ 一份 localStorage（`lib/diffViewed.ts`）。事件 payload 解码两份（`lib/rfc026-events.ts`、`lib/rfc031-events.ts`）。

关键文件清单：
- 传输：`hooks/useWebSocket.ts`、`api/client.ts`
- 资源 sync：`hooks/useTaskSync.ts`、`useTasksSync.ts`、`useWorkflowSync.ts`、`useClarifyWs.ts`、`useMemoryWs.ts`、`useMemoryDistillJobWs.ts`
- 全局态：`stores/auth.ts`、`stores/inbox.ts`、`hooks/useActor.ts`、`hooks/useUserLookup.ts`
- 持久化：`lib/clarify/draftStore.ts`、`lib/review/draftStore.ts`、`lib/diffViewed.ts`、`hooks/useResizable.ts`
- 事件解码：`lib/rfc026-events.ts`、`lib/rfc031-events.ts`
- 后端对应：`packages/backend/src/ws/server.ts`（6 个 channel kind）、`packages/backend/src/ws/broadcaster.ts`（6 个 broadcaster）
- 消费方（碎片化集中地）：`components/shell/InboxDrawer.tsx`、`components/shell/InboxFooterButton.tsx`、`components/home/InboxPreviewList.tsx`、`components/shell/MemoryPendingBadge.tsx`、`routes/fusions.detail.tsx`

---

## 2. 设计问题（Design）

**[FDL-01] 没有「资源 WS 订阅 + invalidation」统一原语，6 个 sync hook 各手写映射** — 级别 P2｜类型 design/extensibility｜证据 `hooks/useTaskSync.ts:10-75`、`useTasksSync.ts:10-31`、`useWorkflowSync.ts:29-61`、`useClarifyWs.ts:33-69`、`useMemoryWs.ts:32-61`、`useMemoryDistillJobWs.ts:26-46`｜影响：每个 hook 都重复「`useQueryClient` + `useWebSocket({path,onMessage})` + `if (msg.type === ...) invalidateQueries(...)`」骨架；`useWebSocket` 只抽走了**传输层**，没有抽走「事件→失效键」这层声明式映射。dedup-audit 把这判为「非可合并重复」是对的（每个 hook 的 invalidation 逻辑确实不同），但它只评估了「能不能合并代码体」，没评估「缺中间层」这个架构问题——映射表本身可以是**数据**（`{ eventType → queryKey[] }` 注册表）而非散落在 6 个 `if` 里。｜建议：抽 `useResourceChannel({ path, enabled, routes: Record<eventType, (msg)=>QueryKey[]> })`，把每个资源的失效规则降为一张声明式表；hook 体只剩注册表。

**[FDL-02] 「待办（inbox）」实时性在资源间严重不对称：review/clarify 半实时、fusion 纯轮询、memory 仅 /memory 页实时** — 级别 P1｜类型 design/extensibility｜证据：review/clarify 事件**只**在 per-task channel 上广播（`packages/backend/src/ws/broadcaster.ts:63` `TASK_CHANNEL`，无 reviews/clarify 专用 broadcaster），所以只有挂着 `/ws/tasks/{taskId}` 的页面（task 详情 `routes/tasks.detail.tsx`、review 详情 `routes/reviews.detail.tsx:83`、clarify 详情经 `useClarifyWs`）才会实时刷新；fusion **完全没有 channel/broadcaster**（`broadcaster.ts:82-87` 仅 6 个，无 fusion），`routes/fusions.detail.tsx:39-43` 纯 2s 轮询；列表/徽标层没有任何全局 channel 可订阅。｜影响：用户提交 review → 另一标签页的 inbox 抽屉 / 首页待办 / 侧栏徽标都要等 15s 轮询；fusion 永远没有实时，全靠轮询。这是「按资源逐个补 WS」的结果，不是统一模型。｜建议：见 §4 FDL-09——引入「全局 inbox channel」或让 `tasks-list` channel 兼带 review/clarify/fusion 摘要事件，shell 单点订阅。

**[FDL-03] shell 层（`__root.tsx`）不挂任何 WS sync hook，全局徽标只能靠轮询** — 级别 P1｜类型 design/observability｜证据 `routes/__root.tsx:48-60` 只 `useApplyLanguage()` + `useInboxOpen()`，无 `useTasksSync` / `useMemoryWs`；`useTasksSync` 仅在 `routes/tasks.tsx:39` 挂载、`useMemoryWs` 仅在 `routes/memory.tsx:50` 挂载。侧栏徽标 `components/shell/InboxFooterButton.tsx:26-43` 三个 query 各 `refetchInterval: 15_000`，`MemoryPendingBadge.tsx:31` 自带 `refetchInterval: 60_000`。｜影响：不在 `/tasks`/`/memory` 时，全局徽标完全无实时；review/clarify/fusion 即使有 task channel 也没人在 shell 订阅。｜建议：shell 挂一个轻量「全局通知订阅」hook（见 §4 FDL-09），轮询降级为长间隔兜底而非主路径。

**[FDL-04] 「pending 待办」同一语义被 4 套 query-key 各查一份，WS 只覆盖其中 2 套** — 级别 P1｜类型 design/coupling｜证据：同一份 `/api/reviews?status=pending` 在 `InboxDrawer.tsx:52` 用 `['reviews','inbox','pending']`、`InboxPreviewList.tsx:24,35` 用 `['reviews','homepage','pending']`（`REVIEWS_HOMEPAGE_QUERY_KEY`）；`/api/reviews/pending-count` 在 `InboxFooterButton.tsx:27` 用 `['reviews','pending-count']`；而 WS/详情只失效 `['reviews','list']`（`useTaskSync.ts:51`、`reviews.detail.tsx:197`、`MultiDocReviewView.tsx:113`）。clarify 同样有 `inbox`/`homepage`/`pending-count`/`list` 四套。｜影响：WS 事件**根本不会**让 inbox 抽屉、首页待办即时刷新——它们查的 key 没被任何 invalidate 命中，只能靠各自 15s 轮询；query-key 命名约定不统一（`inbox`/`homepage`/`list`/`pending-count` 混用同一数据源）是 drift 温床，未来想统一 invalidation 会发现「不知道有几套 key」。｜建议：建立单一 query-key 工厂（如 `MEMORY_QUERY_KEYS` 那样，`useMemoryWs.ts:23-30` 已是范例），所有 pending-feed 共用一个 key 家族；WS 失效一次即全覆盖。

**[FDL-05] 两份 IndexedDB draft facade 对同库不同 version，是真实升级 footgun** — 级别 P2｜类型 design｜证据 `lib/review/draftStore.ts:9-11`（`DB_NAME='agent-workflow-drafts'`, `VERSION=1`）与 `lib/clarify/draftStore.ts:16-18`（同库, `VERSION=2`）；两份各自 `let dbPromise`（`review:24` / `clarify:34`）→ 同一 origin 两条独立连接 + 两套 `onupgradeneeded`。clarify 的 `openDb` 在升级时**顺手** create `review-drafts`（`clarify:48-50`）来兜底——这说明两份已经知道彼此存在却仍各开各的。｜影响：若哪天 review facade 也 bump version，两份 version 号竞争会触发 `VersionError` / 连接阻塞；这是已被 dedup-audit §3.9 标记的「medium」项，从架构看属于**缺一个 `idbKv` 单连接原语**。｜建议（与 dedup-audit 落点一致）：`lib/idbKv.ts` 单连接 + store 注册表 + 单 version。

**[FDL-06] `api/client.ts` 401 处理硬清 token，无统一未授权/掉线 UX 钩子** — 级别 P2｜类型 design｜证据 `api/client.ts:58-61`（`if (res.status === 401) clearToken()`）+ `apiPostMultipart` 重复同一逻辑 `:137`。｜影响：401 直接 `clearToken()` → 触发 auth store emit → 全 app 跳 `/auth`，但没有「会话过期」提示，且 multipart 路径是第二份拷贝（client 内部小重复）；未来要加「刷新 token / 静默重登」会发现没有集中拦截点。｜建议：把 401 处理收敛成单一 `onUnauthorized` 钩子，multipart 复用主 `apiRequest` 的响应处理尾段（目前 `:63-70` 与 `:139-146` 是逐字拷贝）。

---

## 3. 实现问题 / Bug（Impl）

**[FDL-07] `useWorkflowSync` 对每条 `workflow.updated` 都无条件失效 `['workflows']` 列表，即便不是自己的 id** — 级别 P3｜类型 perf｜证据 `hooks/useWorkflowSync.ts:47-58`：版本守卫只 gate「详情失效 + onRemoteUpdate」，最后 `:57` 的 `invalidateQueries({queryKey:['workflows']})` 在 `if` 外无条件执行。｜影响：编辑器开着时，任意 workflow（哪怕别人的）每次保存广播都触发本地列表 refetch；多人/多 workflow 场景下放大无谓请求。属轻微，但是「失效面没收口」的典型。｜建议：列表失效也纳入「列表语义事件」判定，或交给 §4 的注册表统一节流。

**[FDL-08] `useTaskSync` 在每个 `node.status` / `node.event` 都失效 node-runs，无合并/节流** — 级别 P3｜类型 perf｜证据 `hooks/useTaskSync.ts:28-36`：`node.status` 与 `node.event` 分支都 `invalidateQueries(['tasks',taskId,'node-runs'])`；一个 fan-out 多分片任务会高频广播 node.event，详情页据此反复 refetch 整个 node-runs 列表（注释 `:31-34` 自己也承认「Future: render directly on a node-events feed」）。｜影响：大 fan-out 任务详情页请求风暴；react-query 会 coalesce 但仍是「事件→整列表 refetch」的粗粒度模式。｜建议：node.event 走增量/直接渲染，或在注册表里对同 key 失效做 debounce。注：scheduler-audit 关注后端事件量，本条是前端侧放大，二者互补。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 重点

**[FDL-09] 未来功能：「再加一类待审资源（如 audit-result inbox / fusion-v2 / 第三方 webhook 待办）」** — 级别 P1｜类型 extensibility
- **根因**：实时层是「按资源逐个补 WS」而非「统一订阅模型」。fusion（RFC-101）已经是活生生的前车之鉴——它是一等 inbox 资源，但前端**零 WS**：`fusions.detail.tsx:39-43` 纯轮询、`InboxFooterButton.tsx:39-43` / `InboxDrawer.tsx:66-71` 纯 15s 轮询，后端 `broadcaster.ts:82-87` 根本没给它建 broadcaster/channel。
- **现在加一类资源要碰的点**（≥6 处）：① 后端新增 `xxxBroadcaster`（`broadcaster.ts`）+ channel kind + `parseChannel`/`handleOpen` 分支（`ws/server.ts:134-160,296-455`）；② shared 加 `XxxWsMessage` 类型；③ 前端新写一个 `useXxxWs` sync hook（复制 `useMemoryWs` 骨架）；④ 决定它挂哪——shell 没有订阅点（FDL-03），只能再塞进某个路由；⑤ inbox 三件套各加一个 query + 一个 tab + 一个 kind 分支（`InboxDrawer.tsx:44-49,153-168,326-372`、`InboxFooterButton.tsx:39-52`、`InboxPreviewList`）；⑥ 给它发明 inbox/homepage/pending-count/list **四套** query-key 并希望别人记得一起 invalidate（FDL-04）。
- **目标形态**：① 后端一个「inbox/notification」聚合 channel，把 review/clarify/fusion/memory 的「有新待办 / 待办状态变」摘要事件统一广播（per-actor 可见性过滤已有先例 `ws/server.ts:199-218`）；② 前端 shell 单点挂 `useInboxChannel()`，它持有一张 `{ eventType → queryKey[] }` 注册表；③ inbox 数据用单一 query-key 工厂（每类资源一个 `XXX_QUERY_KEYS`，仿 `useMemoryWs.ts:23-30`），加资源 = 注册表加一行 + key 工厂加一份，**不碰传输层、不碰 shell**。

**[FDL-10] 未来功能：「inbox 抽屉 / 首页 / 徽标三处恒真同步且即时」** — 级别 P1｜类型 extensibility/coupling
- **根因**：同一 pending 语义被 4 套 key 各查一份（FDL-04），且没有「这是同一份数据」的单一事实源。
- **现在加功能要碰的点**：想让某个新 WS 事件刷新所有三处，得在 `useTaskSync`（`:50-52`）、`reviews.detail.tsx:197`、`MultiDocReviewView.tsx:113` 等所有 invalidate 点逐一补 `['reviews','inbox','pending']` + `['reviews','homepage','pending']` + `['reviews','pending-count']`——而且要先**知道**有这几套 key（目前散在三个组件文件里，无索引）。
- **目标形态**：`lib/inboxQueryKeys.ts` 单一工厂导出每类资源的全部 key；shell 订阅器对一类事件 `invalidateQueries({ queryKey: ['reviews'] })`（前缀失效一把梭）即可覆盖全家族；徽标/抽屉/首页都引同一 key 工厂，新增展示位天然继承实时性。

**[FDL-11] 未来功能：「把 token 从 URL query 改成更安全的握手 / 支持 token 轮换」** — 级别 P2｜类型 security/extensibility
- **根因**：WS 鉴权把 token 拼进 URL query string（`useWebSocket.ts:114-119` `u.searchParams.set('token', token)`），token 会进浏览器/代理/服务端访问日志；且每个 sync hook 自连一条 socket（6 个 hook = 最多 6 条并发 WS），没有连接复用层。
- **现在加功能要碰的点**：改握手方式要同时动 `useWebSocket.ts` + 后端 `ws/server.ts` 升级校验（`:163-218`）；token 轮换时现有 socket 不会主动重连换 token（只在 `close`→`connect` 时重读 `getToken`，`useWebSocket.ts:42`）。
- **目标形态**：单条多路复用 WS（一个连接订阅多个 channel）+ 首帧 auth 而非 URL token；连接层订阅 `subscribeAuth` 在 token 变更时主动重连。这同时缓解 FDL-09 的「每资源一条 socket」扩张。

**[FDL-12] 未来功能：「编辑器多人协同时安全合并远端更新（而非只提示）」** — 级别 P2｜类型 extensibility
- **根因**：`useWorkflowSync` 只做「失效 + 回调通知」，靠调用方自己管 dirty/合并（`useWorkflowSync.ts:5-7` 注释明说「does NOT clobber unsaved drafts」）；没有版本基线 / 三方合并原语。
- **现在加功能要碰的点**：要做真正的协同合并，得在编辑器路由里自己实现版本 diff/合并，sync hook 帮不上；clarify/review 已经各自实现了「per-item 协作草稿 last-write-wins」（`useClarifyWs.ts:26-31,47-52` + 后端逐题草稿），workflow 又得 fork 第三套协同模型。
- **目标形态**：抽一个「资源协同（基线版本 + 远端到达策略：notify / auto-merge / conflict）」原语，clarify 草稿、review selection、workflow 编辑共用，避免每个资源各发明一套并发策略。

---

## 5. 耦合 / 分层违规

**[FDL-13] inbox 数据获取与展示在三个组件里各自重复，无共享数据 hook** — 级别 P2｜类型 coupling｜证据 `InboxDrawer.tsx:44-71`（4 个 query）、`InboxFooterButton.tsx:26-43`（3 个 count query）、`InboxPreviewList.tsx:33-42`（2 个 query）、`MemoryPendingBadge.tsx:24-32`（1 个）——四个组件各写各的 `useQuery` + `refetchInterval`，没有 `useInboxFeeds()` 之类共享数据层。｜影响：feed 列表/容错/轮询间隔逻辑分散，FDL-04 的 key 碎片化由此而来；改一处行为（如统一容错）要改 4 个文件。｜建议：抽 `hooks/useInboxFeeds.ts` 单一数据层，三个展示组件只消费派生结果。

**[FDL-14] 详情路由内联 WS 订阅 + 自带轮询，绕过资源 hook** — 级别 P3｜类型 coupling｜证据 `reviews.detail.tsx:77,83`（`refetchInterval:8000` + 直接 `useTaskSync(detail.data?.summary.taskId)`）与 `MultiDocReviewView.tsx:54,56` 逐字同款；`BatchImportDialog.tsx:112` 直接 `useWebSocket({path:'/ws/repo-imports/...'})` 内联（无 `useRepoImportWs` hook）。｜影响：`useTaskSync(detailTaskId)` 这个模式被复制；repo-import WS 没有专用 hook（第 7 个一次性消费方）。属轻微，但印证「没有资源订阅原语，调用方就地拼」。｜建议：repo-import 也走资源 hook；详情页统一用 §4 的订阅器。

**[FDL-15] `useActor` 把原始 token 拼进 react-query queryKey** — 级别 P3｜类型 security/observability｜证据 `hooks/useActor.ts:44`（`queryKey: [...ACTOR_QUERY_KEY, token ?? 'no-token']`），注释 `:41-43` 自辩「token 本就在 localStorage，进 devtools 无差别」。｜影响：token 出现在 react-query 缓存/devtools/任何 query 快照里，比 localStorage 多了一个泄漏面（截图、错误上报序列化 query state）。可接受性见仁见智，标注供权衡。｜建议：用 token 的稳定 hash（如前 8 字符）入 key 即可达到「换号即失效」效果而不落明文。

---

## 6. 测试 / 可观测性缺口

**[FDL-16] fusion 实时性零测试（因为根本没有 fusion WS hook）** — 级别 P2｜类型 test-gap｜证据：`tests/` 有 `use-clarify-ws.test.tsx` / `use-memory-ws.test.tsx` / `ws-hooks.test.tsx`（覆盖 tasks/workflow sync），但无 fusion；`fusions.detail.tsx` 仅轮询无 WS（FDL-02）。｜影响：fusion inbox 的「另一标签页即时刷新」从未被验证，因为该能力不存在。｜建议：作为 FDL-09 落地的验收，补 fusion 走统一 channel 后的 invalidation 测试。

**[FDL-17] inbox query-key 碎片化无回归锁** — 级别 P2｜类型 test-gap｜证据：FDL-04 的 4 套 key 散落在 `InboxDrawer`/`InboxPreviewList`/`InboxFooterButton`，无任何测试断言「WS 事件后这几处都刷新」或「pending 数据只有一个 key 家族」。｜影响：未来有人改 key 名 / 漏 invalidate 不会被测试抓到（与 CLAUDE.md「最低限度保留一条源码层文本断言」原则相悖）。｜建议：补一条文本/集成断言锁定「所有 pending-feed 引同一 key 工厂」。

**[FDL-18] `useWebSocket` 退避/重连/`closeSocket(CONNECTING)` 路径缺直接单测** — 级别 P3｜类型 test-gap｜证据：`ws-hooks.test.tsx` 测的是上层 sync hook 的连接与失效（`:72-133`），没有针对 `useWebSocket.ts:77-82`（指数退避）/`:100-112`（CONNECTING 延迟关闭）的专门用例——而这正是注释 `:94-98` 提到「曾经每次都崩」的高风险区。｜影响：底层传输是所有实时性的地基，回归无网。｜建议：补退避序列 + StrictMode 双挂卸的直接单测。

**[FDL-19] 无 WS 健康度可观测性** — 级别 P3｜类型 observability｜证据 `useWebSocket.ts:72-74` error 事件空处理、`:61-63` 非 JSON 帧静默丢弃、重连无任何上报。｜影响：WS 长期断线时前端静默退化为轮询，用户/运维无感知（徽标只是「慢」）。｜建议：暴露连接状态（connected/reconnecting/down），shell 可据此显示「实时已降级」提示。

---

## 7. 目标形态（Target architecture）

1. **三层清晰分层**：`useWebSocket`（传输，保留并补测）→ `useResourceChannel`（订阅 + 声明式 `{ eventType → queryKey[] }` 注册表，替代 6 份手写 if）→ 各资源只导出一张注册表。加资源 = 注册表加行。
2. **单条多路复用 WS + 首帧 auth**：一个连接订阅多个 channel，token 不进 URL（FDL-11）；token 变更主动重连。
3. **shell 单点订阅 + 全局 inbox channel**：后端聚合「待办类」摘要事件到一个可见性过滤的 channel；shell 挂一个 `useInboxChannel()`，轮询退为长间隔兜底而非主路径（FDL-02/03）。
4. **单一 query-key 工厂**：每类资源一个 `XXX_QUERY_KEYS`（`useMemoryWs.ts:23-30` 已是范例），inbox/homepage/badge 全引同一家族，WS 前缀失效一把覆盖（FDL-04/10）。
5. **共享 inbox 数据 hook**：`useInboxFeeds()` 收口 feed 获取/容错/派生，三个展示组件只消费（FDL-13）。
6. **单 `idbKv` 持久化原语**：单连接 + store 注册表 + 单 version，review/clarify draft 共用（FDL-05，与 dedup-audit 落点一致）。
7. **统一资源协同原语**：基线版本 + 远端到达策略（notify/auto-merge/conflict），clarify/review/workflow 共用（FDL-12）。

---

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话建议 |
|---|---|---|---|---|---|
| 1 | FDL-09 | 加新实时资源要碰 6+ 点（fusion 已踩坑） | P1 | extensibility | 统一 channel + 订阅注册表 |
| 2 | FDL-02 | inbox 实时性资源间严重不对称 | P1 | design | 全局 inbox channel，shell 单点订阅 |
| 3 | FDL-04 | pending 同语义 4 套 key，WS 只覆盖 2 套 | P1 | coupling | 单一 query-key 工厂 + 前缀失效 |
| 4 | FDL-03 | shell 不挂 WS，全局徽标纯轮询 | P1 | observability | shell 挂 `useInboxChannel()` |
| 5 | FDL-10 | 三处待办展示无单一事实源 | P1 | extensibility | `lib/inboxQueryKeys.ts` + 共享数据 hook |
| 6 | FDL-01 | 6 个 sync hook 各手写事件→失效映射 | P2 | design | `useResourceChannel` 声明式注册表 |
| 7 | FDL-05 | 两份 IDB draft 同库不同 version footgun | P2 | design | 单 `idbKv` 原语（同 dedup-audit） |
| 8 | FDL-11 | WS token 进 URL + 每资源一条 socket | P2 | security | 多路复用 + 首帧 auth |
| 9 | FDL-13 | inbox 数据获取三组件各写一份 | P2 | coupling | `useInboxFeeds()` 收口 |
| 10 | FDL-16/17 | fusion 实时 / key 碎片化无测试 | P2 | test-gap | 随 FDL-09/04 落地补回归 |
| 11 | FDL-06 | 401 处理无统一钩子 + multipart 拷贝 | P2 | design | 收敛 `onUnauthorized` |
| 12 | FDL-07/08 | 失效面未收口（workflow 列表 / node.event） | P3 | perf | 注册表统一节流 |
| 13 | FDL-12 | 编辑器协同要 fork 第三套并发模型 | P2 | extensibility | 统一资源协同原语 |
| 14 | FDL-14/15/18/19 | 内联订阅 / token 入 key / 传输无测 / 无健康度 | P3 | mixed | 逐项收口 |

---

### 待核验（无法仅凭前端源码确证）
- FDL-02 称「review/clarify 仅在 per-task channel 广播」已由 `broadcaster.ts:63-87`（仅 6 broadcaster、无 reviews/clarify/fusion 专用）+ `ws/server.ts:134-160` 的 `parseChannel`（仅 6 kind）双向印证；若后端另有未被 grep 命中的旁路广播，需复核。
- FDL-11「最多 6 条并发 WS」是按「每个 sync hook 各开一条」推断；实际并发数取决于同一时刻挂载的 hook 数（多数页面只挂 1-2 个），峰值场景需运行期确认。
