# RFC-110 — 任务分解

单 PR（纯前端 + 一个 shared 纯函数导出）。commit 前缀：`feat(frontend): RFC-110 URL 模式启动复用缓存克隆枚举文件/分支`。

## 子任务

| ID | 任务 | 依赖 | 文件 |
| --- | --- | --- | --- |
| RFC-110-T1 | 导出 `canonicalRepoKey(rawUrl): string \| null`（薄封装 `parseGitUrl` + `canonicalForHash`） | — | `packages/shared/src/git-url.ts`（+ `index.ts` re-export 如有） |
| RFC-110-T2 | shared 测试：`canonicalRepoKey` **同协议折叠**（HTTPS 组 / SSH 组各自同键）+ **跨协议不同键**（HTTPS≠SSH，Codex P2）+ 不可解析→null | T1 | `packages/shared/tests/git-url*.test.ts` |
| RFC-110-T3 | 新增纯函数 `resolveUrlRepoPath(source, cached): string` | T1 | `packages/frontend/src/lib/launch-repo-source.ts` |
| RFC-110-T4 | `resolveUrlRepoPath` 单测（path 直通 / url 同协议命中含变体 / **跨协议不命中** / 未命中 / 不可解析 / 空缓存） | T3 | `packages/frontend/src/lib/*.test.ts` |
| RFC-110-T5 | `FilesPicker` 加 `sourceKind` prop；URL 模式空/错→`TextArea` 回退 + 缓存快照 hint | T3 | `components/launch/FilesPicker.tsx` |
| RFC-110-T6 | `GitPicker` 加 `sourceKind` prop；branch 子类型 URL 模式空/错→`TextInput`/`Select` 回退 | T3 | `components/launch/GitPicker.tsx` |
| RFC-110-T7 **（强制，Codex 设计+实现 gate P2）** | 旧值不静默泄漏：FilesPicker「已选但不在 listing」→ 可删除行（`files-picker-extra-selected`）+ **loading 期保持可见**（`files-picker-loading-selected`）；GitPicker「当前 ref 不在分支列表」→ 注入显式选项。抽 `selectedRows` helper，复用 `.files-picker__row`，**零新增 CSS** | T5,T6 | `components/launch/FilesPicker.tsx` / `GitPicker.tsx` |
| RFC-110-T8 | 接线 `workflows.launch.tsx`：`['cached-repos']` 查询 + `resolveUrlRepoPath` + 透传 `sourceKind`；cached-repos 查询失败不阻塞（回退文本框） | T3,T5,T6 | `routes/workflows.launch.tsx` |
| RFC-110-T9 | i18n：`launch.filesPicker.{cacheSnapshotHint,urlFallbackHint,extraSelectedHint}` + `launch.gitPicker.{currentRefOption,urlFallbackHint}` zh-CN+en-US 对称 | T5,T6,T7 | `i18n/zh-CN.ts` / `i18n/en-US.ts` |
| RFC-110-T10 | 组件测试：FilesPicker 基础 3 例 + **旧值兜底/状态转换 4 例**（cache hint / extra 行可删 / **loading 期旧值可见可删** / 错误回退）+ GitPicker 基础 2 例 + **当前 ref 注入 1 例** + url 回退 1 例（design §7） | T5,T6,T7,T8 | `tests/files-picker.test.tsx` / `tests/git-picker.test.tsx` |
| RFC-110-T11 | 源码文本回归断言（无硬编码 url-清空；引用 `resolveUrlRepoPath`）+ i18n 对称断言 | T8,T9 | 既有 grep-guard 测试 / i18n-keys 测试 |
| RFC-110-T12 | 收尾：`bun run typecheck && bun run test && bun run format:check` 全绿；Codex 实现 gate；push 查 CI | 全部 | — |

## PR 拆分

- **单 PR**：改动小、纯前端、无 schema/migration。T1（shared）与前端同 PR 一起上（前端依赖 T1 导出）。
- T7（旧值兜底）经 Codex 设计 gate 升为**强制核心项**，同 PR 内做、不拆 follow-up。

## 验收清单（push 前逐条核对）

- [ ] URL 模式 + 命中缓存：FilesPicker 列文件可勾选；GitPicker(branch) 下拉非空。
- [ ] URL 模式 + 未命中：files→多行文本框、git(branch)→单行文本框，值格式与 packed 一致，可启动。
- [ ] URL 模式 + 枚举失败：优雅回退文本框，无 error-box。
- [ ] path 模式全行为字节守恒（空仓「请先选择仓库」、选仓枚举照旧）。
- [ ] URL 匹配对 `.git`/斜杠/同协议 ssh 两形/凭证稳健；HTTPS 与 SSH **不**互相命中（显式测试）。
- [ ] 缓存命中渲染「列表来自缓存克隆快照」hint。
- [ ] **旧值不静默泄漏（Codex P2 强制）**：FilesPicker「已选但不在 listing」可删除行可见可删；GitPicker 当前 ref 不在分支列表时作为显式选项可见；hitA→hitB / loading→hit 不隐藏旧值。
- [ ] cached-repos 查询失败 → 回退文本框，不阻塞启动。
- [ ] shared + 前端纯函数 + 组件 + i18n 对称 + 源码文本断言 全绿。
- [ ] `typecheck + test + format:check` 三件套全绿（前端 vitest）。
- [ ] Codex 实现 gate 跑过、findings fold。
- [ ] push 后 GitHub Actions 全绿（[feedback_post_commit_ci_check]）。
- [ ] STATE.md：RFC-110 改 Done + 已完成 issue 表加行；plan.md RFC 索引状态置 Done。

## 与他人改动的隔离

- 触碰的共享索引文件（`design/plan.md` / `STATE.md`）只加自己的 RFC-110 行，不动他人行（注意并行的 RFC-108 / RFC-109 Draft 行）。
- `git commit -- <精确路径>` 单步提交，避免 [feedback_shared_index_commit_race] / [project_collaborator_stash_gate]。
- 不 `git add` 他人未追踪文件（如 `design/RFC-109-task-sync-latest-workflow/`）。
