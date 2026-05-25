# RFC-065 — 任务分解

单 PR 即可交付（self-contained，零 schema / migration）。task id 前缀
`RFC-065-T*`。

## 任务清单

### RFC-065-T1 — shared 类型与 schema
- 新文件 `packages/shared/src/worktree-files.ts`：`WorktreeTreeEntry` /
  `WorktreeTreeResponse` / `WorktreeFileResponse` 三个 zod schema +
  TypeScript 类型。
- `packages/shared/src/index.ts` re-export。
- 单测：3 case 验证 schema parse / reject（合法、缺字段、size 负数）。

### RFC-065-T2 — `services/worktreeFiles.ts` 纯函数
- `listWorktreeDir(worktreePath, relPath)`：sort + filter `.git` +
  symlink-out-of-root 检测 + 5000 截断。
- `readWorktreeFile(worktreePath, relPath)`：stat → 大小判定 → ≤ 2
  MiB 时 UTF-8 解码（fatal:false 容忍非法字节）。
- 新增 `util/safePath.ts` 的 `resolveInsideWorktree(root, rel)` helper
  （或在 `worktreeFiles.ts` 内部封装；二选一不引入大改）。
- 单测 ≥ 15 case（见 design §4.1）。

### RFC-065-T3 — 路由 `routes/tasks.ts` 挂载
- `GET /api/tasks/:taskId/worktree-tree?path=...` → 调 T2.list。
- `GET /api/tasks/:taskId/worktree-file?path=...` → 调 T2.read。
- 200 / 400 / 404 错误 code 与 design §1 对齐。
- 集成测 ≥ 7 case（见 design §4.2）。
- **不**新建 `routes/worktree-files.ts` 同名文件——挂在既有 `tasks.ts`
  里维持路由聚合。

### RFC-065-T4 — `lib/task-detail-tabs.ts` 加 tab
- 类型 `TaskDetailTab` 加 `'worktree-files'`。
- `TAB_ORDER` 在 `'outputs'` 与 `'worktree-diff'` 之间插入。
- `availableTabs` 保留现有过滤逻辑（不过滤新 tab）。
- 单测：3 case（见 design §4.3）。

### RFC-065-T5 — i18n key
- `zh-CN.ts` / `en-US.ts` 新增：
  - `tasks.tabWorktreeFiles`：`工作目录` / `Worktree files`
  - `tasks.worktreeFilesEmpty`：`从左侧选择一个文件以预览` / `Select a
    file from the left to preview`
  - `tasks.worktreeFilesNoWorktree`：`该任务没有可用工作目录` / `This
    task has no worktree`
  - `tasks.worktreeFilesOversized`：`文件过大（{{size}}），超过
    {{limit}} 阈值，未预览` / `File too large ({{size}}), exceeds
    {{limit}}; preview skipped`
  - `tasks.worktreeFilesTruncated`：`已隐藏 {{n}} 项（仅展示前
    {{limit}}）` / `{{n}} more entries hidden (showing first {{limit}})`
  - `tasks.worktreeFilesLoadError`：`目录加载失败` / `Failed to load
    directory`
  - `tasks.worktreeFilesPathHeader`：`路径` / `Path`
  - `tasks.worktreeFilesSizeHeader`：`大小` / `Size`
- 同时更新 `zh-CN.ts` 顶部类型声明块。

### RFC-065-T6 — 组件落地
- `components/WorktreeFilePreview.tsx`：右侧预览（query + EmptyState /
  LoadingState / ErrorBanner / oversized 提示 / `<pre>`）。
- `components/WorktreeFileTree.tsx`：递归树（`<DirChildren>` 单独抽出，
  query per dir）；展开 / 折叠按钮、选中态。
- `components/WorktreeFilesPanel.tsx`：容器 + 状态。
- 复用既有 `EmptyState` / `LoadingState` / `ErrorBanner`；不写新 chrome。
- 单测 ≥ 8 case（见 design §4.4）。

### RFC-065-T7 — 路由层接入
- `routes/tasks.detail.tsx` 加 pane（`hidden={tab !== 'worktree-files'}`），
  放在 outputs 与 worktree-diff 之间。
- `tabLabel` switch case 增 `worktree-files`。
- 当 `tk.worktreePath === ''` 时显示 NoWorktree 提示，不挂组件。
- 集成测：`task-detail-page-tabs.test.tsx` 已锁 tab list 顺序，本步只
  追加一条 case 确认 worktree-files pane 渲染。

### RFC-065-T8 — 样式
- `styles.css` 新增 `.worktree-files-panel` / `.worktree-files-tree` /
  `.worktree-files-preview` 系列（design §2.7）。
- 视口对齐：与 `.task-detail__panes` `flex: 1; min-height: 0` 协同；
  左侧 `min-width: 220px; max-width: 320px`。
- 移动端：保持当前布局；若 viewport < 600px 后续考虑收起左侧，但 v1
  不做。
- 不增加新 CSS 变量，全部走既有 `--spacing-*` / `--surface-*` /
  `--border` token。

### RFC-065-T9 — 源码层守门
- 新增 `tests/source/worktree-files-tab-source.test.ts`（位置参考既有
  `task-canvas-layout-class.test.ts`）。
- 锁定 design §4.5 的 3 条字面量断言。

### RFC-065-T10 — STATE.md + plan.md 索引
- `design/plan.md` RFC 索引表加 `| [RFC-065](...) | Task Worktree
  Files Tab — ... | In Progress |` 行（实施开始时改 In Progress，PR
  合并时改 Done）。
- `STATE.md` 顶部"进行中 RFC"行追加 RFC-065 草稿指针；PR 合并后挪入
  已完成。

### RFC-065-T11 — 合一 PR + 验证
- commit message：`feat(frontend,backend): RFC-065 任务详情页工作目录
  tab`。
- 跑 `bun run typecheck && bun run test && bun run format:check`；
  push 后立刻按 [feedback_post_commit_ci_check] 查 GitHub Actions 状
  态。
- 启动本地 dev server，浏览器手动验证：
  - 默认进入任务详情 → 切到工作目录 tab → 看到根目录子项、文件夹收
    起。
  - 展开 3 层、点开一个 `<pre>` 文件、点开一个超大文件看 oversized
    提示。
  - 切到其它 tab 再切回来，展开 / 选中状态留存。

## PR 拆分

**默认单 PR**（共 backend ~250 LOC + frontend ~400 LOC + tests ~600
LOC）。若 review 反馈需要拆，备选拆法：
- PR-A：T1-T3（shared schema + 后端两条路由 + 后端测试），可独立部署，
  前端零行变更。
- PR-B：T4-T9（前端 tab + 组件 + 测试）。

但 v1 不预拆，沿用最近 RFC-063 / RFC-062 单 PR 模式。

## 验收清单（PR 合并门槛）

- [ ] 所有 design §4 列出的测试落地且全绿。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全
  绿。
- [ ] GitHub Actions（含 build smoke + Playwright e2e）全绿。
- [ ] 手动 UAT 三条路径（普通文件 / oversized / 切 tab 状态留存）通过。
- [ ] `STATE.md` 已完成 issue 表加一行 RFC-065 Done；`plan.md` 索引
  改 Done。
- [ ] commit 没有捎带删除他人代码、没有 `git add -A` 误纳无关 untracked
  文件（CLAUDE.md 多人协作规则）。

## 风险与回退

- 单 PR 体积稍大但模块边界清晰；如真出回退需要，回滚单一 commit 即可。
- 后端两条新路由零侵入既有路由；rollback 不影响 reviews 图片显示。
