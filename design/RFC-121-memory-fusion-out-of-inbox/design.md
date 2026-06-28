# RFC-121 技术设计

## 0. 范围与不变量

- **纯前端**：零后端 / 路由 / shared schema / DB / migration 改动。复用既有接口：
  - `GET /api/fusions?status=awaiting_approval` —— 收件箱本就在用（admin 全量 / owner 自有，服务端 `routes/fusions.ts:74` 已过滤）。
  - `GET /api/fusions/pending-count` —— 收件箱徽标本就在用（同作用域，`routes/fusions.ts:97`，窄投影、无 diff 解析）。
  - `GET /api/memories?status=candidate` —— 记忆候选，记忆页审批队列与侧栏候选徽标本就在用。
- **黄金不变量**：收件箱里 reviews / clarify 的行为、详情跳转、错误软失败逐字不变；记忆页审批队列 / 全部 / 按 scope / 蒸馏任务四 tab 逐字不变；`/fusions/$id` 详情页不变。

## 1. 决策日志

- **D1 记忆待办移出收件箱**：删 `InboxDrawer` 的 `memory` tab、`all` 聚合里的 memory 分支、`canSeeMemory`、`memoryQuery`、`memoryActionKey`。记忆候选原本就在 `/memory` 审批队列 tab，无需新建落点。
- **D2 融合待办移出收件箱**：删 `InboxDrawer` 的 `fusion` tab、`all` 聚合里的 fusion 分支、`fusionsQuery`、fusion 错误行。
- **D3 收件箱徽标去 fusion**：`InboxFooterButton` 删 `fusions` 查询，`total = reviews + clarify`，`allFailed = reviews.error && clarify.error`。
- **D4 记忆页新增「融合」tab**：第 5 个 tab，新组件 `MemoryFusionList`，查 `awaiting_approval` 融合，行点击进 `/fusions/$id`。**只列待办**（与收件箱旧语义一致）；完整融合历史非目标。
- **D5 侧栏「记忆」徽标计入融合**：`MemoryPendingBadge` = 待审记忆候选（admin-only，query 仍 `enabled: isAdmin`，不变）+ 待审融合（`/api/fusions/pending-count`，对所有登录用户 enabled，服务端已作用域）。`total = candidatesCount + fusionCount`，`total>0` 才渲染。徽标因此对「有待办融合的非 admin owner」也会出现。
- **D6 `/fusions/*` 分组高亮归记忆组**：`resolveActiveNav` 末尾 detail-route fallback 把 `/fusions` 前缀映射到 `activeGroup: 'memory'`（与 reviews/clarify→workflows 同款 fallback）。
- **D7 i18n 增删对称**：新增 `memory.tab.fusion`、`memory.fusion.{title,subtitle,empty,error,retry}`（zh+en）；删因收件箱去 fusion/memory 而变死的 `nav.inbox.{tabFusion,fusionTitle,fusionSubtitle,errorFusion,memoryItemSubtitle}`（zh+en 两段——类型段 + 值段）。**保留**仍被他处使用的 `memory.scope.*` / `memory.distillAction.*` / `nav.memory` / `nav.memoryBadge` / `nav.inbox.{tabAll,tabReviews,tabClarify,...}`。
- **D8 轮询而非 WS**：仓内无 fusion WS hook（`fusions.detail.tsx` 用 `refetchInterval`）。`MemoryFusionList` 沿用收件箱旧的 `refetchInterval: 15_000`（该轮询也驱动服务端 lazy done 检测，见 `InboxFooterButton` 注释）。记忆页仍 `useMemoryWs()` 驱动候选实时；融合 tab 用轮询。
- **D9 复用公共原语**：`MemoryFusionList` 复用 `EmptyState` / `LoadingState` / `ErrorBanner`（或 `error-box` + 重试，与抽屉一致），行样式复用记忆页既有列表 class，**禁止**自写 chrome（遵 CLAUDE.md 前台统一原则）。

## 2. 逐文件改动

### 2.1 `components/shell/InboxDrawer.tsx`（D1+D2）

- `InboxTab` 类型：`'all' | 'reviews' | 'clarify'`（去 `'fusion' | 'memory'`）。
- `InboxItem['kind']`：`'review' | 'clarify'`（去 `'fusion' | 'memory'`）。
- 删 `memoryQuery`、`fusionsQuery`、`canSeeMemory`（及 `usePermission` import）。
- `items` useMemo：删 fusion、memory 两个分支；依赖数组同步收窄。
- tab 渲染：固定 `['all', 'reviews', 'clarify']`（删 `canSeeMemory ? ... : ...` 三元）。
- 删 fusion `ErrorRow`；空状态 loading 守卫去 `fusionsQuery.isLoading`。
- 导航 map：删 fusion → `/fusions/$id`、memory → `/memory` 两个目标分支。
- 删行渲染里 `it.kind !== 'memory' && it.kind !== 'fusion'` 的特判（reviews/clarify 恒有 taskName/taskId，直接渲染）。
- 删 `inboxTabLabelKey` / `inboxKindLabelKey` 的 `fusion` / `memory` case；删 `memoryActionKey`。
- 删 import：`Fusion`、`MemorySummary`（保留 `ClarifyRoundSummary`、`ReviewSummary`）。
- 头部注释由「three segmented tabs（All / Reviews / Clarify）」回归（RFC-032 原文即如此，RFC-101/041 把它扩到 5 个；本 RFC 收回），追加 RFC-121 说明指向记忆页。

### 2.2 `components/shell/InboxFooterButton.tsx`（D3）

- 删 `fusions` useQuery + `FusionPendingCount` import。
- `total = reviewsCount + clarifyCount`；`allFailed = reviews.error && clarify.error`。
- 注释更新：徽标 = reviews + clarify；融合已移至记忆页（侧栏记忆徽标承载）。

### 2.3 `components/memory/MemoryFusionList.tsx`（D4，新文件）

```
useQuery<Fusion[]>({
  queryKey: ['fusions', 'memory', 'awaiting'],
  queryFn: ({signal}) => api.get('/api/fusions?status=awaiting_approval', undefined, signal),
  refetchInterval: 15_000,
})
```
- loading → `<LoadingState>`；error → `error-box` + 重试按钮（或 `<ErrorBanner>`）；空 → `<EmptyState title={t('memory.fusion.empty')}>`。
- 每行：技能名 + 状态 chip + 「吸收 N 条记忆」副标题（`incorporatedMemoryIds?.length ?? memoryIds.length`），整行 `button` 点击 `navigate({to:'/fusions/$id', params:{id}})`。`data-testid={`memory-fusion-row-${f.id}`}`。
- 文案走 `memory.fusion.{title,subtitle,empty,error,retry}`。

### 2.4 `routes/memory.tsx`（D4）

- `MemoryTab` 增 `'fusion'`；`TABS` 增 `'fusion'`（置于末位 → 5 tab）。
- `tab === 'fusion'` 渲染 `<MemoryFusionList />`。
- `tabLabel` 增 `case 'fusion': return t('memory.tab.fusion')`。
- 融合 tab 对所有用户可见（融合是 admin/owner 资源，列表接口已作用域；非成员看到的就是空列表，与现状一致）。

### 2.5 `components/shell/MemoryPendingBadge.tsx`（D5）

- 保留候选查询：`enabled: isAdmin`，`candidatesCount = isAdmin ? items.length : 0`。
- 新增融合查询：`useQuery<FusionPendingCount>(['fusions','pending-count'], '/api/fusions/pending-count')`，对**所有登录用户** enabled、`refetchInterval: 60_000`（与候选一致）。
- `total = candidatesCount + fusionCount`；`total === 0` → `null`；否则渲染徽标（`nav.memoryBadge` 文案 `{{count}} 项待审批` 复用）。
- 删「非 admin 立即 return null」的早退（改为按 total 判断），但候选查询仍仅 admin 触发——非 admin 不会拉候选、只拉自己的融合 count。

### 2.6 `lib/nav.ts`（D6）

- `resolveActiveNav` 末尾 fallback 增 `/fusions` 前缀 → `activeGroup: 'memory'`（紧邻现有 `/reviews`、`/clarify` → `workflows` 的 fallback）。
- 文件头注释补 RFC-121 说明。

### 2.7 `i18n/zh-CN.ts` + `i18n/en-US.ts`（D7）

- 增（类型段 + 值段，zh+en 对称）：
  - `memory.tab.fusion` —— zh「融合」/ en「Fusion」
  - `memory.fusion.title` —— zh「{{skill}}」（或「融合 → {{skill}}」）/ en「Fuse → {{skill}}」
  - `memory.fusion.subtitle` —— zh「待审批 · 吸收 {{n}} 条记忆」/ en「Awaiting approval · {{n}} memories」
  - `memory.fusion.empty` —— zh「暂无待审批的融合」/ en「No fusions awaiting approval」
  - `memory.fusion.error` —— zh「融合列表加载失败」/ en「Failed to load fusions」
  - `memory.fusion.retry` —— 复用 `nav.inbox.retry` 或新增；统一用既有 `common`/`nav.inbox.retry`，避免新键。
- 删（zh+en，类型段 + 值段）：`nav.inbox.tabFusion`、`nav.inbox.fusionTitle`、`nav.inbox.fusionSubtitle`、`nav.inbox.errorFusion`、`nav.inbox.memoryItemSubtitle`。
- 删前用 `grep -rn` 确认这些键无其他引用方后再删（防误删活键）。

## 3. 数据流

```
收件箱抽屉            侧栏底部「收件箱」徽标          侧栏「记忆」项徽标
  ├ reviews            = reviews + clarify            = 候选(admin) + 待审融合(admin/owner)
  └ clarify
                                                         │
记忆页 /memory                                            ▼
  ├ 审批队列  ← /api/memories?status=candidate（记忆待办）
  ├ 全部
  ├ 按 scope
  ├ 蒸馏任务
  └ 融合     ← /api/fusions?status=awaiting_approval（融合待办）→ 点击 /fusions/$id
```

## 4. 失败模式

- **融合接口失败**：`MemoryFusionList` 显错误 + 重试，不影响记忆页其他 tab。
- **融合 pending-count 失败**：`MemoryPendingBadge` 的 `fusionCount` 回退 0；候选仍可独立点亮徽标（软失败，与 footer 徽标同款容错）。
- **非 admin owner**：候选查询不触发（enabled=false → count 0），融合 count 经服务端 owner 作用域返回自有数 → 徽标只反映其融合待办。
- **收件箱 API 仍返回 fusion/memory 数据**（后端未变）：前端不再消费，测试需锁定「即便有数据也不渲染」。
- **轮询窗口**：融合状态变更最长 15s（tab）/ 60s（徽标）后反映，与原收件箱一致，无回归。

## 5. 与现有模块耦合点

- `routes/__root.tsx`：`renderBadge` 仍只对 `/memory` 渲染 `<MemoryPendingBadge/>`，组件内部扩容即可，**无需改 __root**。
- `useMemoryWs`：记忆页已 mount，驱动候选实时；融合 tab 用轮询，不依赖它。
- RFC-101 融合详情页：`/fusions/$id` 不变；本 RFC 只新增「列表→详情」的入口。
- 收件箱 footer 与 drawer 是两个组件，徽标与 tab 各自独立改，互不影响。

## 6. 测试策略（随改落地，CLAUDE.md test-with-every-change）

| 测试 | 类型 | 锁定点 |
|---|---|---|
| `inbox-drawer.test.tsx`（改） | 组件 | 只有 all/reviews/clarify 三 tab；即便 mock `/api/fusions`、`/api/memories` 有数据，drawer 不渲染 fusion/memory 行 |
| `inbox-pending-memory-group.test.tsx`（改名/重定位为回归） | 组件 | 反向锁定：收件箱**无** memory tab、**无** memory 行（锁住 D1 移除，防复活） |
| `inbox-footer-button.test.tsx`（改） | 组件 | 徽标 total = reviews + clarify；fusion count 不计入（mock fusion count 不影响数字） |
| `memory-fusion-tab.test.tsx`（新） | 组件 | 记忆页有「融合」tab；点击列出 awaiting_approval 行；行点击 navigate `/fusions/$id`；空状态 |
| `memory-pending-badge.test.tsx`（新或改） | 组件 | 徽标 = 候选 + 融合；非 admin owner 有融合 → 徽标出现；都为 0 → 无徽标 |
| `nav.test.ts`（改） | 纯函数 | `resolveActiveNav('/fusions/x')` → `activeGroup:'memory'` |
| `inbox-drawer-source-locks`（新，源码文本断言） | 源码兜底 | `InboxDrawer.tsx` 不再 import `Fusion`/`MemorySummary`、不含 `inbox-tab-fusion`/`inbox-tab-memory`（CLAUDE.md「最低限度一条源码文本断言」） |
| i18n parity（`i18n-keys-symmetry` / `i18n-memory-keys` 等） | 既有 | 增删键后 zh/en 对称、无悬挂引用 |

- 优先纯函数可断言面：`nav.ts` 已是纯函数；收件箱 `items` 映射内联于组件，用组件测试 + 源码文本断言兜底（不为此 RFC 强行抽 oracle，避免过度重构）。

## 7. 回滚

纯前端、零迁移；如需回滚，`git revert` 即可，无数据残留。
