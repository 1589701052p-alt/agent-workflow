# RFC-110 — 技术设计

## 1. 改动总览（一张表）

| 层 | 文件 | 改动 |
| --- | --- | --- |
| shared | `packages/shared/src/git-url.ts` | 导出纯函数 `canonicalRepoKey(rawUrl): string \| null`（薄封装 `parseGitUrl` + 既有私有 `canonicalForHash`） |
| frontend lib | `packages/frontend/src/lib/launch-repo-source.ts` | 新增纯函数 `resolveUrlRepoPath(source, cached): string` |
| frontend route | `packages/frontend/src/routes/workflows.launch.tsx` | 加 `['cached-repos']` 查询；`repoPath` 由硬编码 `''` 改为 `resolveUrlRepoPath(...)`；向 `DynamicInput` 透传 `sourceKind` |
| frontend 组件 | `packages/frontend/src/components/launch/FilesPicker.tsx` | 加 `sourceKind` prop；URL 模式空/错回退文本框 + 缓存快照提示 + **旧路径可删除行（T7 强制；含 loading 期可见，Codex 实现 gate P2）** |
| frontend 组件 | `packages/frontend/src/components/launch/GitPicker.tsx` | 加 `sourceKind` prop；branch 子类型 URL 模式空/错回退文本框 + **当前 ref 不在分支列表时注入显式选项（T7 强制）** |
| frontend i18n | `i18n/zh-CN.ts` / `i18n/en-US.ts` | 新增对称 key：`launch.filesPicker.{cacheSnapshotHint,urlFallbackHint,extraSelectedHint}` + `launch.gitPicker.{currentRefOption,urlFallbackHint}` |

> **零新增 CSS**：旧值 / loading 行复用既有 `.files-picker__list` / `.files-picker__row`，**不**改 `styles.css`（避开协作者混合文件）。

**零后端 / 零 DB / 零 migration / 零 schema 改动。** 后端 `/api/repos/files`、`/api/repos/refs`、`/api/cached-repos` 全部复用现状。

## 2. 接口契约

### 2.1 `canonicalRepoKey`（shared，新导出）

```ts
/**
 * 把任意 Git URL 折叠成稳定的规范键——与缓存目录键 `gitUrlCacheKey` 内部
 * 用的 `canonicalForHash` 同口径：.git 后缀 / 末尾斜杠 / ssh-scp↔ssh-uri /
 * http(s) userinfo / 大小写 全部归一。无法解析的输入返回 null。
 * 纯函数、同步、无 crypto 依赖（不做 hash，只取 canonical 字符串）。
 */
export function canonicalRepoKey(rawUrl: string): string | null {
  const parsed = parseGitUrl(rawUrl)
  if (parsed === null) return null
  return canonicalForHash(parsed)
}
```

实现要点：`canonicalForHash` 当前是 `git-url.ts` 内的私有 `function`（`git-url.ts:183`），被 `gitUrlCacheKey` / `gitUrlCacheKeyWith` 复用。本 RFC 仅**对外暴露一层**，不改其逻辑——前端比较 canonical 字符串，后端 bucket 是 `sha1(canonical).slice(0,8)` 再按 `urlHash` 取首行（`gitRepoCache.ts:315/326`）。两者**口径同源**：除既有的 8 字符 sha1 碰撞极端情形（此时前端 miss、后端可能复用同 bucket 行——属预存风险、非本 RFC 引入）外，前端判定命中即后端会复用同一缓存目录。

**口径边界（Codex 设计 gate P2 勘误）**：`canonicalForHash` 对 http/https 归一为 `https://host/path`（`git-url.ts:194`）、对 SSH（scp 或 uri 两形）归一为 `ssh://user@host/path`（`git-url.ts:200`）。即——**同协议内**折叠 `.git`/末尾斜杠/大小写/ssh-scp↔ssh-uri/凭证；但 **HTTPS 与 SSH 是两个不同键**（后端也据此分两个缓存目录、不复用）。故 v1 **不跨协议命中**：用户若用 SSH 克隆过、这次填 HTTPS（反之亦然），视为未命中→回退文本框。这是与后端语义对齐的**正确**行为，不是缺陷。

> 备选（已否决）：在 `CachedRepo` API 暴露 `urlHash` 让前端 `gitUrlCacheKey` 异步 hash 比对。否决原因——需走 Web Crypto 异步、要改 API schema，而 `canonicalForHash` 的 canonical 字符串本身就是稳定可比的，同步即可，更简单。

### 2.2 `resolveUrlRepoPath`（frontend lib，新函数）

```ts
import type { CachedRepo, RepoSource } from '...'
import { canonicalRepoKey } from '@agent-workflow/shared'

/**
 * 启动表单 picker 用的「有效本地路径」：
 *   - path 模式 → 直接用 source.repoPath（可能为空，path 模式自处理）
 *   - url  模式 → 规范化 repoUrl，在 cached 里找同 canonical 键的条目，
 *                 命中返回其 localPath，未命中 / URL 不可解析返回 ''
 * 纯函数，无副作用、无 hook。
 */
export function resolveUrlRepoPath(source: RepoSource, cached: CachedRepo[]): string {
  if (source.kind === 'path') return source.repoPath
  const key = canonicalRepoKey(source.repoUrl)
  if (key === null) return ''
  const hit = cached.find((c) => canonicalRepoKey(c.url) === key)
  return hit?.localPath ?? ''
}
```

### 2.3 picker 组件 props 扩展

`FilesPicker` / `GitPicker` 各加一个 **可选** prop `sourceKind?: 'path' | 'url'`（默认 `'path'`，使所有现有调用方 / 测试不写该 prop 时行为字节守恒）。

```ts
interface Props {
  def: WorkflowInput
  repoPath: string
  value: string
  onChange: (next: string) => void
  sourceKind?: 'path' | 'url'   // 新增；缺省 'path'
}
```

## 3. 数据流

```
workflows.launch.tsx
  ├─ useQuery(['cached-repos'])  // 与 RepoSourceRow 同 queryKey，React Query 自动去重
  │     enabled: primarySource.kind === 'url'
  ├─ const cachedItems = cached.data?.items ?? []
  ├─ const effectiveRepoPath = resolveUrlRepoPath(primarySource, cachedItems)
  └─ <DynamicInput
        repoPath={effectiveRepoPath}            // 旧: primarySource.kind==='path' ? repoPath : ''
        sourceKind={primarySource.kind}         // 新
        ... />
            └─ kind==='files' → <FilesPicker repoPath sourceKind .../>
            └─ kind==='git'   → <GitPicker   repoPath sourceKind .../>
```

`effectiveRepoPath` 三种取值：
- path 模式选了仓 → 本地仓路径（行为不变）。
- url 模式命中缓存 → 缓存 `localPath`（**新增能力**）。
- path 模式未选仓 / url 模式未命中 / URL 不可解析 → `''`（picker 据 `sourceKind` 决定「请先选仓」还是「文本框回退」）。

## 4. picker 渲染分支（核心）

### 4.1 FilesPicker

所有 hook（`useState`/`useQuery`/`useMemo`）保持在组件顶部**无条件调用**（现状即如此，避免 hooks 顺序问题），早返回放最后。新分支逻辑：

实现里抽一个 `selectedRows(paths, testid)` helper——把一组路径渲染成「checked 可取消的行」（复用主列表的 `.files-picker__row`），同时服务于「旧值兜底」和「loading 期保持可见」两处。

```tsx
const urlMode = sourceKind === 'url'

// selectedRows(paths, testid): <ul.files-picker__list> 内每行一个 checked
// checkbox + <code>path</code>，onChange={()=>toggle(p)}（取消勾选即移除）。

// 1) 无有效路径
if (repoPath === '') {
  if (urlMode) return fallback                                                  // 未缓存 → TextArea
  return <div className="muted">{t('launch.filesPicker.pickRepoFirst')}</div>   // path 未选仓（不变）
}
// 2) 加载中：url 模式且已有选择 → 保持旧值可见可删（Codex 实现 gate P2），否则「Loading…」
if (all.isLoading) {
  if (urlMode && selected.size > 0)
    return <div className="files-picker">
      <div className="form-field__hint">{t('launch.filesPicker.loading')}</div>
      {selectedRows([...selected], 'files-picker-loading-selected')}
    </div>
  return <div className="muted">{t('launch.filesPicker.loading')}</div>
}
// 3) 枚举失败
if (all.error != null) {
  if (urlMode) return fallback                                                  // 缓存失效 → 优雅回退
  return <div className="error-box">{describeError(all.error)}</div>            // path（不变）
}
// 4) 列表 UI；urlMode 时框顶渲染缓存快照 hint
{urlMode && <div className="form-field__hint">{t('launch.filesPicker.cacheSnapshotHint')}</div>}
// 4b) 旧值兜底（强制，Codex P2）：已选但不在当前 listing 的路径 → 可删除行
const extraSelected = [...selected].filter((p) => !new Set(all.data?.files ?? []).has(p))
{extraSelected.length > 0 && <>
  <div className="form-field__hint">{t('launch.filesPicker.extraSelectedHint')}</div>
  {selectedRows(extraSelected, 'files-picker-extra-selected')}
</>}
```

`fallback`：复用公共 `TextArea`（`components/Form.tsx`，`monospace`），换行分隔，`onChange` 直接透传——packed 格式与勾选模式完全一致（都是换行 join 的路径），故缓存命中↔未命中之间切换值无损。附 `launch.filesPicker.urlFallbackHint`。

**旧值不静默泄漏（强制，Codex 设计 gate P2 + 实现 gate P2）**：`selected` 来自 `value`，但主列表只渲染 `all.data.files` 里的路径。两个隐身窗口都堵上：① 稳态切仓 / hit A→hit B 后 `value` 残留、不在新 listing 的旧路径 → §4b `extraSelected` 可删除行；② **加载窗口**——cache 解析出 repoPath 后、文件列表还在 loading 时，旧值不能被「Loading…」盖住（实现 gate P2 抓的真问题）→ §2 url 模式 loading 期用 `selectedRows` 保持当前选择可见可删。这样无论 path↔url / hit↔hit / loading→hit 怎么切，当前提交值始终在 UI 可见可删——兑现 proposal 目标 3 / AC 7。

> 前端 UI 一致性（CLAUDE.md 强制条）：回退用既有 `TextArea` 公共原语，**不**自落 `<textarea className=...>`；提示用既有 `.form-field__hint` / `.muted`；旧值 / loading 行复用 `files-picker` 既有 `.files-picker__list` / `.files-picker__row` 样式族，**零新增 CSS**（不动 `styles.css`）。

### 4.2 GitPicker

仅 `gitKind === 'branch'` 受影响（`commit-range`/`pr` 已是文本框）。branch 分支：

```tsx
if (gitKind === 'branch') {
  const noRefs = repoPath === '' || (refs.error != null)
  if (sourceKind === 'url' && noRefs) {
    // 文本框回退：直接填分支名，emit {kind:'branch', ref}
    return <Field label=...><TextInput value={current} onChange={(ref)=>emit({kind:'branch',ref})} .../></Field>
  }
  // 否则照旧：Select 用 refs.data.branches 填充（命中缓存即非空）。
  // 旧值兜底（强制，Codex P2）：current（来自 value 的 ref）非空但不在 branches 里 →
  // 注入为显式选项，避免 Select 静默回落 placeholder 而 value 仍提交旧 ref。
  const branches = refs.data?.branches ?? []
  const options = [
    { value: '', label: t('launch.pickBranchPlaceholder') },
    ...(current !== '' && !branches.includes(current)
      ? [{ value: current, label: t('launch.gitPicker.currentRefOption', { ref: current }) }]
      : []),
    ...branches.map((b) => ({ value: b, label: b })),
  ]
  return <Field ...><Select value={current} options={options} onChange={(ref)=>emit({kind:'branch',ref})} .../></Field>
}
```

注意 `GitPicker.tsx:49` 的 `refs` 查询 `enabled: repoPath !== '' && gitKind === 'branch'`——repoPath 现在可能是缓存路径，命中即正常拉到缓存分支。`current` 注入解决「缓存分支列表里没有用户旧 ref」时 Select 显占位但 `inputs` 仍藏旧 JSON 的静默泄漏（与 §4b 同根，Codex 指出 `Select.tsx:97/180` current-not-found 只显 placeholder）。

## 5. 与现有模块的耦合点 / 不变式

- **缓存键同口径**（§2.1）：前端 `canonicalRepoKey` 与后端 `gitUrlCacheKey` 共用 `canonicalForHash`。若后端将来改 `canonicalForHash`，前端自动同步（同一函数）。**回归断言**锁这条：测同一组 URL 变体经 `canonicalRepoKey` 得同键。
- **`['cached-repos']` 查询去重**：launch route 与 `RepoSourceRow` 用同 queryKey，React Query 合并为一次请求；route 只读不写。
- **path 模式字节守恒**：`sourceKind` 缺省 `'path'`；`effectiveRepoPath` 在 path 模式 = `source.repoPath`（与旧 `primarySource.kind==='path' ? repoPath : ''` 在 path 分支等价）。源码文本回归断言：`workflows.launch.tsx` 不再出现 `? primarySource.repoPath : ''` 这一硬编码 url-清空 模式。
- **multi-repo（RFC-066）**：picker 仍只认 `primarySource = repos[0]`；多仓 url-mode 解析 repos[0]。无新交叉。
- **ACL / 安全**（Codex 设计 gate 核实「无新增暴露面」+ 措辞修正）：v1 不引入新 endpoint、不新增数据暴露面。`/api/repos/*` 与 `/api/cached-repos/*` 都由 `repos:read` 权限门控（`server.ts:115`），且普通 user baseline 已含 `repos:read`（`permission.ts:61`）。`CachedRepo.url`（脱敏前，仅用于 `canonicalRepoKey` 比对、**绝不渲染**）/ `localPath` 对前端可见、`/api/repos/files` 接受任意 path——这些都是**既有 API 事实**，非本 RFC 引入。准确表述：**同一个持 `repos:read` 的 actor 今天就已能拿到 `localPath` 并手动调这些只读 repo endpoint**；RFC-110 只是把这一已存在的能力接进 launcher UI，不放宽任何权限。缓存为全局共享 mirror（非 RFC-099 五类资源），与现状一致。`canonicalKey` 只读 `c.url` 比对、不显示，且 `canonicalForHash` 本就丢弃 userinfo/凭证，故无 RFC-103 T8 式凭证泄漏风险。

## 6. 失败模式 / caveat（诚实披露）

1. **`ref` 不一致（已知 caveat，v1 接受）**：缓存工作树停在 clone 时检出的默认分支；RFC-068 的 FF 只 `git update-ref` 不 checkout、也不更新 index（Codex 核实 `gitRepoCache.ts:339/361`）。故 `git ls-files` 读到的是 **clone 时刻的 index 快照**（`git.ts:182`）——既可能 ≠ 用户所选 `ref`，也可能 ≠ 当前默认分支最新。对「挑文件名喂给 input」这一用途通常无害（文件集变化慢），且 §4.1 框顶 hint 明示「缓存克隆快照」（不写成「默认分支」以免暗示总是最新）。**后续增强**：`/api/repos/files` 加可选 `ref` → `git ls-tree -r --name-only <resolved-ref>`，前端把所选 ref 传下去做精确枚举（需 mirror 内 branch→origin/branch 解析，留待独立 PR）。
2. **缓存被 GC / 目录失效**：`/api/repos/files` 对失效路径 `requireGitRepo` 抛 `repo-path-missing` → §4.1 在 url 模式优雅回退文本框（不报红）。
3. **URL 不可解析**：`canonicalRepoKey` 返回 `null` → `resolveUrlRepoPath` 返回 `''` → url 模式回退文本框。与 `validateRepoUrl`（`RepoSourceRow` 仍独立校验 URL 合法性、控制 Start 门）不冲突：picker 回退只是让 files/git 值可填，Start 仍受 `sourceReady` 门控。
4. **旧值跨仓残留（缓存命中分支）—— 已升级为强制核心项（Codex 设计 gate P2）**：缓存命中时 `FilesPicker` 用 checkbox / `GitPicker` 用 Select，`value` 里有但不在当前 listing / 分支列表的旧值不会显示，却仍会提交。**v1 必做**（不再是可选）：FilesPicker 把「已选但不在 listing」渲染成可删除行（§4b）、GitPicker 把「当前 ref 不在分支列表」注入为显式选项（§4.2）。两者共同保证：任何 path↔url / hit↔hit / loading→hit 切换后，提交值始终在 UI 可见可删——这正是 proposal 目标 3 的硬性要求，故归入 plan T7（mandatory）。

## 7. 测试策略（哪些 case 必写）

**shared（`packages/shared/tests/git-url*.test.ts`）**（Codex P2：同协议折叠、跨协议不折叠）
- **HTTPS 同键组**：`https://github.com/foo/bar` / `…/bar.git` / `…/bar/` / `https://user:tok@github.com/foo/bar`（带凭证）→ 彼此同一键。
- **SSH 同键组**：`git@github.com:foo/bar.git`（scp 形）/ `ssh://git@github.com/foo/bar`（uri 形）/ `…/bar`（无 .git）→ 彼此同一键。
- **跨协议断言**：HTTPS 组的键 ≠ SSH 组的键（`canonicalRepoKey('https://github.com/foo/bar') !== canonicalRepoKey('git@github.com:foo/bar.git')`）——锁住「v1 不跨协议命中」。
- 不可解析（空串 / 含空格 / `not a url`）→ `null`。

**frontend 纯函数（`launch-repo-source` 测试）**
- `resolveUrlRepoPath`：path 模式 → `source.repoPath` 直通。
- url 命中（同协议 `.git`/斜杠变体）→ 命中条目的 `localPath`。
- **跨协议不命中**：cached 里只有 SSH 条目、source 填等价 HTTPS → 返回 `''`（回退文本框）。
- url 未命中 → `''`；url 不可解析 → `''`；空 `cached` → `''`。

**frontend 组件（`files-picker.test.tsx` / 新 `git-picker.test.tsx`）**
- FilesPicker `sourceKind='url'` + `repoPath=''` → 渲染 `TextArea`（role=textbox），输入透传 `onChange`。
- FilesPicker `sourceKind='url'` + `repoPath='/cache/x'`（mock `/api/repos/files` 返回若干文件）→ 渲染 checkbox 列表 + 缓存快照 hint。
- FilesPicker `sourceKind='url'` + 查询 error → 回退 `TextArea`（不出 error-box）。
- FilesPicker `sourceKind='path'`（缺省）+ `repoPath=''` → 「请先选择仓库」（**回归守恒**）。
- **旧值兜底（Codex P2，强制）**：FilesPicker 命中 + `value` 含不在 listing 的旧路径 → 旧路径以可删除行 `files-picker-extra-selected` 渲染，点 × 后从 `onChange` 值移除；**状态转换**：先 loading（无 files）→ later 返回 files，旧选中值全程可见不被隐藏；repoPath 从 `/cache/A`→`/cache/B`（文件集不同）后，A 独有的旧选中仍以可删除行可见。
- GitPicker branch `sourceKind='url'` + `repoPath=''` → `TextInput` 回退，emit `{kind:'branch',ref}`。
- GitPicker branch `sourceKind='url'` + `repoPath='/cache/x'`（mock refs）→ Select 非空。
- **GitPicker 旧值兜底（Codex P2）**：`value={kind:'branch',ref:'feature-x'}` 且 `feature-x` 不在 mock branches → Select options 含 `feature-x`（显式可见）、value=feature-x，而非静默回落 placeholder。
- **cached-repos 查询失败不阻塞**（launch route 层 / 组件层）：`['cached-repos']` 查询 error → `resolveUrlRepoPath` 收到空 `cached` → 回退文本框，表单仍可启动（不卡死、不报红）。

**源码文本回归断言**
- `workflows.launch.tsx` 不含硬编码 `? primarySource.repoPath : ''`（防回退老逻辑）。
- `workflows.launch.tsx` 引用 `resolveUrlRepoPath`。

**i18n 对称**：新增 key 在 zh-CN / en-US 两侧成对（复用既有 i18n-keys 对称测试）。

## 8. 决策记录

- **D1**：URL→缓存匹配用 `canonicalForHash` 同步规范化（§2.1），不暴露 `urlHash` / 不走异步 hash。
- **D2**：未缓存 / 解析失败 / 枚举失败一律**文本框回退**（而非禁用），保证表单始终可启动（目标 2）。
- **D3**：v1 枚举缓存克隆的 index 快照（克隆时默认分支）+ 明示「缓存克隆快照」hint；`ref` 精确枚举列为后续增强（§6.1）。
- **D4**：纯前端 + 一个 shared 导出，零后端 / DB 改动。
- **D5**：`sourceKind` 可选缺省 `'path'`，path 模式与所有现存调用方字节守恒。
- **D6（Codex 设计 gate P2）**：v1 匹配口径严格对齐后端缓存键——**不跨协议**（HTTPS↔SSH 视作不同缓存）。不在前端单方面做跨协议折叠（否则偏离后端 `urlHash` 复用语义）；跨协议合并若需要，作为后端 cache-key 语义变更单独立项（评估 auth/凭证/缓存合并风险）。
- **D7（Codex 设计 gate P2）**：「旧值不静默泄漏」是**强制核心项**（plan T7 mandatory），覆盖 FilesPicker（extraSelected 可删除行）+ GitPicker（current ref 注入选项）两处，兑现目标 3。
