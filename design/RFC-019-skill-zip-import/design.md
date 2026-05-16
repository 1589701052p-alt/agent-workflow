# RFC-019 Skill ZIP 批量导入 — 技术设计

## 1. 模块边界

```
packages/shared/src/skill-md.ts             ← SKILL.md frontmatter 解析（纯函数）
packages/shared/src/skill-zip.ts            ← parseSkillZipEntries 纯函数 + 类型
packages/shared/src/schemas/skill.ts        ← +ImportZipDecisionSchema, ImportZipResultSchema, ParseSkillZipResultSchema

packages/backend/src/services/skill-zip.ts  ← parse / commit 业务逻辑（fs 写盘 + DB 写入）
packages/backend/src/routes/skills.ts       ← +POST /api/skills/import-zip/parse + /commit

packages/frontend/src/routes/skills.new.tsx ← +Upload ZIP tab
packages/frontend/src/components/skills/ImportZipDialog.tsx ← 候选表 + 冲突 select + 提交
packages/frontend/src/i18n/{en-US,zh-CN}.ts ← 新文案
```

**零改动**：`runner.ts` / `runtime.ts` / `scheduler.ts` / `skill-source.ts` / `validator.ts` / DB migration（沿用 `skills` 表既有列，managed 形态完全相同）。

## 2. 依赖

- 新增 dev-runtime 依赖：`fflate@^0.8`（pure-JS、~15KB、Bun 兼容、无 native binding）
  - 落 `packages/shared/package.json`（解析在 shared 跑，方便单测 / 未来前端预览复用）
  - **不**用 `jszip`（重）/ `adm-zip`（旧 API、Node-only）
- shared 已有 `yaml@^2.6.1`，复用解析 frontmatter

## 3. 顶层结构识别（纯函数）

`packages/shared/src/skill-zip.ts`

```ts
export interface ZipEntryRef {
  /** posix-style path inside the zip, never starts with '/', never contains '..' segments. */
  path: string
  isDir: boolean
  size: number
  bytes: () => Uint8Array  // lazy decode
}

export interface SkillCandidate {
  /** kebab-case name (= source dir name) */
  name: string
  /** description from SKILL.md frontmatter, '' if absent */
  description: string
  /** parsed frontmatterExtra (everything not in {name, description}) */
  frontmatterExtra: Record<string, unknown>
  /** raw SKILL.md body markdown */
  bodyMd: string
  /** all files belonging to this skill, paths are relative to the skill dir (e.g. 'SKILL.md', 'reference/foo.md') */
  files: ZipFileSlice[]
  /** size sum of files (decoded) */
  totalBytes: number
  /** parser warnings (e.g. unknown frontmatter shape) — non-fatal */
  warnings: string[]
}

export interface ZipFileSlice {
  relPath: string
  bytes: Uint8Array
}

export interface ParseSkillZipResult {
  /** valid, complete candidates (have SKILL.md + valid name) */
  skills: SkillCandidate[]
  /** per-candidate failures (no SKILL.md / bad name / duplicate inside zip / etc.) */
  errors: Array<{ path: string; code: string; message: string }>
}

export function parseSkillZipEntries(entries: ZipEntryRef[]): ParseSkillZipResult
```

**算法**：

1. 归一化所有 entry 路径：拒绝以 `/` 开头、含 `..` 段、Windows `\\` 已先在调用方替换为 `/`。
2. 计算 `topDirs = [unique first-segment values across all entries]`。
3. 若 `topDirs.length === 1` 且**该顶层目录直接子项中没有 `SKILL.md`**（即 `<top>/SKILL.md` 不存在），剥掉一层 wrapper：把所有 entry 的 path 去掉 `<top>/` 前缀；重新计算 `topDirs`。
4. 对每个 `topDir`：
   - 收集所有 `<topDir>/...` 文件
   - 检查 `<topDir>/SKILL.md` 是否存在 → 不存在 → 进 `errors` 用 code `skill-md-missing`
   - 解析 `SKILL.md` frontmatter → 抽 `description` + `frontmatterExtra` + `bodyMd`；YAML 失败 → 进 warnings 但仍以 dirname 当 name 收下
   - name 校验：dirname 必须匹配 `SkillNameRegex`（已有，`/^[a-z0-9][a-z0-9-]*$/`）；不匹配 → `errors` 用 code `skill-name-invalid`
   - SKILL.md 里 `name` 字段若与 dirname 不一致：以 **dirname 为准**（落盘后路径就是 dirname；warning 一条说明覆盖）
5. 检查跨候选 name 重复 → 整包视为不可导入，整体冒泡为一个 errors 项 `code: 'skill-name-duplicated-in-zip'`，对应 candidate 全部从 `skills` 移到 `errors`。

边界：

- 空 zip / 没有任何目录 → `errors: [{path:'', code:'no-skill-found'}]`
- 顶层是单文件（不是目录）→ 同 `no-skill-found`

## 4. ZIP 解压与安全限额

`packages/backend/src/services/skill-zip.ts` 入口：

```ts
async function decodeZip(buffer: Uint8Array): Promise<ZipEntryRef[]>
```

实现：

- 用 `fflate.unzipSync(buffer)` → `Record<string, Uint8Array>`（同步即可，zip 在内存里）
- 解码后逐个 entry 校验：
  - 路径反斜杠归一为 `/`
  - 拒绝以 `/` 开头 → `zip-absolute-path`
  - 拆段后任一段 === `..` → `zip-traversal`
  - **限额**（写在常量，可配）：单文件 ≤ 10 MiB；总解压 ≤ 64 MiB；条目数 ≤ 2000；目录深度 ≤ 12
  - fflate 不区分 symlink，但 zip mode bits 在 entry header 里——保险起见我们直接对所有 entry 当普通文件处理，不跟随 mode（哪怕带了 symlink mode bit，文件内容会被当字节读，不会触发 fs symlink 创建）
- 任一限额超出 → 抛 `ValidationError('zip-limit-exceeded', ...)`，不返回部分结果

ZIP 总大小上限：multipart 端点级别限制 `request body ≤ 64 MiB`（沿用 hono body limit）。

## 5. HTTP 端点

```
POST /api/skills/import-zip/parse
  Content-Type: multipart/form-data
  fields: file=<zip>
  → 200 { skills: ParseCandidateView[], errors: ParseError[] }
       ParseCandidateView = { name, description, fileCount, totalBytes, warnings, conflict?: 'managed'|'external' }
  → 400 ValidationError on zip-limit / zip-traversal / zip-decode-failed

POST /api/skills/import-zip/commit
  Content-Type: multipart/form-data
  fields:
    file=<zip>            ← 同一份 zip 再传一次（无后端临时 staging 目录，避免清理生命周期）
    decisions=<JSON>      ← { [skillName]: { action: 'skip' } | { action: 'overwrite' } | { action: 'rename', newName: string } }
  → 200 {
       created: Skill[],   // brand-new
       updated: Skill[],   // overwritten managed
       skipped: Array<{ name: string; reason: string }>,
       failed:  Array<{ name: string; code: string; message: string }>,
     }
```

设计要点：

- **不**在后端 cache zip / 也不引入 staging dir。两次上传的代价（用户文件量级 < 几 MiB）远低于 staging 目录生命周期/清理引入的状态机复杂度
- decisions 表的 key 用 **原始 candidate name**（解析阶段返回的）；rename 的 `newName` 落盘时作为新目录名
- 端点级 multipart 大小限额 64 MiB（hono.body() 配置；超出 413）
- parse 端点是纯只读，无副作用；commit 端点是写

## 6. Commit 落盘流程

对 `decisions` 中 `action != 'skip'` 的每个 candidate，按 dictionary order 串行：

1. 决定目标 name：`overwrite` → 用 candidate.name；`rename` → 用 newName（再校验 SkillNameRegex + 不与 DB 现有冲突）
2. 检查 DB 同名：
   - 不存在 → 走 createManaged 路径
   - 存在且 `sourceKind = 'external'`：在 commit 阶段强制 fail（UI 已 disabled，但后端补一道）→ 进 `failed[]` code `skill-external-cannot-overwrite`
   - 存在且 `sourceKind = 'managed'` 且 `action = 'overwrite'`：先 `rmSync(skillRoot, {recursive:true})` 再写新内容；DB row 走 update（保留 id，仅更新 description/updatedAt + frontmatterExtra 写进 SKILL.md）
3. 落盘步骤（每个 skill）：
   - `mkdirSync(filesDir, {recursive:true})`
   - 把 candidate.files 里每个 ZipFileSlice 写到 `filesDir/<relPath>`
   - SKILL.md 由我们重新 stringify（用 candidate.frontmatterExtra + name + description + bodyMd），覆盖 zip 里那份原始 SKILL.md（保证 name 字段与 dirname 一致）
   - DB upsert
4. **失败语义**：单 skill 失败不影响下一个；该 skill 进 `failed[]`，已写盘的 skill 文件保留（已写入 DB 也保留），让用户在 `/skills` 列表里看到部分结果。返回摘要里明确列哪些 fail。

> 替代方案：**全成功才提交** — 实现复杂（需要预先把所有写盘 stage 到临时目录，再 atomic rename），收益较小。第一版采取"逐项最终一致 + 摘要"。

## 7. 前端

`/skills/new` 现已有 tabs：Form / Folder（RFC-017）。新增第三个 tab **Upload ZIP**。

`ImportZipDialog`（实际上是 page-section 而非 modal，复用 RFC-017 卡片样式）：

```
[ Choose ZIP file ]                                  [ Parse ]
─── after parse ───
errors banner (if any)
table:
  ☑ name        description           files   conflict       action
  ─ skill-foo   ...                   12      —              [auto: import as new]
  ─ skill-bar   ...                   3       managed dup    [Skip ▾ Overwrite | Rename →]
  ─ skill-baz   ...                   8       external dup   [Skip — disabled, w/ tooltip]
[ Cancel ]                            [ Import N skills (m skipped) ]
```

- name 列冲突标记由 `conflict` 字段驱动
- Rename 时打开 inline `<input>`，校验 SkillNameRegex + 不与已有冲突 + 不与本批其他 candidate 重名（前端实时校验，commit 端点也兜底）
- 提交时把已选决策 + 原 zip File 一起再 POST 到 commit
- 完成后跳 `/skills` 并 toast `created N, updated M, skipped K, failed F`

## 8. 校验复用

- `SkillNameRegex` / `SkillNameSchema`：`packages/shared/src/schemas/skill.ts` 已有，复用
- `parseFrontmatter`：复用 `packages/shared/src/agent-md.ts` 已有的 `parseAgentMarkdown` 内部 helper（如果是 file-internal，重构提到 module 顶层 export）；或者新建 `parseFrontmatterMd` 共用纯函数
- `stringifyFrontmatter`：复用 `packages/backend/src/services/skill.ts` 已有

## 9. 测试策略

**shared 单测**（`packages/shared/tests/skill-zip.test.ts`）—— 14+ case：

- 形式 A：顶层 2 skill，全 happy
- 形式 B：wrapper + 3 skill，剥层后 happy
- 形式 B 但 wrapper 内只有一个 skill（仅有一个子目录）
- 形式 A 但只有一个 skill 目录
- 顶层只有一个目录但**含 SKILL.md** → 当形式 A，按单 skill 收
- SKILL.md 缺失 → errors[code=skill-md-missing]
- 目录名非 kebab-case → errors[code=skill-name-invalid]
- 同一 zip 内目录重名 → errors[code=skill-name-duplicated-in-zip]
- frontmatter YAML 失败 → 仍收 candidate + warnings
- frontmatter `name` 与 dirname 不一致 → 用 dirname + warning
- 顶层散文件（无目录）→ no-skill-found
- 空 zip → no-skill-found
- 候选 skill 内的子文件保持完整 relPath（含 reference/...）
- 二进制（图片）文件保持原字节不被 utf-8 误解码

**backend 单测**（`packages/backend/tests/skill-zip-decode.test.ts` + `skill-zip-commit.test.ts`）—— 12+ case：

- decodeZip：单文件超限 / 总大小超限 / 条目数超限 / zip-traversal `..` / 绝对路径 → 全部抛 ValidationError
- decodeZip：合法 zip → entries 数量 + 内容字节断言
- commit：仅 skip → 0 写盘 / 0 DB 改动
- commit：rename + name 已有 → 第二轮校验失败 → failed[]
- commit：overwrite managed → DB row id 不变 + filesDir 内容已替换 + 旧文件被删
- commit：overwrite external → failed[code=skill-external-cannot-overwrite] + 文件 / DB 不动
- commit：rename newName 非法 / 与已 DB 同名 / 与本批其他 candidate 同名 → failed
- commit：单 skill 写盘失败（mock fs 抛错），后续 skill 仍执行
- commit：成功后 `getSkill` 能立即读出，`readSkillContent` 返回我们重写的 SKILL.md

**HTTP 测**（`packages/backend/tests/skills-import-zip-http.test.ts`）—— 6+ case：

- POST parse 无 file → 400
- POST parse 合法 zip → 200，shape 校验
- POST commit 缺 decisions → 400
- POST commit 决策表里有 zip 不存在的 name → 忽略并在 response 提示
- POST 体超限 413
- 两端点 happy path 端到端：parse → commit → GET /api/skills 看到新 skill

**前端测**（`packages/frontend/tests/skills-import-zip-*.test.tsx`）—— 12+ case：

- ImportZipDialog 渲染候选表
- 冲突行 select 切换
- external 冲突行 disabled
- Rename inline 输入校验：非法 name / 与本批冲突 / 与已 DB 冲突（mock fetch /api/skills）
- Parse 失败 banner
- Submit happy → mock fetch + 跳转
- 源代码层断言：`skills.new.tsx` import `ImportZipDialog`；button testid 存在

**回归 / 文本断言**：

- backend `runner.ts` / `runtime.ts` / `skill-source.ts` 源代码层断言"未引入 zip 相关 import"（这些模块零改动）

## 10. 错误码（统一）

| code                              | 触发                                  | HTTP |
| --------------------------------- | ------------------------------------- | ---- |
| `zip-decode-failed`               | fflate.unzipSync 抛错                 | 400  |
| `zip-limit-exceeded`              | 单文件 / 总大小 / 条目数 / 深度超限   | 400  |
| `zip-traversal`                   | `..` / 绝对路径                       | 400  |
| `no-skill-found`                  | 解析后 0 candidate                    | 400  |
| `skill-md-missing`                | candidate 目录缺 SKILL.md             | per-row error |
| `skill-name-invalid`              | dirname 非 kebab-case                 | per-row error |
| `skill-name-duplicated-in-zip`    | zip 内同名目录                        | per-row error |
| `skill-external-cannot-overwrite` | DB 同名是 external，决策 overwrite    | per-row failed |
| `skill-rename-conflict`           | rename 后又撞名                       | per-row failed |
| `skill-write-failed`              | 落盘 fs 异常                          | per-row failed |

## 11. 与失败模式的对账

- **zip slip**：`..`/绝对路径全部在 decodeZip 阶段拒绝；落盘端 `path.join` 后再 `path.resolve`，断言 startsWith filesDir 兜底
- **同名并发写**：commit 串行处理，不引入跨 candidate 并发；同一 skill name 在 commit 期间不会有第二个并发请求（DB 同名检查 + 写盘是同步序列）
- **DB 写但 FS 写失败**：先写盘后写 DB，失败提前于 DB；overwrite 路径里 `rmSync` 失败 → 抛 → DB row 不变
- **import 后立即 list 看不到**：getSkill 在同一连接里 select，listSkills 同事务，无需 invalidate
- **runner 运行时拿到的 skill**：managed 形式与已有 createManaged 完全一致（都是 `~/.agent-workflow/skills/{name}/files/`），runner.ts 注入流程零改动
