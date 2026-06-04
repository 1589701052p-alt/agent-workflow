# RFC-082 — 技术设计：ReviewDocPane 抽取与复用

状态：Draft

## 1. 组件边界（进 / 出 ReviewDocPane）

**进入 `<ReviewDocPane>`（两页共享的"一篇文档 + 评论"能力）：**

- `<Prose anchors>` 正文渲染（含 plantuml/mermaid passthrough、选区高亮锚点）
- 锚定评论气泡侧栏：`bubbleTops` 测量布局 + 防重叠、scroll-spy `activeCommentId`、J/K 跳转、折叠 `collapsed`、拖宽 `useResizable`、数量 badge
- 评论内联编辑（`editingId`/`editDraft`）、复制到剪贴板（`copiedId`/`copyFailedId`）
- 选区 → 评论 popover（`popover` + `crossHeadingHint` 跨标题提示）
- 评论 **新增 / 编辑 / 删除** mutation（均以 `docVersionId` 为键）
- 共用 ref：`markdownRef` + `bubblesRef`（必须同组件内共址，气泡测量依赖二者相对 rect）

**留在各自页面（不进 pane）：**

| 关注点 | 归属 | 原因 |
|---|---|---|
| 数据请求（detail / version-body / versions） | 页面 | 单/多文档取数来源不同；pane 只收 `body`/`comments` |
| diff 模式 + 历史版本（`?version=`） | 单文档路由 | 多文档无此概念 |
| 整篇决策 approve/iterate/reject（`/decision`） | 各页面 | 单=整篇、多=轮级，语义不同 |
| 每篇采纳/不采纳（`/selection`） | 多文档页 | 多文档独有 |
| 左侧文档导航列表 | 多文档页 | 多文档独有；独立滚动 |
| 视口适配 / 滚动容器骨架 | 各页面 CSS | 见 §4 |

## 2. 接口契约

```ts
// components/review/ReviewDocPane.tsx
export interface ReviewDocPaneProps {
  nodeRunId: string
  /** 评论挂靠的 doc_version；单文档=currentVersion.id，多文档=当前选中篇。 */
  docVersionId: string
  /** 已解析的正文 markdown。父级负责取数（含 loading），pane 只渲染。 */
  body: string
  comments: ReviewComment[]
  /** 历史只读 或 非 awaiting 时为 true：禁用选区评论 / 编辑 / 删除。 */
  readonly: boolean
  /** plantuml 透传（来自 /api/config）。 */
  plantumlEndpoint?: string
  plantumlAuthHeader?: string
  /** 评论增删改成功后回调，父级据此 invalidate 对应 query。 */
  onInvalidate: () => Promise<void>
}
```

要点：

- **两页都已经在评论 POST 里传 `docVersionId`**（单文档 `reviews.detail.tsx:324/340/464`、多文档 `MultiDocReviewView.tsx`），所以 pane 自管 mutation 不引入新后端契约——只是把现有调用搬进来，键统一为 `props.docVersionId`。
- 侧栏折叠 / 宽度仍走 `useResizable` + 既有 localStorage key（**OQ-1 定稿：共享同一组 key**，两页体验一致、偏好跨页保留）。
- `onInvalidate` 由父级提供：单文档 invalidate `['reviews','detail',id]`（+ 历史模式对应 version-body）；多文档 invalidate `['reviews','detail',id]` 与 `['reviews','version-body',id,docId]`（即 MultiDocReviewView 现有 `invalidate`）。

## 3. 数据流

```
页面（取数 + 决策 + 导航）
  └─ <ReviewDocPane nodeRunId docVersionId body comments readonly … onInvalidate />
        ├─ <Prose anchors={proseAnchors}>            // 正文 + 选区高亮
        ├─ useCommentBubbles(markdownRef, bubblesRef, sortedComments)  // OQ-3：测量布局纯逻辑
        ├─ 选区 onMouseUp → computeAnchorFromSelection → popover → POST /comments → onInvalidate
        ├─ 内联编辑 → PATCH /comments/:id → onInvalidate
        └─ 删除 → DELETE /comments/:id → onInvalidate
```

- 单文档：`body=activeBody`、`comments=activeComments`（current 或 historical）、`docVersionId=currentVersion.id`（历史模式用历史 vid）、`readonly=view.mode==='historical'`。diff 分支不渲染 pane（仍渲染 `<DiffView>`）。
- 多文档：`body=isFirst?currentBody:selectedDoc.body`、`comments=…`、`docVersionId=activeDocId`、`readonly=!awaiting`。pane 外包：左导航 + 每篇采纳/不采纳 + 轮级决策 + Dialog。

## 4. 与现有模块的耦合点

1. **CSS 命名空间**：pane 沿用单文档页既有 `.review-detail__*`（layout/body/bubbles/sidebar-*）class，避免重写一套样式（符合 UI 一致性原则）。多文档页外层骨架保留 2026-06-04 的视口适配契约（`.page.review-multidoc` flex 满高、`.review-multidoc__list` 独立滚动、`.review-multidoc__scroll` 容器），但把"本文+评论"替换为 `<ReviewDocPane>`（它内部即 `.review-detail__layout` 滚动模型）。`reviews-multidoc-viewport-fit.test.ts` 随之更新。
2. **`useResizable`**（`hooks/useResizable.ts`）：直接复用，不改。
3. **`<Prose>` + `computeAnchorFromSelection`**：已是共享原语，pane 内继续调用。
4. **i18n**：评论侧栏文案沿用 `reviews.*` 既有 key；多文档页删掉的扁平列表所用 `reviews.multiDoc.noComments` 等若不再引用则保留 key（避免误删他人引用，符合多人协作原则），在 plan 里标注。
5. **路由**：`reviews.detail.tsx` 与 `MultiDocReviewView.tsx` 都改为消费 pane；路由挂载分流（单 vs 多文档）逻辑不变。

## 5. 失败模式与防护

| 风险 | 表现 | 防护 |
|---|---|---|
| 气泡测量回归 | 抽取后 `bubbleTops` 定位错乱 / 重叠 / 跳到 0 | 把测量逻辑抽成 `useCommentBubbles` 纯函数预言（输入 anchor rects + 高度 → tops），单测覆盖防重叠下移、orphan 锚点、header floor；保留单文档 RFC-009 既有集成测试 |
| 单文档静默回归 | diff/历史/快捷键/持久化行为变化 | 单文档 RFC-005/008/009/013 全套测试不改且必须全绿；源代码层断言 `reviews.detail.tsx` 仍渲染 `<ReviewDocPane>` |
| readonly 漏判 | 历史视图能误改评论 | pane 用单一 `readonly` 开关统一门禁选区/编辑/删除；测试断言 readonly 下不渲染 popover/编辑/删除入口 |
| docVersionId 错挂 | 多文档评论挂错篇 | pane 一切 mutation 以 `props.docVersionId` 为键；多文档切换文档时 key 随 `activeDocId` 变更，加断言 |
| 多人协作冲突 | 与他人在途改动撞同函数 | 抽取期若发现工作树他人改了 `reviews.detail.tsx` 同段，先停下问用户（CLAUDE.md 协作原则），不单方面覆盖 |

## 6. 测试策略（design.md §测试策略，PR 必须全绿）

**必写：**

1. `useCommentBubbles`（或等价纯函数）单测：
   - 多条评论按 anchor offset 排序、自上而下防重叠（cursor 下移）
   - sticky header floor（首气泡不被 header 压住）
   - orphan / 未定位锚点不塌到 top=0
2. selection→anchor 边界（已存在 `computeAnchorFromSelection` 测试，确认仍覆盖；如逻辑搬动则迁移断言）
3. 单文档零回归锁：现有 `review-detail-*` / `reviews-detail-*` / `review-sidebar-rfc-009-*` 测试**不改**且全绿；新增源代码层断言「`reviews.detail.tsx` 非 diff 分支渲染 `<ReviewDocPane>`」。
4. 多文档复用锁：源代码层断言「`MultiDocReviewView.tsx` 渲染 `<ReviewDocPane>` 且不再含自写的 `review-multidoc__comment`（单数）列表项 / 选区 popover」；`reviews-multidoc-viewport-fit.test.ts` 更新为「评论由 ReviewDocPane 承担、左列表独立滚动」。
5. pane readonly 门禁断言：readonly=true 时无选区 popover / 无编辑 / 无删除入口。

**回归命名**：测试文件顶部注释链接本 RFC，写明锁的是「ReviewDocPane 抽取后单文档零回归 / 多文档复用」。

**运行门槛**：`bun run typecheck && bun run test && bun run format:check` 全绿；push 后查 CI（按 feedback_post_commit_ci_check）。单二进制 smoke 关注：抽取若动 shared 导出会有模块初始化环风险（参考 reference_binary_build_module_cycle），但本 RFC 仅前端组件抽取、不动 shared barrel，风险低，仍以 CI 单二进制 job 兜底。

## 7. 开放问题定稿

- **OQ-1**：折叠/宽度持久化 → **共享同一组 localStorage key**。
- **OQ-2**：评论 mutation → **pane 自管**（靠 `docVersionId` + `onInvalidate`）。
- **OQ-3**：气泡测量 → **抽 `useCommentBubbles` hook**，便于纯逻辑单测。
- **OQ-4**：与未提交布局修复的关系 → 见 plan.md（建议 PR-0 先合布局修复止血，PR-A/B 做抽取复用）。
