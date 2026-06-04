# RFC-082 — 评审文档面板（ReviewDocPane）抽取与多文档复用

状态：Draft
作者：Claude（应用户 2026-06-04 要求）
依赖：RFC-005（人工评审节点）、RFC-009（评论侧栏增强：内联编辑/复制/折叠/拖宽/行号）、RFC-079（多文档评审）、RFC-081（多文档泛化到内联 `list<markdown>`）

## 背景

单文档评审页 `routes/reviews.detail.tsx`（约 1495 行）里，"渲染一篇 markdown + 富评论侧栏"的整套能力是**内联**在路由组件里的，并非可复用组件。这套能力包含（多为 RFC-008 / RFC-009 投入）：

- 正文 Premium Markdown 渲染（`<Prose anchors>`，正文内选区高亮锚点）
- **锚定评论气泡**：每条评论卡片 `position:absolute` 定位到其引用正文旁，随正文滚动；靠 `ResizeObserver` + 测量 anchor rect 实时算 `bubbleTops` 并做防重叠下移
- 侧栏**可折叠 / 可拖拽改宽**（`useResizable` + localStorage 持久化）
- **scroll-spy**：高亮当前视口顶部评论
- **J/K 跳转**上一条 / 下一条评论
- 评论**内联编辑**、**复制到剪贴板**、数量 badge
- 选区 → 评论 popover（含跨标题选区提示 `crossHeadingHint`）
- 评论的新增 / 编辑 / 删除 mutation

多文档评审页 `components/review/MultiDocReviewView.tsx`（RFC-079/081）当时为了快速落地，**复用了原语**（`Prose`、`computeAnchorFromSelection`、评论/选择/裁决 API、`Dialog`/`TextArea`/`StatusChip`），但右侧评论栏**自己写了个扁平列表**，没有把上面那套气泡能力搬过来。结果：

- 多文档页每篇文档的评论体验明显弱于单文档页（无气泡锚定、无折叠/拖宽/跳转/内联编辑/复制）。
- 两套 UI 风格与交互不一致，违反 CLAUDE.md「前台界面统一风格」原则。
- 同类 bug / 改进要改两处（典型：2026-06-04 的评论栏滚动跟随问题，单文档页天然正确、多文档页要单独修）。

> 触发事件：2026-06-04 用户在多文档评审页发现"左侧文档列表溢出页面 + 右侧评论栏不跟随滚动"，追问"为什么不复用单个文档的页面能力"。临时已做了一版"对齐滚动模型"的布局修复（把本文+评论收进一个共享滚动区），但那只是把滚动模型对齐，并未真正复用单文档页的气泡/折叠/跳转等能力——本 RFC 解决根因。

## 目标

1. 把单文档评审页里"渲染一篇 markdown + 锚定评论侧栏 + 评论增删改 + 选区评论"的能力抽成一个**共享组件 `<ReviewDocPane>`**，放在 `components/review/` 下，作为公共原语。
2. **单文档评审页改用 `<ReviewDocPane>`**，保持现有行为零回归（diff 模式、历史版本、整篇决策仍由路由负责，包在 pane 外）。
3. **多文档评审页改用 `<ReviewDocPane>`** 渲染当前选中文档，从而免费获得气泡/折叠/拖宽/跳转/内联编辑/复制等全部能力；左侧文档导航、每篇采纳/不采纳、轮级三决策仍由多文档页负责，包在 pane 外。
4. 删除 `MultiDocReviewView` 里自写的扁平评论列表与重复的选区/ popover 逻辑（被 pane 取代）。

## 非目标

- **不改后端 / 数据模型 / API**：评论、selection、决策端点与 `DocVersionWithBodyAndComments` 形状一律不动。
- **不改评审业务语义**：单文档三决策、多文档逐篇采纳 + 轮级三决策、iterate/reject 行为全部保持。
- **不做 diff 模式 / 历史版本的多文档化**：这些仍是单文档页专属，留在路由层，不进 `<ReviewDocPane>`。
- 不新增评论能力（不在本 RFC 里发明新交互）；本 RFC 是**等能力抽取 + 复用**，不是功能增强。
- 不动画布 / 收件箱 / 其它页面。

## 用户故事

- 作为评审者，在**多文档评审**页逐篇看用例时，我希望评论像单文档页一样**锚定在对应正文旁、随文滚动**，能折叠/拖宽侧栏、用 J/K 在评论间跳转、内联编辑和复制评论——和单文档页体验一致。
- 作为维护者，我希望"一篇 markdown + 评论侧栏"只有**一份实现**，改一处两个页面同时受益，不再出现"单文档对、多文档错"的同形 bug。
- 作为评审者，在单文档页我**察觉不到任何变化**（diff、历史版本、整篇决策、所有快捷键和持久化偏好都和以前一样）。

## 验收标准

1. 新增 `components/review/ReviewDocPane.tsx`，封装：`<Prose anchors>` 正文 + 锚定气泡侧栏（折叠/拖宽/scroll-spy/J-K 跳转/内联编辑/复制/数量 badge）+ 选区 popover + 评论增删改。
2. 单文档评审页（非 diff 分支）渲染 `<ReviewDocPane>`；**RFC-005/008/009/013 既有测试全绿、零回归**（diff、历史版本、跨标题提示、侧栏持久化、快捷键均不变）。
3. 多文档评审页对**当前选中文档**渲染 `<ReviewDocPane>`；切换文档时正文 + 评论随之更新；左侧导航独立滚动、整页不出现文档级滚动条（保留 2026-06-04 布局修复的视口适配契约）。
4. 多文档页**自写的扁平评论列表 `.review-multidoc__comments` 及其选区/popover 代码被删除**，由 pane 取代；`reviews-multidoc-viewport-fit` 回归锁更新为「评论由 ReviewDocPane 渲染」。
5. `bun run typecheck && bun run test && bun run format:check` 全绿；CI（双 OS lint/typecheck/test + 单二进制 smoke + Playwright e2e）全绿。
6. 新增/迁移测试覆盖：pane 的纯函数预言（气泡排序/防重叠定位、selection→anchor 边界）、单文档零回归锁、多文档复用 pane 的源代码层断言。

## 开放问题（实现前在 design.md 定稿）

- **OQ-1 侧栏折叠/宽度持久化的作用域**：localStorage key 是全局共享，还是单/多文档各一套？（倾向共享同一 key，体验一致。）
- **OQ-2 评论 mutation 归属**：mutation 放进 `<ReviewDocPane>` 内部（pane 自管，靠 `docVersionId` + `onInvalidate` 回调），还是由调用方注入？（倾向 pane 自管，最大化复用。）
- **OQ-3 拆分粒度**：是否进一步把"气泡测量布局"抽成 `useCommentBubbles` hook？（倾向是，便于单测纯逻辑。）
- **OQ-4 与未提交布局修复的关系**：先把 2026-06-04 布局修复作为过渡单独提交，还是直接并入本 RFC 的多文档改造？（见 plan.md。）
