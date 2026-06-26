# RFC-110 — URL 模式启动表单复用缓存克隆枚举文件 / 分支

> 关联：RFC-024（启动表单 path/url 二选一 + cached_repos 缓存）；RFC-020（`FilesPicker` —— 仅选 worktree 内已有路径）；RFC-066（多仓启动）；RFC-068（URL 模式 mirror cache FF，**不 checkout**）；RFC-107（URL + multipart upload，先把 URL 解析成缓存路径再物化）。
>
> 状态：Draft（待用户批准实现）

## 背景

启动任务页（`/workflows/$id/launch`）按 `workflow.definition.inputs[]` 自动渲染表单字段，字段类型由 `def.kind` 决定：`text` / `files` / `enum` / `git` / `upload`。其中：

- `kind: 'files'` → `FilesPicker`（用户口中的「筛选路径框」）：调 `GET /api/repos/files?path=<repoPath>` 跑 `git ls-files` 列出仓库文件，多选 checkbox，packed value = 换行 join 的 repo-relative 路径。
- `kind: 'git'`（branch 子类型）→ `GitPicker`：调 `GET /api/repos/refs?path=<repoPath>` 列分支下拉。

这两个 picker **都需要一个本地 `repoPath`** 才能枚举。

启动表单的「仓库来源」是 path / url 二选一（`RepoSourceRow`）。问题出在 `workflows.launch.tsx:393`：

```tsx
repoPath={primarySource.kind === 'path' ? primarySource.repoPath : ''}
```

**URL 模式下 `repoPath` 被硬编码成 `''`**。于是 `FilesPicker` 落进 `FilesPicker.tsx:70` 的 `if (repoPath === '')` 分支，只剩一句「请先选择仓库」，`git ls-files` 不再发出；`GitPicker` 的 branch 下拉（`GitPicker.tsx:49` `enabled: repoPath !== ''`）也是空的。用户视角就是：「在 input 接了多个下游（典型 fan-out：一个 `files` 输入喂给多个审计节点）时，启动任务的 input 变成筛选路径框；**一切到远程 URL 这个框就坏了**。」

连带的真实缺陷（同一根因）：

1. **必填 files / git 输入在 URL 模式下永远无法启动**：picker 给不出值 → `missingRequired` 永真 → Start 按钮永久 disabled，且界面无任何可操作入口。
2. **旧值静默泄漏**：先在 path 模式选过文件（`inputs[key]` = 一组本地仓路径），切到 URL 模式后 picker 退化、旧值仍留在 `inputs` 里，被 `buildLaunchBody` 原样提交到后端——指向另一个仓库的陈旧路径。

## 机会：缓存克隆本就在本地

URL 模式并非真的「没有本地仓库」。`RepoSourceRow` URL 模式已经在查 `GET /api/cached-repos`（`RepoSourceRow.tsx:79`），返回的每个 `CachedRepo` 都带 **`localPath`**（`cachedRepo.ts:12`，API 直接序列化、未脱敏）。而缓存目录是 `git clone <url> <tmpDir>` 产出的**普通克隆，带工作树**（`gitRepoCache.ts:445`，非 `--mirror`/`--bare`）——`git ls-files` / `git for-each-ref` 直接能在它上面跑。

也就是说：只要用户填的 URL 命中了某条已缓存仓库，我们就能把那条缓存的 `localPath` 喂给现有的 `/api/repos/files` 与 `/api/repos/refs`，**零后端改动**地让 picker 照常工作。未缓存的全新 URL 则回退成文本框，让用户手填路径（也顺带消除「旧值静默泄漏」——值在文本框里显式可见可编辑）。

## 目标

1. URL 模式下，当所填 URL **命中已缓存仓库**时，`FilesPicker` / `GitPicker(branch)` 复用缓存克隆的 `localPath` 照常枚举文件 / 分支。
2. URL 模式下 URL **未命中缓存**（或枚举失败）时，`files` / `git(branch)` 输入**回退为文本框**，用户手动填写（保持与 `FilesPicker` 同样的换行分隔值格式 / `git` 输入同样的 packed JSON），保证表单**始终可启动**。
3. 消除「旧值静默泄漏」：模式切换 / URL 变更后，`files`/`git` 输入的当前值始终在 UI 上**可见且可编辑**——缓存命中下，listing **内**的旧路径以 checkbox 勾选呈现，listing **外**的旧路径以**可删除 chip** 显式呈现（不再藏在隐藏的提交值里）；`GitPicker(branch)` 当前 ref 不在分支列表时也作为显式选项呈现；未命中→文本框直接显示原值。**这是强制项**（Codex 设计 gate P2）。
4. URL→缓存匹配**稳健且与后端同口径**：复用后端缓存键的规范化（`canonicalForHash`：`.git` / 末尾斜杠 / 大小写 / **同协议**两种 SSH 写法 ssh-scp↔ssh-uri / 凭证 折叠），而非脆弱的整串相等；**不跨协议**折叠（HTTPS 与 SSH 是不同缓存，与后端一致）。
5. 诚实披露 caveat：缓存工作树停在**克隆时的 index 快照**（克隆时检出的默认分支；RFC-068 的 FF 只 `update-ref` 不 checkout、不更新 index，故也可能落后于当前默认分支），列表可能与用户所选 `ref` 不一致——URL 命中缓存时给出明确提示。

## 非目标

- **不**做 `ref` 精确枚举（`git ls-tree -r <ref>`）：v1 只枚举缓存克隆的 index 快照（克隆时检出的默认分支）。`ref` 精确化列为后续增强（design §6）。
- **不**为枚举而触发克隆 / fetch：未缓存就是未缓存，回退文本框；要缓存请用户去 `/repos`（cached-repos 管理面）或正常启动一次。
- **不**新增 / 改动后端 endpoint、DB schema、migration（v1 纯前端 + 一个 shared 纯函数导出）。
- **不**改 path 模式既有行为（path 模式空仓时仍是「请先选择仓库」，字节守恒）。
- **不**改 `enum` / `text` / `upload` 输入；`git` 的 `commit-range` / `pr` 子类型本就是文本框、天然不受影响。
- **不**处理多仓（RFC-066）下「每个仓各自枚举」：picker 历来只认 `primarySource`（repos[0]），本 RFC 保持该约定。

## 用户故事

- **US-01（缓存命中）**：我有一个 `files` 输入 fan-out 给 3 个审计节点。我之前用 URL `https://github.com/foo/bar.git` 启动过任务（已缓存）。这次切到 URL 模式填同一个仓（哪怕这次写成不带 `.git` 的 `https://github.com/foo/bar` 或带末尾斜杠 / 带凭证），筛选路径框照常列出文件、可勾选；框顶提示「列表来自缓存克隆快照」。**匹配口径 = 后端缓存键口径**：折叠 `.git` 后缀 / 末尾斜杠 / 大小写 / 同协议两种 SSH 写法（`git@host:owner/repo` ↔ `ssh://git@host/owner/repo`）/ 凭证，但**不跨协议**——SSH URL 与 HTTPS URL 在后端是两个不同缓存（不会互相命中），前端匹配严格对齐这一点。
- **US-02（缓存未命中）**：我填了一个从没启动过的新 URL。筛选路径框回退成一个多行文本框，我手动粘进 `src/a.ts\nsrc/b.ts`，任务正常启动。
- **US-03（必填 git 输入）**：工作流有个必填 `git(branch)` 输入。URL 命中缓存→分支下拉用缓存的分支填充；未命中→回退成文本框让我直接填分支名。两种情况 Start 都能点。
- **US-04（消除泄漏）**：我先在 path 模式勾了几个文件，然后切到 URL 模式。我能立刻看到这些值（文本框里 / 或缓存列表里的勾选态），不会在我不知情下把旧仓路径提交出去。

## 验收标准

1. URL 模式 + URL 命中缓存：`FilesPicker` 列出缓存克隆的文件并可勾选；`GitPicker(branch)` 分支下拉非空。
2. URL 模式 + URL 未命中缓存：`files` 输入呈现多行文本框、`git(branch)` 输入呈现单行文本框，值与 picker 的 packed 格式一致，任务可成功启动。
3. URL 模式 + 枚举请求失败（缓存被 GC / 目录失效）：不报红 error-box，优雅回退文本框。
4. path 模式所有行为**字节守恒**（空仓「请先选择仓库」、选仓后枚举照旧）。
5. URL→缓存匹配对 `.git` 后缀 / 末尾斜杠 / 同协议 ssh 两形 / 凭证差异稳健（与后端缓存键同口径）；HTTPS 与 SSH **不**互相命中（显式测试锁定）。
6. URL 命中缓存时框顶渲染「列表来自缓存克隆快照，可能与所选 ref 不一致」提示。
7. **旧值不静默泄漏**（强制）：缓存命中下，已选但不在当前 listing 的路径以可删除 chip 显式呈现；`GitPicker(branch)` 当前 ref 不在分支列表时作为显式选项呈现；切换 hit A→hit B / loading→hit 不会把旧值藏起来。
8. 全套测试（shared `canonicalRepoKey` 含跨协议非命中 + 前端 `resolveUrlRepoPath` 纯函数 + `FilesPicker`/`GitPicker` 组件含状态转换/旧值可见 + i18n 对称 + 源码文本回归断言）随 PR 落地，`typecheck + test + format:check` 全绿，CI 全绿。

## 触发

2026-06-26 用户报「在 input 接了多个下游的时候，启动任务的 input 会变成筛选路径框，切换了远程 URL 这个框就坏了」；经诊断 + 反问，用户选定「用缓存克隆浏览」方向（未缓存回退文本框）。
