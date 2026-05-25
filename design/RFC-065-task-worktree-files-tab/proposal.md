# RFC-065 — 任务详情页工作目录 Tab

## 背景

`/tasks/$id` 详情页当前有 6 个 tab（RFC-021 / RFC-041 PR4 落地）：
`workflow-status → node-runs → details → outputs → worktree-diff →
feedback`。其中 `worktree-diff` 只展示 **相对 `baseCommit` 的改动**（含
未提交 hunks）——但用户实际看任务结果时，常常需要看完整的工作目录树，
比如：

- 任务跑完后想看 worker 在 worktree 里**新建了哪些 untracked 但还没纳入
  diff 处理的辅助文件**（典型例子：opencode plugin 产物、日志、缓存）。
- diff 太大 / 文件改名混乱时想直接挑一个完整文件读，而不是隔着 hunk 拼。
- 任务出错时想看一眼 worktree 里某个非改动文件的原貌（依赖配置、
  package.json、agent.md 等）确认上下文。

目前唯一的入口是后端 `GET /api/worktree-files/:taskId/*`（RFC-005
PR-B T13），只支持"已知相对路径 → 拉文件流"，没有目录列举能力，前端只
在 reviews markdown 里通过相对路径反查图片。这次给任务详情页正式补一个
**整棵工作目录的浏览器**。

## 目标

- 任务详情页新增一个 tab `工作目录` / `Worktree files`，**位置在 `outputs`
  与 `worktree-diff` 之间**（用户指定）。
- 左侧：当前任务 worktree 根目录的**目录树**。
  - 默认所有文件夹**收起**；点击文件夹切换展开 / 收起；展开时**按需**
    向后端拉该目录的直接子项（lazy load），不一次性灌全树。
  - 子项排序：目录优先 → 文件，组内按文件名 `localeCompare` 升序。
  - `.git/` 目录始终隐藏（worktree 自带的 `.git` 文件 / 目录、子模块
    `.git` 文件同理）；其它一切（包括 `node_modules` / `.opencode/` /
    `.gitignore` 命中的 untracked）正常展示——任务 worktree 是给用户排
    查问题用的，不做静默过滤。
- 右侧：文件预览面板。
  - 点击左侧任一**文件**节点时切到该文件；点击目录节点只展开 / 收起，
    不影响右侧预览。
  - 文件内容**作为纯文本展示**（`<pre>` + monospace），不渲染 markdown
    / 不语法高亮 / 不 iframe HTML。这是用户明确要求的（"文件内容不渲
    染，文本展示"）。
  - 文件大小 > **2 MiB**（2 × 1024 × 1024 字节）时**不预览**，直接显示
    "文件过大，未预览" + 文件实际字节数 / 路径 / 大小阈值。
- 默认右侧空态：未选中任何文件时显示提示语 "从左侧选择一个文件以预览"。
- tab 切换不丢已展开的目录状态、已选中的文件、滚动位置（与其它 tab 一
  致，`hidden` 切换，不卸载组件）。

## 非目标

- **不**编辑 worktree 文件（只读浏览器）。
- **不**做语法高亮 / markdown 渲染 / 图片 thumbnail（图片文件按文本展
  示可能乱码，用户已知；如果未来要支持图片预览另立 RFC）。
- **不**做全文搜索 / 过滤框（v1 极简；后续如有需要再开 RFC）。
- **不**支持多选、复制路径、下载、右键菜单等高级动作（v1 只点击）。
- **不**改 `worktree-diff` tab 任何行为；不改 `GET /api/worktree-files/
  :taskId/*` 已有路由签名（reviews 图片仍按原行为工作）。
- **不**把 tab 状态 / 选中文件挂到 URL（保持与 RFC-021 一致，session
  内 React state）。

## 用户故事

1. **看 untracked 辅助文件**：任务跑完，切到 `工作目录` tab，展开根目
   录看到一个 `tmp-debug.log`（worker 没 `git add`），点开右侧看内容确
   认日志哪里出错。
2. **挑文件读 / 不走 diff**：worktree-diff 显示 30 个文件改动太挤，用
   户切到 `工作目录` tab，定位到 `packages/backend/src/foo.ts` 完整读
   它，跟 diff 里的 hunk 互参。
3. **任务失败排错**：任务报错说"找不到 `agent.md` 里某个 skill"，用户
   到 `工作目录` 里看 `.opencode/agent.md` 完整文本，定位 frontmatter
   写错。
4. **太大文件不卡前端**：用户点开一个 50 MB 的 sqlite dump，右侧显示
   "文件过大（52 MB），超过 2 MiB 阈值，未预览"——不会因为前端 fetch
   一个超大 body 卡死。
5. **保留浏览状态**：用户在 `工作目录` 展开了 3 层目录，切到 `worktree-
   diff` 再切回来，3 层目录与选中文件**仍在**（不重新折叠）。

## 验收标准

1. ✅ `availableTabs` 输出 7 个 tab，顺序固定为
   `['workflow-status', 'node-runs', 'details', 'outputs',
   'worktree-files', 'worktree-diff', 'feedback']`，`outputs` 在
   workflow 无 output 节点时仍被过滤。`worktree-files` tab **始终出现**
   （不像 outputs 那样按条件隐藏；worktree 是任务的客观资源，永远值得
   浏览）。
2. ✅ 默认进入 tab 时左侧只展示根目录直接子项；所有目录初始收起。
3. ✅ 点击目录节点切换展开 / 收起；首次展开通过 `GET /api/tasks/:taskId/
   worktree-tree?path=<rel>` 拉子项；后续展开 / 收起不重复拉取（前端缓
   存）。
4. ✅ `.git` 目录 / `.git` 文件（子模块）在任何层级都不出现在树里。
5. ✅ 子项排序：目录优先；同类按 `localeCompare` 升序。
6. ✅ 点击文件触发 `GET /api/tasks/:taskId/worktree-file?path=<rel>`；
   返回 `{ size, content, oversized }`。`oversized: true` 时
   `content === ''` 且 `size` 是真实文件大小（字节）。
7. ✅ 文件 ≤ 2 MiB 时右侧以 `<pre>` + monospace 显示 `content`；> 2 MiB
   时显示"文件过大"提示（含真实大小 + 阈值 + 相对路径）。
8. ✅ 路径越界（`..` / 绝对路径 / 解析后跳出 worktree）均返回 400 +
   稳定 errorCode，前端落到错误 banner。
9. ✅ 任务无 worktree（极少数 `worktreePath === ''` 老任务）时 tab 内
   显示"该任务没有可用工作目录"提示，**不**调用后端。
10. ✅ 切换 tab 不丢已展开的目录状态、已选中的文件路径、左右两栏的滚
    动位置（与既有 tab 一致：`hidden` 切换，不卸载）。
11. ✅ 整页仍无文档级滚动条（与 RFC-021 锁定的视口铺满约束一致）；左
    侧树自身可滚，右侧预览自身可滚。
12. ✅ 既有 6 个 tab 行为零退化（特别是 `worktree-diff` 与 `outputs`）；
    `GET /api/worktree-files/:taskId/*` reviews 图片路径仍工作。

## 影响范围

- **后端**：新增两条路由（`GET /api/tasks/:taskId/worktree-tree` /
  `GET /api/tasks/:taskId/worktree-file`），共享 `task.worktreePath` +
  `safePath` 越界保护；新增 `services/worktreeFiles.ts`（list-dir +
  read-bounded-file 两个纯函数）。**不**改 `worktree-files.ts` 旧路由。
- **前端**：新增 `components/WorktreeFilesPanel.tsx` + 子组件
  `WorktreeFileTree.tsx` / `WorktreeFilePreview.tsx`；
  `routes/tasks.detail.tsx` 加一个 pane；
  `lib/task-detail-tabs.ts` 把 `'worktree-files'` 插进 `TAB_ORDER`；
  `i18n/{zh-CN,en-US}.ts` 新增 ~8 个 key（tab label + 空态 + oversized
  提示 + 错误描述 + meta）。
  `styles.css` 加 `.worktree-files-panel` / `.worktree-files-tree` /
  `.worktree-files-preview` 系列规则（左右两栏 split + 各自独立滚动）。
- **shared**：新增 `WorktreeTreeEntry` / `WorktreeFileContent` 类型 +
  zod schema（与后端契约对齐）。
- **schema / migration / runner / scheduler / runtime**：零 LOC。

## 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 大目录（如 `node_modules` 万级 entry）一次列举体积爆炸 | 服务端按 1 个目录直接子项返回，单层最多 5000 条上限 + 截断标记；万级目录前端给"已截断，仅显示前 N 项"提示。 |
| 二进制文件按文本展示乱码 | v1 按用户明确要求"文本展示，不渲染"；后续 RFC 可加二进制识别 + "is binary, not previewed" 分支。这次留在文档里登记为已知项，不修。 |
| 符号链接指向 worktree 外 | `services/worktreeFiles.ts` 在 list-dir 时 `realpath` 校验目标仍在 worktree 内；越界条目直接跳过（不当成错误，避免列举抖动）。 |
| 任务被取消但 worktree 还在 | tab 行为不变，正常列举（取消后保留 worktree 是产品决策，浏览能力应该可用）。 |
| `.git` 目录隐藏后用户误以为是 bug | tab 内 footer 加一行小字提示"已隐藏 `.git/`"（i18n key）；非必需，列入 plan T7 可选项。 |
| 服务端读 2 MiB 文件 + JSON 编码内存 spike | 用 `Bun.file(path).slice(0, 2 * 1024 * 1024).text()` 流式读上界字节后停手；并发受 Bun 默认 fd 上限保护，不再额外加 semaphore。|
| 树状态前端缓存爆炸（用户递归展开 1000 个目录） | 缓存仅存 `pathStr → entries[]` Map，单 entry 元数据 < 200B；1000 目录约 0.2 MB，可接受。|

## 不走 RFC 的部分

- `lib/task-detail-tabs.ts` 的 `TAB_ORDER` 增量（加一个枚举值）虽然是行
  为变更，但被本 RFC 覆盖；不单独立 RFC。
