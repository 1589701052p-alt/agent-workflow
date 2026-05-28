# RFC-071 — 任务分解

单 PR：`feat(frontend): RFC-071 工作目录文件下载按钮`。后端零改动。

## 子任务

- **RFC-071-T1**：在 `WorktreeFilesPanel.tsx` 新增并导出纯函数
  `worktreeFileDownloadUrl(baseUrl, taskId, relPath)` + `downloadBaseName(relPath)`；
  在 `worktree-files-panel.test.tsx` 的 `describe('pure helpers')` 里补单测（编码 / 嵌套 /
  尾斜杠 / 空段回退）。
- **RFC-071-T2**：新增 panel 内私有组件 `DownloadFileButton`（`idle | downloading` 态 + error
  文本），fetch→blob→objectURL→`<a download>`；接入 `WorktreeFilePreview` 的**普通态**与
  **过大态**右上角（抽一个共享的 header-actions 槽位，两态都挂）。
- **RFC-071-T3**：i18n —— en-US + zh-CN 各加 `worktreeFilesDownload` / `worktreeFilesDownloading`
  / `worktreeFilesDownloadError`；zh-CN 同步加类型声明行。
- **RFC-071-T4**：CSS —— `.worktree-files-preview__header-actions`（flex 行，size + 按钮）、
  过大态 header 行、`.worktree-files-preview__download-error`（就地红字，可换行）。
- **RFC-071-T5**：组件测试 —— 普通态触发正确 URL+Authorization 头 + `createObjectURL(Blob)` +
  锚点 download=basename；**过大态仍触发同一 fetch**；fetch reject → 就地错误。
- **RFC-071-T6**：登记 `design/plan.md` RFC 索引 + `STATE.md`；跑
  `bun run typecheck && bun run test && bun run format:check` 全绿；commit + push 后查 CI。

## 依赖

T1 → T2 → T5；T3 / T4 可与 T2 并行。T6 收尾。

## 验收清单

- [ ] AC1 普通态 + 过大态右上角都有下载按钮
- [ ] AC2 文件名 = basename
- [ ] AC3 过大文件下载完整字节（走无上限的 `/api/worktree-files/*` 端点）
- [ ] AC4 同源 / 跨源都可用，token 走头不进 URL
- [ ] AC5 失败就地提示
- [ ] AC6 进行中禁用、防重复触发
- [ ] 纯函数单测 + 组件测试（含过大态回归）全绿
- [ ] 3-gate（typecheck / test / format:check）全绿
