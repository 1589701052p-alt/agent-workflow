# RFC-009 — Review 评论侧栏功能增强（借鉴 md-review）

## 背景

`d9072c6 fix(review): redesign comment sidebar as scroll-tracking bubbles` 把 `/reviews/:nodeRunId` 的评论侧栏改成了 `position: absolute` 滚动跟随气泡——气泡跟着 `<mark.comment-anchor>` 浮动，配 `IntersectionObserver` 选中态、`ResizeObserver` 重定位、J/K 快捷键导航。架构上比同类工具（`/Users/wangbinquan/Documents/code/md-review`，npm 全局 CLI 的轻量 Markdown 评注器）更进一步，但**功能层缺一截**：

- 无法编辑已提交评论（写错只能删了重发）
- 无复制按钮（要从 DOM 选中再复制）
- 没有评论总数显示（用户感觉不到"还有几条没回"）
- 侧栏宽度固定 280px，不能折叠、不能拖宽（屏幕窄时主区域被挤）
- 没有行号辅助标签（光看 selectedText 引用不知道在文档哪段）

md-review 的右边栏功能层很完整（行号跳转 / 引用 / 正文 / 内联编辑 / 复制 / 删除 / 数量 badge / 可折叠 / 可拖宽），值得借鉴；但它把"评论列表"做成一个普通滚动列，**没有滚动跟随**——这是我们 d9072c6 已经赢的部分，不能丢。

## 目标

把 md-review 右边栏的功能补齐到本项目的滚动跟随气泡架构里，**但不动锚定层**（`anchor.selectedText + occurrenceIndex` + `wrapAnchorsInDom`）。

具体补齐：

1. **内联编辑**：编辑按钮 → textarea 替换正文 → Cmd/Ctrl+Enter 保存 / Esc 取消。后端补 `PATCH /api/reviews/:nodeRunId/comments/:commentId`。
2. **复制按钮**：一键拷贝评论正文到剪贴板，按钮临时切到"已复制"提示。
3. **评论数量 badge**：sticky 顶栏显示 `评论 · {count}`。
4. **侧栏可折叠**：右上角 `‹›` 切换；折叠后变 32px 竖向 rail，主区域回收宽度；状态写 localStorage。
5. **侧栏可拖宽**：左缘 4px resizer，宽度区间 240–520px，写 localStorage。
6. **辅助行号**：每张评论卡顶部除 `sectionPath` 外，加 `Line N` 或 `Line N–M` 灰文。从 `currentBody + anchor.offsetStart/offsetEnd` 现场算，不改 schema。

## 非目标

- **不动锚定**：仍用 `selectedText + occurrenceIndex` 文本搜索 + `wrapAnchorsInDom` 包 `<mark>`。**不**像 md-review 那样在 Prose 渲染时给每个块元素打 `data-line-start`（那会动 schema + 渲染器，超 RFC 范围）。
- **不引入 reply 线程**：评论保持平铺，无父子结构。
- **不改 DiffView**：diff 模式下侧栏行为保持现状（diff 时不显示气泡）。
- **不改 popover**（新建评论入口）：现有 `Cmd+Enter` 提交 / `Esc` 取消已经和 md-review 一致，不动。

## 用户故事

- **评审者**：写完一条评论按下提交后发现错别字，**点编辑按钮**直接在原卡片上改、Cmd+Enter 保存，不必删了重发。
- **评审者**：屏幕宽时把右边栏**拖到 420px** 让评论正文显示更多；屏幕窄时**折叠**让主文档完整呈现；下次打开记得。
- **评审协调者**：扫一眼侧栏顶部就知道**这个 review 有 12 条评论**，不必滚到底数。
- **被评审者（迭代修正时）**：每条评论卡显示 **`Line 47–52`**，能直接定位到文档段落，配合 J/K 键巡视全部反馈。

## 验收标准

1. 编辑：点编辑按钮 → textarea 出现并预填、autoFocus；Cmd+Enter 调 PATCH 成功后退出编辑态、UI 显示新正文；Esc 取消不调 API；空文本 disabled 保存。
2. 复制：点复制 → 剪贴板内容等于评论正文；按钮 1.5s 内显示"已复制"；可重复复制多次。
3. 数量 badge：sticky 顶栏显示 `评论 · {count}`，sortedComments 变更时 count 同步；count=0 时仍显示（不隐藏）。
4. 折叠：点折叠 → 列变 32px rail、气泡列隐藏、主区域宽度回收；点展开 → 恢复（包括上次的自定义宽度）；刷新页面 → 折叠态恢复。
5. 拖宽：拖左缘 → 宽度跟随，clamp 到 [240, 520]；松开 → 持久化；刷新页面 → 宽度恢复。
6. 行号：每条评论卡显示 `Line N` 或 `Line N–M`（单行 / 跨行自动判别）；点击该 chip 行为 = 点评论卡（滚到锚点）。
7. !awaitingReview（已批 / 已拒 / 已迭代）：编辑、删除、复制按钮中——**编辑、删除 disabled，复制保留**（只读用例下复制是合理的）。
8. 多 tab 同步：A tab 编辑评论后，B tab 通过 `/ws/tasks/{taskId}` 的 `review.comment.updated` 事件刷新；现有 useTaskSync 已覆盖 `review.*` 通配，后端只需发对的事件名。
9. 既有 J/K 导航、IntersectionObserver 高亮、ResizeObserver 重定位、wrapAnchorsInDom 锚——回归测试全部不变。
