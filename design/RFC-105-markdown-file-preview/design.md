# RFC-105 — 技术设计

## 1. 总览

纯前端、增量、零后端改动。三块：

1. **预览路由** `/tasks/$id/preview`：一个新路由组件，从 URL search 参数重建 markdown body，用 `Prose` 整页渲染，顶部「← 返回」。
2. **输出区接线**：`TaskOutputPanel` 的 `OutputDetail` header 增加「预览」按钮（命中 `isMarkdownPreviewable`），跳转预览路由。
3. **工作目录接线**：`WorktreeFilePreview` header 增加「预览」按钮（命中 `isMarkdownPath` 且非 oversized），跳转预览路由。

所有「是否显示按钮 / 跳哪 / 重建哪段 body」的判断都抽成**纯函数**，组件只做 wiring，可单测。

## 2. 渲染能力复用

评审界面的 markdown 渲染底座是 `components/prose/Prose.tsx`（`ReviewDocPane` 内部即 `<Prose body taskId anchors=… />`）。本 RFC **直接复用 `Prose`**（不复用 `ReviewDocPane`，因后者绑定评论锚点 / 选区交互，预览不需要）。

预览页对 `Prose` 的入参：

- `body` — 重建出的 markdown 文本。
- `taskId` — 当前任务 id，供 `resolveImageHref` 把工作区相对图片重写到 `/api/worktree-files/{taskId}/...`（与评审一致）。

**PlantUML 不再需要前端配置**：经 WP-B（§11），`Prose` → `PlantUmlBlock` 改为调用后端代理 `POST /api/plantuml/render`，渲染端点与 authHeader 全在服务端。因此 `Prose` / `makeCode` / `CodeBlock` / `PlantUmlBlock` 的 `plantumlEndpoint` / `plantumlAuthHeader` 入参**整条删除**，预览页（以及评审界面 / 编辑器预览）都**不再拉 `/api/config`**。mermaid（客户端渲染）、KaTeX、shiki 代码高亮、GFM、标题锚点、外链图标本就不依赖任何配置。

这样 mermaid / KaTeX / shiki / GFM / 标题锚点 / 外链图标 / **PlantUML** 全部与评审界面**逐项一致**，且对所有任务成员一致生效（PlantUML 经代理通用化，详见 §11）。

## 3. 预览路由

### 3.1 路由定义

新文件 `routes/tasks.preview.tsx`：

```
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id/preview',
  validateSearch: validatePreviewSearch,   // 纯函数，见 §4
  component: TaskMarkdownPreviewPage,
})
```

在 `router.tsx` 的 `addChildren` 里**置于 `taskDetailRoute` 之前**（沿用本仓「更具体的字面段先注册」惯例；`/tasks/$id/preview` 段数多于 `/tasks/$id`，本无歧义，仅为一致）。

### 3.2 search 参数

```
interface TaskPreviewSearch {
  path?: string     // 文件源：工作区相对路径
  runId?: string    // 内联端口源：源 node_run id
  port?: string     // 内联端口源：源端口名
  title?: string    // 可选：页头展示标题（缺省时由 path basename / port 名兜底）
}
```

来源判定（`resolvePreviewSource`，纯函数）：

- `path` 为非空字符串 → `{ mode: 'file', path }`（优先；忽略 runId/port）。
- 否则 `runId` 与 `port` 均为非空字符串 → `{ mode: 'port', runId, port }`。
- 否则 → `{ mode: 'invalid' }`（页面渲染「无效预览链接」+ 返回）。

### 3.3 body 重建

- **file 模式**：`useQuery(['worktreeFile', taskId, path], () => fetchWorktreeFile(taskId, path))`。
  - 复用 `WorktreeFilesPanel` 同一 query key，命中缓存时（用户刚在工作目录看过该文件）**即时拿到缓存数据、首屏零阻塞**。注意（Codex 设计 gate P3）：既有文件 query 是 `staleTime: 0`，故挂载时 React Query 仍会**后台 revalidate**（发一次请求）——不是「零请求」，但不阻塞首屏；且对运行中任务这次 revalidate 能拿到最新内容，是**期望行为**。不刻意调高预览侧 `staleTime`（让运行中任务的预览也能刷新）。
  - 为此把现私有于 `WorktreeFilesPanel.tsx` 的 `fetchFile` 抽到共享 `api/worktreeFiles.ts`（导出 `fetchWorktreeFile` / 可顺带 `fetchWorktreeTree`），`WorktreeFilesPanel` 改 import；**单一事实源**，避免两份 fetch 漂移。
  - `data.oversized === true` → 渲染「文件过大（{size}），超过 {limit}，无法预览」+ 下载入口（复用既有 `tasks.worktreeFilesOversized` 文案与下载 lib）。
  - 否则 `body = data.content`。
- **port 模式**：`useQuery(['tasks', taskId, 'node-runs'], …)`（与任务详情页同 key、命中缓存）→ 在 `outputs: NodeRunOutput[]` 里找 `o.nodeRunId === runId && o.port === port`，`body = 该 o.value`。找不到 → 空态 / 「输出尚未产生」。

### 3.4 页面骨架

复用既有页面骨架 class，避免自写 chrome：

```
<div className="page">
  <header className="page__header page__header--row">
    <Link to="/tasks/$id" params={{ id }} className="btn btn--sm">← {t('taskPreview.back')}</Link>
    <h1>{title 或 path basename 或 port}</h1>
  </header>
  <PreviewBody />   // loading / error / oversized / empty / <Prose …/>
</div>
```

`PreviewBody` 内部按 §3.3 出 body，分支渲染 `LoadingState` / `ErrorBanner` / 超限提示 / 空态 / `<Prose body={body} taskId={id} />`（无 plantuml 入参——经 WP-B 由代理处理）。新增 CSS 仅一个轻量 `.md-preview`（约束最大宽度 + 内边距），其余走 `.page` / `.prose`。

### 3.5 返回

「← 返回」= `<Link to="/tasks/$id" params={{ id }}>`，深链安全（直接打开预览页也能返回）。落到任务详情默认 tab（见 proposal 非目标）。

## 4. 纯函数（单一可断言面）

放在 `lib/markdown-preview.ts`（新文件），全部纯函数、可脱离 DOM 单测：

- `MARKDOWN_EXT_RE = /\.(md|markdown)$/i`
- `isMarkdownPath(path: string): boolean` — 单行、非空、命中 `MARKDOWN_EXT_RE`。工作目录按钮判定 + 文件端口判定共用。
- `isMarkdownPreviewable(kind, value): boolean` — 输出端口按钮判定：
  - `value` 为 null / '' → false；
  - 文件型 md：`isFileOutputKind(kind) && isSingleLinePath(value) && isMarkdownPath(value.trim())`（复用 RFC-072 既有 `isFileOutputKind` / `isSingleLinePath`，不重写）；
  - 内联 md：`const p = tryParseKind(kind); p?.kind === 'base' && p.name === 'markdown'`（注意 `parseKind('markdown')` 返回 `{ kind:'base', name:'markdown' }`，**不是** `{ kind:'markdown' }`——`ParsedKind` 只有 base/path/list 三支）；
  - 其余 false。
- `validatePreviewSearch(raw): TaskPreviewSearch` — 逐字段挑非空字符串（TanStack 不变量：恒返回对象）。
- `resolvePreviewSource(search): { mode:'file', path } | { mode:'port', runId, port } | { mode:'invalid' }`（§3.2）。
- `buildPreviewTarget(...)` — 给接线点用：由 `(taskId, 文件 path | {runId,port}, title?)` 产出 `{ to:'/tasks/$id/preview', params, search }`，组件直接铺到 `<Link>` / `navigate()`。把导航目标做成纯数据，绕开「Link 需 RouterProvider」让单测只断言目标对象。

## 5. 接线点

### 5.1 TaskOutputPanel（输出）

`OutputDetail` header 的 actions 区，在 Download / Copy 旁插入：

```
{isMarkdownPreviewable(kind, value) && (
  <Link {...buildPreviewTarget(taskId, sourceForKind(kind, value), port.name)}
        className="btn btn--sm" data-testid="task-output-preview">预览</Link>
)}
```

- 文件型（`isFileOutputKind`）→ `buildPreviewTarget` 走 file 模式（`path = value.trim()`）。
- 内联 markdown → 走 port 模式（`runId = 该端口解析到的 nodeRunId`，`port = 该端口的源 portName`）。
  - 注意：`OutputDetail` 当前只拿到 `value/kind`，没有 `nodeRunId/portName`。需把已在 `TaskOutputPanel` 解析出的 `run.id`（latestRunByNodeId）与 `port.portName` 透传进 `OutputDetail`（新增两个 props：`sourceRunId: string | null`、`sourcePortName: string`）。这是组件内既有数据的下传，不新增查询。

### 5.2 WorktreeFilePreview（工作目录）

`worktree-files-preview__header` 的 actions 区，在 `DownloadFileButton` 旁插入：

```
{isMarkdownPath(path) && !data.oversized && (
  <Link {...buildPreviewTarget(taskId, path)} className="btn btn--sm"
        data-testid="worktree-files-preview-btn">预览</Link>
)}
```

`path` / `taskId` 在该组件作用域已有。

## 6. 失败模式

| 场景 | 处理 |
| --- | --- |
| search 缺参 / 自相矛盾（既无 path 又无 runId+port） | `mode='invalid'`：渲染「无效预览链接」+ 返回，不发请求 |
| 文件 > 2 MiB（oversized） | 复用既有超限提示 + 下载入口，不渲染 Prose |
| 文件 / 任务无权访问 | 后端 403/404（RFC-099 成员鉴权）→ `ErrorBanner` + 返回 |
| 内联端口尚未产出（找不到 output） | 空态「输出尚未产生」 |
| body 为空字符串 | 空态「（空）」 |
| Prose 渲染内的 mermaid/plantuml 语法错 | 由 `Prose` / `MermaidBlock` / `PlantUmlBlock` 既有错误态兜底，预览页不额外处理 |

## 7. 与现有模块耦合点

- `components/prose/Prose.tsx` —— 渲染原语（只读复用，不改）。
- `api/worktreeFiles.ts`（新）—— 抽出 `fetchWorktreeFile`；`WorktreeFilesPanel` 改 import（去重，不改行为）。
- `GET /api/tasks/:id/worktree-file` + `worktreeFileResponseSchema`（复用）。
- `GET /api/tasks/:id/node-runs`（复用，取内联端口值）。
- `POST /api/plantuml/render`（WP-B 新增代理；前端 `PlantUmlBlock` 改走它，不再读 `/api/config`）。
- `lib/output-port.ts`（`isFileOutputKind` / `isSingleLinePath`，复用）、`shared` `tryParseKind`（复用）。
- `router.tsx`（注册新路由）。

## 8. 安全 / 鉴权

无新增暴露面：

- `path` 经既有 worktree-file 端点处理，已有 RFC-103 realpath 包含（防 symlink 越界）+ RFC-099 任务成员鉴权。
- `runId/port` 经既有 node-runs 端点，同样成员鉴权。
- 非成员深链打开预览页 → 后端 403/404 → 错误态。前端不做额外 ACL（与任务详情页其他数据一致，由后端兜底）。

## 9. 测试策略（design.md §测试策略，PR 必须全绿）

**纯函数单测**（`lib/markdown-preview.test.ts`）：
- `isMarkdownPath`：`a.md`/`A.MD`/`x.markdown` → true；`a.md.txt`/`a.mdx`/`readme`/多行/空 → false。
- `isMarkdownPreviewable`：`markdown_file`+`.md` 路径 → true；`path<*>`+`.md` 值 → true；`markdown`（内联）非空 → true；`string`/`signal`/`path<*>`+`.png` 值/`list<markdown>`/null/'' → false。
- `validatePreviewSearch`：挑非空字符串、丢空串/非串。
- `resolvePreviewSource`：file 优先、port 次之、缺则 invalid。
- `buildPreviewTarget`：file 源产出 `{to,params:{id},search:{path}}`；port 源产出 `{…search:{runId,port}}`；title 透传。

**组件测试**：
- `task-output-panel.test.tsx`（扩展）：内联 markdown 端口与 `.md` 文件端口出现 `task-output-preview` 且 Link 目标含正确 search；`string`/非 `.md` 文件端口不出现；pending（空值）不出现。
- `worktree-files-preview-md.test.tsx`（新）：选中 `.md` 文件 → 出现 `worktree-files-preview-btn`；非 `.md` → 不出现；oversized `.md` → 不出现。
- `task-markdown-preview-route.test.tsx`（新）：mock api，file 模式渲染出 markdown（`findByRole('heading')` 命中 `#` 标题、表格 role=table）；port 模式从 node-runs 取值渲染；invalid search → 「无效预览链接」；oversized → 超限提示无 Prose。断言含 `Prose` 渲染产物（角色断言，不靠具体 DOM 结构）。

**源码守卫**（`rfc105-markdown-preview-source.test.ts`，仿 RFC-065/072 守卫）：
- `router.tsx` 注册 `tasks.preview` 且位于 `taskDetailRoute` 之前。
- 预览路由文件 import `@/components/prose/Prose`（渲染复用评审能力的硬锚），且**不**自写第二套 react-markdown / 渲染器。
- `WorktreeFilesPanel` 与预览路由都经 `api/worktreeFiles` 取文件（不各写 fetch）。
- 两接线点存在对应 `data-testid` 与 `buildPreviewTarget` 调用（防止 silent 移除按钮）。

**WP-B 后端代理测试**（`tests/plantuml-proxy.test.ts` + 服务单测）：
- `services/plantuml.ts` encode：`encodeForPlantuml`/`encodeForGet` **round-trip 正确**（`inflateRaw(decode(encode(src))) === src`）——pako 与 node zlib 的 DEFLATE 字节**不必相同**，能被渲染端 inflate 即可（字节一致是错误目标）；`looksLikePlantumlError` 命中 4xx PlantUML 诊断 SVG（语法错的完整抽取+i18n 留前端）。
- 路由（mock fetch / mock config）：① 端点未配置 → `{unconfigured:true}`；② GET plantuml 成功 → `{svg, host}`；③ 首 GET 4xx 语法错 → `{errorSvg}` 且**不**继续回退；④ 前两步失败、POST 成功 → `{svg}`；⑤ 全失败 → **200** `{error}`（**不**用非 2xx：前端 `api.post` 对非 2xx 抛错且丢响应体，detail 会丢——Codex 实现 gate P3）；⑥ 空源 → 400；超大源 → **413**（**parse 前**查 Content-Length——Codex 实现 gate P2）；⑦ **authHeader 不出现在响应体**（断言序列化结果不含其值）；⑧ 端点固定来自 config、不被请求体覆盖（SSRF 锚）；⑨ 普通 `user` 角色 200 对照 `/api/config` 403。
- 鉴权：普通 `user` actor（无 `settings:read`）`POST /api/plantuml/render` 得 2xx（对照 `GET /api/config` 仍 403）——锁「通用化」契约。

**WP-B 前端重写测试**：
- `prose-code-plantuml.test.tsx`（更新）：`PlantUmlBlock` 走 `api.post('/api/plantuml/render')`（mock），成功 → 注入经 DOMPurify 的 SVG；`unconfigured`/`syntaxError`/`error` 各态 UX 保留；断言**不再**直接 fetch 配置端点。
- 死配置链守卫：源码层断言 `Prose`/`makeCode`/`CodeBlock`/`PlantUmlBlock` 不再有 `plantumlEndpoint`/`plantumlAuthHeader` 标识符；`MultiDocReviewView`/`reviews.detail` 不再 `queryKey: ['config']` 为 plantuml 而拉。

**运行门槛**：`bun run typecheck`（三包）+ 前端 vitest 全绿 + **后端 bun test 全绿** + `bun run format:check`。CI 另跑 Playwright e2e / 单二进制 smoke / 静态扫描——推完按 [feedback_post_commit_ci_check] 立刻查 CI。

## 10. 已知限制

- **PlantUML 渲染依赖 admin 已配置端点**：WP-B 让所有成员都能渲染，但前提是 admin 在设置里配了 kroki 兼容端点；未配置时对所有人统一退化为源码态（不是权限问题、是缺配置）。
- **无渲染缓存 / 限流**：代理每次请求都打一次配置端点（与今天浏览器直连一致）；高频预览同一图会重复渲染。服务端 LRU / 限流留作后续。
- 「返回」落任务详情默认 tab，不还原来路 tab（proposal 非目标；后续可给 `/tasks/$id` 加 `?tab=` 深链）。
- md 文件子目录内 `./x.png` 相对图片按工作区根解析，可能断链（与评审界面同行为，沿用现状）。
- `list<markdown>` / `list<path<md>>` 不提供预览（沿用「下载排除 list」口径）。

## 11. WP-B — PlantUML 后端代理通用化

### 11.1 动机

PlantUML 渲染需服务端端点（kroki 兼容），端点 + `authHeader` 存于 admin-only 配置（`/api/config` 受 `settings:read` 门控，`USER_BASELINE` 无此权限）。结果：**仅 admin 能渲染 PlantUML**——预览 / 评审 / 编辑器皆然。用户判定不合理（D4）。根治方式：后端代理，把「谁能用端点」从 admin 放开到所有登录用户，且 `authHeader` 不出服务端。

### 11.2 后端

**`services/plantuml.ts`**（新，纯函数 + 渲染）：
- `encodeForPlantuml(source)` / `encodeForGet(source)`：node `zlib.deflateRawSync` + 两套 base64 字母表（plantuml `0-9A-Za-z-_` 自有序 / kroki `A-Za-z0-9-_` url 序）——**移植自** `PlantUmlBlock.tsx` 的 pako 实现，输出须字节一致（raw deflate 两端兼容）。
- `extractPlantUmlSyntaxError(svgText)`：移植前端同名纯函数（4xx 语法错 SVG 抽行号 / 原因）。
- `renderPlantuml({ source, endpoint, authHeader })`：复刻三段回退——① GET `{base}/plantuml/svg/{encodeForPlantuml}`（首选，picoweb 友好）；② GET `{base}/plantuml/svg/{encodeForGet}`（kroki）；③ POST `{base}/plantuml/svg` text/plain。命中 4xx 语法错即停（不覆盖权威错误）。返回判别联合：`{kind:'svg', svg}` / `{kind:'syntax', detail}` / `{kind:'failed', detail}`。

**`routes/plantuml.ts`**（新）：`POST /api/plantuml/render`
- 鉴权：仅靠 `app.use('/api/*', multiAuth)`（任何登录用户）——**不加** `requirePermission`，故普通 `user` 可用。
- body：`{ source: string }`；校验非空 + `length ≤ PLANTUML_SOURCE_MAX`（如 100 KiB），超限 400 `plantuml-source-too-large`。
- 读配置（服务端既有 config 读取途径）取 `plantumlEndpoint` / `plantumlAuthHeader`：
  - 端点空 → 200 `{ unconfigured: true }`。
  - 否则 `renderPlantuml(...)`：`svg` → 200 `{ svg, host }`（`host` = 端点 hostname，给前端隐私提示）；`error-svg` → 200 `{ errorSvg, host }`（前端跑 `extractPlantUmlSyntaxError`）；`failed` → **200** `{ error: detail }`（非 2xx 会被 `api.post` 抛错+丢体，故用 200-union）。
  - 大小：**parse 前**先查 `Content-Length > PLANTUML_SOURCE_MAX + 1024` → 413；parse 后再以 `source.length` 兜底（header 缺失/作假时）。
- **不**把 `authHeader` 写进任何响应。

### 11.3 安全

- **无 SSRF**：目标 `endpoint` 恒取自 admin 配置，请求体只带 `source`（拼进 path / body），用户改不了 host。源码大小上限挡超大 payload。
- **authHeader 不外泄**：只在服务端→端点的 `Authorization` 头里用，从不进响应 / 日志。
- **XSS**：代理回原始 SVG，前端 `PlantUmlBlock` 仍 `DOMPurify.sanitize`（svg profile）后才 innerHTML——既有防线不变。
- **隐私**：源码现在 browser→本服务→端点（而非 browser→端点直连）。前端保留「图经 {host} 渲染」提示，`host` 由代理响应给出（前端拿不到完整端点，只拿 hostname）。

### 11.4 前端

**`PlantUmlBlock.tsx`**：`fetchAndSwap` 三段浏览器 fetch → 单次 `api.post('/api/plantuml/render', { source })`，按响应分支：`svg` → DOMPurify + 既有尺寸归一逻辑；`unconfigured` → 既有「未配置」回退；`syntaxError` → 既有语法错提示；`error`/网络失败 → 既有渲染失败态。删 `endpoint`/`authHeader` 参数与本地 pako 编码（编码移到后端）。

**死配置链拆除**（config 仅为 plantuml 而拉，经核实）：
- `makeCode`（`CodeBlock.tsx`）/ `Prose.tsx`：删 `plantumlEndpoint`/`plantumlAuthHeader` 入参与透传。
- `ReviewDocPane.tsx`：删两 prop + 不再传给 `Prose`。
- `MultiDocReviewView.tsx` / `reviews.detail.tsx`：删 `queryKey:['config']` 查询 + 删传参（这两处 `config.data` 仅 plantuml 用）。
- `MarkdownEditor.tsx`：本就没传 plantuml（编辑器预览此前 PlantUML 从不工作）→ 现自动经代理生效，无需改。

### 11.5 与 WP-A 的关系

WP-A（预览路由 + 接线）不依赖 WP-B，可独立先落；WP-B 是平台级 PlantUML 修复，落地后预览页的 PlantUML 验收（acceptance #4/#5）才完整满足。建议两 PR：PR1 = WP-A，PR2 = WP-B（或合一）。
