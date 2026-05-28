# RFC-071 — 技术设计

## 复用已有端点（后端零改动）

下载直接复用 RFC-005 的 `GET /api/worktree-files/:taskId/*`
（`packages/backend/src/routes/worktree-files.ts`）：

- 通过 `Bun.file` 流式返回**原始字节**，**没有 2 MiB 上限**（与预览用的
  `GET /api/tasks/:taskId/worktree-file?path=` JSON 端点不同——后者才有上限）。
- 已做路径穿越加固（lexical containment + 拒绝绝对路径，见 `worktree-files-proxy.test.ts`
  的 3 个 attack case）。
- 走 `/api/*` 的 `multiAuth` 中间件（session.ts），鉴权方式：`?token=` query **或**
  `Authorization: Bearer` 头（`extractRawToken`，session.ts:117-125）。

因此后端无需任何改动；下载与预览读的是同一个 worktree、同样的安全边界。

## 前端数据流

`WorktreeFilePreview` 已经持有 `taskId` + `path`。新增一个 panel 内私有组件
`DownloadFileButton({ taskId, path })`，点击时：

1. `worktreeFileDownloadUrl(getBaseUrl(), taskId, path)` 拼出端点 URL（见下）。
2. `fetch(url, { headers: { Authorization: 'Bearer <token>' } })` —— token 走头，不进 URL。
3. `await res.blob()`，`URL.createObjectURL(blob)`。
4. 造一个 `<a download={basename} href={objUrl}>`，`appendChild` → `click()` → `remove()`，
   `finally` 里 `revokeObjectURL`。

### 为什么用 blob fetch，而不是直接 `<a download href>`

两点决定了必须走「fetch → blob → objectURL」而不是直接给 `<a>` 挂端点 URL：

1. **鉴权**：端点要 token。`<a>` 跳转无法带 `Authorization` 头，直链就得把 token 塞进
   `?token=` query——会泄漏进浏览器历史 / 服务端访问日志。blob 方案 token 只在 fetch 头里。
2. **远程 daemon（跨源）**：`getBaseUrl()` 可被 override 成另一台机器（`BASE_URL_KEY`，
   stores/auth.ts:80-92）。此时端点与页面**不同源**，浏览器会**忽略跨源 `<a>` 的 `download`
   属性**→ 变成内联打开而非保存。blob 的 object URL 对页面永远同源，`download` 必被尊重。

代价：整文件先进浏览器内存。对工作目录里的文件可接受，且这正是仓内既有下载（评审 Markdown
导出，`routes/reviews.detail.tsx:859-871`）采用的同一套 `createObjectURL + a.download` 模式。
真·超大文件（GB 级）可能 OOM——属浏览器层面，本 RFC 不额外兜底。

## 纯函数（导出 + 单测）

放在 `WorktreeFilesPanel.tsx`，与既有 `formatBytes` / `joinRel` 并列导出：

- `worktreeFileDownloadUrl(baseUrl, taskId, relPath): string`
  - `relPath` 按 `/` 拆段、过滤空段、逐段 `encodeURIComponent`、再用字面 `/` join；
    `taskId` 也 `encodeURIComponent`。返回 `new URL('/api/worktree-files/<encTask>/<encSegs>', baseUrl).toString()`。
  - 逐段编码后用字面 `/` 拼接，能正确通过端点那一次整体 `decodeURIComponent`
    （worktree-files.ts:50）往返：`#` `?` 空格 `%` 等都安全。比 RFC-008 `resolveImageHref`
    （不编码）更稳。
- `downloadBaseName(relPath): string` —— 取最后一个非空段，空则回退 `'download'`。

## 耦合点

- 复用 `getToken` / `getBaseUrl`（stores/auth）+ `ApiError`（api/client），与仓内既有
  `authedFetch`（skills/ImportZipPanel.tsx:394）同套路。
- 按钮复用公共 `.btn .btn--sm` + `↓` 图标（与 `reviews.detail.tsx` 下载按钮一致），**不新造**
  按钮组件/样式。遵循 CLAUDE.md「前台界面统一风格」。
- 新增 CSS：`.worktree-files-preview__header-actions`（把 size 文本 + 下载按钮排成一行的 flex
  容器）；「过大」态加一个同款 header 行承载右上角按钮；`.worktree-files-preview__download-error`
  承载就地错误文本。

## 失败模式

- 401（token 失效）/ 404（worker 中途删了文件）/ 网络中断 → 捕获后置 `error` 态，按钮旁就地红字
  提示，按钮回到可点。
- 重复点击：`downloading` 态直接 `return`，按钮 `disabled`。
- 巨型文件 OOM：浏览器层面，不兜底（见上）。

## 测试策略（必写）

- **单元（纯函数）**：`worktreeFileDownloadUrl`——根级文件 / 嵌套路径 / base 带尾斜杠 / 含空格
  与特殊字符的段编码；`downloadBaseName`——根级 / 嵌套 / 空串回退。
- **组件**：
  - 普通态点下载 → `fetch` 命中正确 URL 且带 `Authorization: Bearer tok` 头；`createObjectURL`
    收到一个 `Blob`；锚点 `download` = basename。
  - **「过大」态点下载仍触发同一 fetch**（锁住本 RFC 核心诉求的回归）。
  - `fetch` reject → 就地错误提示出现，按钮重新可点。
- **后端**：`worktree-files-proxy.test.ts` 已覆盖该端点（含无 auth→401、穿越→4xx、未知扩展名→
  octet-stream），本 RFC 不改后端故不新增后端用例。

## 与 RFC-072 协调（共享下载原语）

并行进行中的 RFC-072「任务详情 Outputs tab 重画」也要给文件类输出加下载按钮，复用同一套原始字节
端点，其 design §3.1 明确把 `worktreeFileDownloadUrl` / `downloadBaseName` / `downloadWorktreeFile`
规划进**共享模块 `lib/worktree-download.ts`**，并约定：**若 RFC-071 先落地**，由 RFC-072 实现时把本
RFC 落在 `WorktreeFilesPanel.tsx` 的两个纯函数**上提**到该共享 lib、再让本组件 import。

因此本 RFC **不预建** `lib/worktree-download.ts`（避免给未落地的 RFC-072 抢先定型 API、也避免
add/add 合并冲突）；只保证两个纯函数**命名与签名与 RFC-072 §3.1 一致**（`worktreeFileDownloadUrl(baseUrl, taskId, relPath)`
/ `downloadBaseName(relPath)`），让对方的「上提」是一次零摩擦的搬运。`DownloadFileButton` 是
panel 私有 UI，不进共享 lib。
