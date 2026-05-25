# RFC-065 — 技术设计

## 1. 后端契约

### 1.1 `GET /api/tasks/:taskId/worktree-tree`

列举单个目录的直接子项（**lazy**，不递归）。

- Query param `path`（必填）：相对 `task.worktreePath` 的路径，UTF-8、
  使用 `/` 分隔。**空串视为根**（即 worktree 根目录本身）。前导 `/`、
  `.` / `..` 段、Windows 反斜杠均拒。
- 解析逻辑：`resolve(task.worktreePath, path)`，再做"必须 === root 或
  以 `root + sep` 开头"的越界校验（沿用 `routes/worktree-files.ts:64-71`
  原模式）。
- 目录不存在 / 不是目录 → `404 ValidationError` 不区分（避免泄漏文件系
  统结构）。
- 路径合法但 `realpath` 后落到 worktree 外（symlink 越界）→ `400
  worktree-tree-escapes-worktree`。

返回（200）：

```ts
type WorktreeTreeResponse = {
  path: string            // echo back the requested relative path
  entries: WorktreeTreeEntry[]
  truncated: boolean      // true if 子项 > MAX_ENTRIES (5000)
}

type WorktreeTreeEntry = {
  name: string            // basename only, no path separator
  kind: 'file' | 'directory'
  size: number | null     // bytes; null when kind === 'directory'
}
```

排序（服务端固定）：`kind === 'directory'` 排前；同类按
`name.localeCompare(other, 'en', { sensitivity: 'base' })`。前端不再二
次排序，避免与后端不一致。

过滤（服务端固定）：
- `name === '.git'` 永远剔除（不管是目录还是文件——子模块的 `.git`
  是个 gitlink 文件）。
- symlink → 用 `lstat` 拿到类型；目标 `realpath` 跳出 root 时**整条**
  剔除，不出现在 entries 里。

性能：单目录上限 `MAX_ENTRIES = 5000`；超过则截断为前 5000 条
（按上面排序后取前缀），`truncated: true`。

### 1.2 `GET /api/tasks/:taskId/worktree-file`

读单个文件 ≤ 2 MiB 内容。

- Query param `path`（必填）：同上规则；空串拒（必须是文件）。
- 路径不存在 / 不是普通文件（目录 / socket / fifo）→ `404`。
- `realpath` 越界 → `400 worktree-file-escapes-worktree`。

返回（200）：

```ts
type WorktreeFileResponse = {
  path: string            // echo
  size: number            // 真实字节数（即使 oversized 也给真实值）
  oversized: boolean      // true 表示超 2 MiB，未读 content
  content: string         // oversized 时为 ''；否则为完整 UTF-8 文本
}

const MAX_FILE_BYTES = 2 * 1024 * 1024  // 2 MiB
```

读取实现：

```ts
const stat = await fs.stat(target)
if (stat.size > MAX_FILE_BYTES) {
  return { path, size: stat.size, oversized: true, content: '' }
}
const buf = await Bun.file(target).arrayBuffer()
// UTF-8 解码失败的字节用 U+FFFD 替换，与浏览器/编辑器同款宽容策略
const content = new TextDecoder('utf-8', { fatal: false }).decode(buf)
return { path, size: stat.size, oversized: false, content }
```

不做 mime / 二进制识别——按用户要求"文件内容不渲染，文本展示"。

### 1.3 共享：`services/worktreeFiles.ts`

新文件，两个 export：

```ts
export async function listWorktreeDir(
  worktreePath: string,
  relPath: string,
): Promise<{ entries: WorktreeTreeEntry[]; truncated: boolean }>

export async function readWorktreeFile(
  worktreePath: string,
  relPath: string,
): Promise<{ size: number; oversized: boolean; content: string }>
```

两个函数**纯**——只接 worktreePath / relPath，**不**接 `Hono` / `task`
对象 / DB，便于单测直接用真实临时目录跑。

路由层职责：
1. `getTask(deps.db, taskId)` 拉 task；
2. 空 worktreePath / 任务被删 → `NotFoundError('task-not-found' | 'task-
   worktree-missing', ...)`；
3. validate `path` query；
4. 调 `services/worktreeFiles.ts` 函数；
5. 抛 `NotFoundError` / `ValidationError`，统一走 `util/errors.ts` 的
   `errorMiddleware` 投递 JSON。

### 1.4 与 RFC-005 PR-B T13 路由共存

`GET /api/worktree-files/:taskId/*` 旧路由**不动**：它为 reviews
markdown 图片设计，签名是流式字节 + Content-Type by ext，不返回 JSON
体；本 RFC 新增的两条路由是 JSON 控制面，签名截然不同。文件系统层都走
统一的越界校验函数（提到 `util/safePath.ts` 加一个共享 helper
`resolveInsideWorktree(root, rel)`）。

## 2. 前端实现

### 2.1 Tab 接入（`lib/task-detail-tabs.ts`）

```ts
export type TaskDetailTab =
  | 'workflow-status' | 'node-runs' | 'details'
  | 'outputs' | 'worktree-files' | 'worktree-diff' | 'feedback'

export const TAB_ORDER = [
  'workflow-status', 'node-runs', 'details',
  'outputs', 'worktree-files', 'worktree-diff', 'feedback',
] as const

// availableTabs 仍按 hasOutputs 决定 outputs；worktree-files 不被过滤
```

`tabLabel` switch 加 `case 'worktree-files': return t('tasks.tabWorktreeFiles')`。

### 2.2 `components/WorktreeFilesPanel.tsx`

容器组件，渲染左右两栏：

```tsx
<div className="worktree-files-panel">
  <div className="worktree-files-panel__tree">
    <WorktreeFileTree
      taskId={taskId}
      onSelectFile={setSelectedPath}
      selectedPath={selectedPath}
      expanded={expanded}
      setExpanded={setExpanded}
    />
  </div>
  <div className="worktree-files-panel__preview">
    <WorktreeFilePreview taskId={taskId} path={selectedPath} />
  </div>
</div>
```

状态：
- `selectedPath: string | null` — 当前预览文件相对路径。
- `expanded: Set<string>` — 已展开目录的 relPath 集合（`''` = 根永远视
  作展开，不存在集合里）。

状态生命周期：组件**常驻 DOM**（与其它 tab 一致 `hidden` 切换），React
state 保留即可，无需 ref / store。

### 2.3 `WorktreeFileTree`

递归渲染，每个目录节点：

```tsx
<button
  className="worktree-files-tree__row worktree-files-tree__row--dir"
  onClick={() => toggleExpand(relPath)}
  aria-expanded={isExpanded}
  aria-controls={`wt-dir-${relPath}`}
>
  <span className="worktree-files-tree__caret" />
  <span className="worktree-files-tree__icon" aria-hidden>{isExpanded ? '▾' : '▸'}</span>
  <span className="worktree-files-tree__name">{name}</span>
</button>
{isExpanded && <DirChildren ... />}
```

每个文件节点：

```tsx
<button
  className={cx('worktree-files-tree__row worktree-files-tree__row--file', {
    'is-selected': relPath === selectedPath,
  })}
  onClick={() => onSelectFile(relPath)}
  aria-pressed={relPath === selectedPath}
>
  <span className="worktree-files-tree__name">{name}</span>
</button>
```

`DirChildren` 用 react-query 拉子项：

```ts
useQuery({
  queryKey: ['worktreeTree', taskId, relPath],
  queryFn: () => api.getWorktreeTree(taskId, relPath),
  staleTime: 0,        // worktree may mutate; refetch on remount
  enabled: true,       // only mounted when parent is expanded
})
```

react-query 自带去重——同 path 多次展开 / 折叠不会重复拉。loading 期
间显示一个 inline spinner（复用 `LoadingState` mini 变体）。

错误：单目录拉失败时该子树显示 `<ErrorBanner>`（不影响其它子树）。

`truncated === true` 时在该目录末尾加一行 `worktree-files-tree__row--
truncated`：`已隐藏 N 项（仅展示前 5000）`。

a11y：根 `<ul role="tree">`、节点 `<li role="treeitem">`、目录加
`aria-expanded`；与既有 `Select` / `ChipsInput` a11y 模式同源。

### 2.4 `WorktreeFilePreview`

```ts
useQuery({
  queryKey: ['worktreeFile', taskId, path],
  queryFn: () => api.getWorktreeFile(taskId, path!),
  enabled: path !== null,
  staleTime: 0,
})
```

渲染：
- `path === null` → `<EmptyState>` 显示 `t('tasks.worktreeFilesEmpty')`。
- loading → `<LoadingState>`。
- error → `<ErrorBanner>`。
- `data.oversized === true` → 大字号提示 + 详细信息块（文件名 / 真实
  大小 / 阈值）。复用 `.muted` + `.error-box` 调性，但**不**当 error 显
  示（是合法的"我们故意不预览"）。具体走 `<EmptyState>` 的"信息态"变体
  或新增一个 `.worktree-files-preview__oversized` class。
- 正常 → `<pre className="worktree-files-preview__pre">{content}</pre>`，
  `white-space: pre`、`overflow: auto`、`font-family: var(--font-mono)`。

预览头部固定一行：相对路径 + 字节数；超过 100 字符的路径中段省略
（`packages/.../file.ts`）。

### 2.5 路由层（`routes/tasks.detail.tsx`）

```tsx
<div className="task-detail__pane" hidden={tab !== 'worktree-files'}>
  {tk.worktreePath === '' ? (
    <div className="muted">{t('tasks.worktreeFilesNoWorktree')}</div>
  ) : (
    <WorktreeFilesPanel taskId={tk.id} />
  )}
</div>
```

放在 `outputs` pane 之后、`worktree-diff` pane 之前。

### 2.6 API client（`packages/frontend/src/lib/api.ts` 或对应位置）

```ts
export const getWorktreeTree = (taskId: string, path: string) =>
  request<WorktreeTreeResponse>('GET', `/api/tasks/${taskId}/worktree-tree`,
    { search: { path } })

export const getWorktreeFile = (taskId: string, path: string) =>
  request<WorktreeFileResponse>('GET', `/api/tasks/${taskId}/worktree-file`,
    { search: { path } })
```

### 2.7 样式（`styles.css`）

```css
.worktree-files-panel {
  display: grid;
  grid-template-columns: minmax(220px, 320px) 1fr;
  gap: var(--spacing-3);
  height: 100%;
  min-height: 0;
}
.worktree-files-panel__tree {
  overflow: auto;
  border-right: 1px solid var(--border);
  padding-right: var(--spacing-2);
}
.worktree-files-panel__preview {
  overflow: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.worktree-files-preview__pre {
  flex: 1;
  margin: 0;
  padding: var(--spacing-3);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre;
  overflow: auto;
  background: var(--surface-2);
  border-radius: var(--radius-2);
}
.worktree-files-tree__row { ...复用 .btn--ghost.btn--xs 的样式骨架... }
.worktree-files-tree__row.is-selected { background: var(--surface-accent); }
```

具体 token 看 `styles.css` 现有变量；本节是骨架示意，落地时与
`.tabs` / `.page__section` / `.task-detail__panes` 视觉对齐。

## 3. 共享类型（`packages/shared/`）

```ts
// shared/src/worktree-files.ts (新文件)
export const worktreeTreeEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative().nullable(),
})
export const worktreeTreeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(worktreeTreeEntrySchema),
  truncated: z.boolean(),
})
export const worktreeFileResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  oversized: z.boolean(),
  content: z.string(),
})
export type WorktreeTreeEntry = z.infer<typeof worktreeTreeEntrySchema>
export type WorktreeTreeResponse = z.infer<typeof worktreeTreeResponseSchema>
export type WorktreeFileResponse = z.infer<typeof worktreeFileResponseSchema>
```

后端路由 `c.json` 之前用 schema `.parse(...)` 自检；前端 react-query
`select` 也用同一 schema 做 runtime validate（与 `clarify` / `tasks`
API 路由同款防御）。

## 4. 测试策略

按 CLAUDE.md "Test-with-every-change" 落到具体 case。

### 4.1 后端纯函数（`services/worktreeFiles.test.ts`）

用 `tmpdir()` 起真实目录跑。≥ 12 case：

- list:
  1. 空目录 → entries 空、truncated false。
  2. 仅文件 → 列出、size 准、kind=file。
  3. 文件 + 目录混排 → 目录在前、内部字典序。
  4. `.git` 目录被剔除（覆盖 dir）。
  5. `.git` gitlink 文件被剔除（覆盖 file）。
  6. 超 5000 子项 → truncated true、entries.length === 5000、保留排序
     前缀。
  7. symlink 指向 worktree 内 → 列出（按目标类型）。
  8. symlink 指向 worktree 外 → 不列出。
  9. `path === ''` → 列根目录。
  10. `..` / 绝对路径 → 抛 `ValidationError('worktree-tree-escapes-
      worktree')`。
- read:
  11. 文件 ≤ 2 MiB → 内容字节级一致、oversized false。
  12. 文件 > 2 MiB → content '', oversized true, size 真实大小。
  13. 不存在文件 → 抛 `NotFoundError`。
  14. 路径是目录 → 抛 `NotFoundError('worktree-file-not-a-file')`。
  15. UTF-8 invalid 字节 → 用 U+FFFD 替换、不抛。

### 4.2 后端路由（`routes/tasks-worktree.test.ts`）

≥ 6 case，复用既有 `setupTestServer` 模式：

1. 200 列根目录正常。
2. 200 列子目录 lazy（带 `path=packages/backend`）。
3. 400 path 越界（`..`）。
4. 404 task 不存在。
5. 200 文件正常预览。
6. 200 文件 oversized。
7. 404 worktreePath 空（老任务）→ `task-worktree-missing`。

### 4.3 前端纯辅助（`lib/task-detail-tabs.test.ts` 增补）

- `TAB_ORDER` snapshot 锁住 7 元 tuple 顺序（包含 `worktree-files`）。
- `availableTabs({ hasOutputs: false })` 仍包含 `worktree-files`。
- `availableTabs({ hasOutputs: true })` 顺序锁。

### 4.4 前端组件（`components/WorktreeFilesPanel.test.tsx`）

mock api，≥ 8 case：

1. 初始渲染只调一次 `GET worktree-tree?path=`（根目录）。
2. 默认未选中文件 → 右侧 EmptyState。
3. 点目录展开 → 触发新 `getWorktreeTree(taskId, sub)`，再次点同目录折叠
   → **不**再次拉（react-query 缓存）。
4. 点文件 → 调 `getWorktreeFile`、右侧渲染 `<pre>` + 内容。
5. oversized 响应 → 渲染 oversized 提示而非 `<pre>`。
6. 切换 tab 离开 / 回来 → expanded 集合 + selectedPath 留存。
7. `.git` 不被列出（mock fixture）。
8. truncated true → 子目录末尾出现"已隐藏 N 项"行。

### 4.5 源码层守门（`worktree-files-tab-source.test.ts`）

类似 RFC-021 的 `task-canvas-layout-class.test.ts`：

- `routes/tasks.detail.tsx` 必含 `tab === 'worktree-files'` 字面量
  pane。
- `lib/task-detail-tabs.ts` `TAB_ORDER` 字符串数组必出现 `'worktree-
  files'` 在 `'outputs'` 之后、`'worktree-diff'` 之前。
- `components/WorktreeFilesPanel.tsx` 必引 `useQuery` 且包含
  `getWorktreeTree` / `getWorktreeFile` 字面量调用——锁组件没退化成
  fetch 裸调用。

### 4.6 集成 / e2e

视 Playwright 当前用量，最低补一条 source-level smoke 覆盖：tab 出
现 + 默认隐藏 oversized 文件正常显示提示。e2e 落不落看 CI 时间预算，
可在 plan T8 标记 "若 Playwright 已就绪则补"。

## 5. 失败模式与边界

| 场景 | 行为 |
| --- | --- |
| worktree 已被外部 `git worktree remove` 但 task 行还在 | `listWorktreeDir` 抛 `NotFoundError('task-worktree-missing')`；tab 内 ErrorBanner 显示。 |
| 用户在浏览时 worker 还在写文件 | 当前实现"展开时拉"是 snapshot；用户再次折叠 → 展开即可看到最新；不做实时推送（v1）。 |
| 文件名含 `\n` / 控制字符 | 服务端 JSON 编码自然处理；前端 `<button>` text 节点也 OK。 |
| 路径长度 > 1024 | 后端 `resolveInsideWorktree` 走 `path.resolve` 不限长；OS readdir 自身有 PATH_MAX 限制，命中时返回 ENAMETOOLONG → 400 ValidationError。 |
| 服务端处理时文件被删 | `Bun.file().arrayBuffer()` 抛 ENOENT → 落到 404。 |

## 6. 与既有 RFC 的关系

- **RFC-005 PR-B T13**（`worktree-files.ts` 旧路由）：保留不动。
- **RFC-021**（tab 化）：直接在其 `TAB_ORDER` 数组上加一项；
  `availableTabs` 过滤规则不变。
- **RFC-041 PR4**（feedback tab）：feedback 仍排末尾，本次插入位置在
  `worktree-diff` 之前不影响 feedback。
- **RFC-064**（unified clarify runtime）：完全无交集；clarify 改的是
  scheduler / DB 列，本 RFC 只动 tasks 详情页 + 两条 fs 路由。

## 7. 不在本 RFC 范围

- 文件预览的语法高亮 / 编辑能力：未来 RFC。
- 文件下载、复制路径按钮：未来 RFC。
- 二进制文件智能识别 + 提示：未来 RFC（用户已知 v1 二进制乱码）。
- 全文搜索 / fuzzy find：未来 RFC。
