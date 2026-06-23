# RFC-102 技术设计

## 1. 概览

统一判据：**「能否替换一个已存在 skill」= `isResourceOwner(actor, skill)`**（`services/resourceAcl.ts:140-143`，admin 或 `ownerUserId === actor.user.id`）。两条路径都复用它，不再各写近似判断。

- **Part A（ZIP）**：`parse` 把 actor 相关的 `canOverwrite` 暴露给前端；`commit` 加后端权限闸。修越权漏洞。
- **Part B（Source）**：新增带外 `replace` 操作，校验对被占用 skill 的写权限；前端从已有 `['skills']` 数据推导可替换性。

两部分都不触碰对方代码，可独立成 PR（§7）。

---

## 2. Part A — ZIP 写权限

### 2.1 契约变更（`packages/shared/src/schemas/skill.ts`）

```diff
 export const SkillZipCandidateViewSchema = z.object({
   name: SkillNameSchema,
   description: z.string(),
   fileCount: z.number().int().nonnegative(),
   totalBytes: z.number().int().nonnegative(),
   warnings: z.array(z.string()),
   conflict: SkillZipCandidateConflictSchema.optional(),
+  /**
+   * RFC-102: actor 是否可替换这个同名 skill。仅 `conflict` 存在时有意义。
+   * external 恒 false（技术约束）；managed = isResourceOwner(actor, existing)。
+   * 不暴露 owner 身份——不可见的 private 同名对非 admin 自然得 false。
+   */
+  canOverwrite: z.boolean().optional(),
 })
```

```diff
 export const SkillZipCommitFailureCodeSchema = z.enum([
   'skill-external-cannot-overwrite',
   'skill-rename-conflict',
   'skill-write-failed',
   'skill-md-missing',
   'skill-name-invalid',
+  'skill-overwrite-forbidden',   // RFC-102: 无写权限却请求 overwrite
 ])
```

`SkillZipDecisionSchema` **不变**（仍 skip/overwrite/rename/import）——权限是服务端裁决，不是新动作。

### 2.2 parse 数据流（`services/skill-zip.ts` + `routes/skills.ts`）

抽一个纯函数便于直测：

```ts
// services/skill-zip.ts
import { isResourceOwner } from '@/services/resourceAcl'
import type { Actor } from '@/auth/actor'

/** RFC-102: 由 actor + 同名既有行（可能 undefined）推导冲突视图字段。纯函数。 */
export function computeConflictView(
  actor: Actor,
  existing: Skill | undefined,
): { conflict?: SkillZipCandidateConflict; canOverwrite?: boolean } {
  if (existing === undefined) return {}
  if (existing.sourceKind === 'external') return { conflict: 'external', canOverwrite: false }
  return { conflict: 'managed', canOverwrite: isResourceOwner(actor, existing) }
}
```

`parseSkillZipBuffer` 加 `actor` 形参，对每个候选调用上式填充 view：

```diff
-export async function parseSkillZipBuffer(db, buffer):
-  Promise<{ response; candidates }> {
+export async function parseSkillZipBuffer(db, actor, buffer):
+  Promise<{ response; candidates }> {
   ...
   const skillsView = parsed.skills.map((c) => {
-    const conflict = byName.get(c.name)
-    const view = { name, description, fileCount, totalBytes, warnings }
-    if (conflict !== undefined) view.conflict = conflict.sourceKind
-    return view
+    const view = { name, description, fileCount, totalBytes, warnings,
+                   ...computeConflictView(actor, byName.get(c.name)) }
+    return view
   })
```

`byName` 仍来自 `listSkills(db)` **全表**（不做可见性过滤，见 §5·D8）。路由：

```diff
 app.post('/api/skills/import-zip/parse', async (c) => {
   const buffer = await readZipFileFromMultipart(c.req.raw)
-  const { response } = await parseSkillZipBuffer(deps.db, buffer)
+  const { response } = await parseSkillZipBuffer(deps.db, actorOf(c), buffer)
   return c.json(response)
 })
```

### 2.3 commit 权限闸（`services/skill-zip.ts` + `routes/skills.ts`）

`commitSkillZipBuffer` 的 `aclOpts` 从 `{ ownerUserId? }` 改为携带 `actor`（owner 由 `actor.user.id` 取，且权限闸要用 actor）：

```diff
 export async function commitSkillZipBuffer(
   db, opts, buffer, decisions,
-  aclOpts?: { ownerUserId?: string },
+  aclOpts: { actor: Actor },
 ): Promise<CommitSkillZipResponse> {
```

覆盖闸顺序（`existing !== null` 分支，`skill-zip.ts:235` 附近）：

```ts
if (existing !== null && existing.sourceKind === 'external') {
  // (1) 不变：external 真身在文件系统，zip 不可覆盖。
  outcome.failed.push({ name, code: 'skill-external-cannot-overwrite', message })
  continue
}
if (existing !== null && isOverwrite && !isResourceOwner(aclOpts.actor, existing)) {
  // (2) RFC-102 新：managed 但无写权限。
  outcome.failed.push({
    name, code: 'skill-overwrite-forbidden',
    message: `skill '${targetName}' is owned by another user; you cannot overwrite it (rename to import a copy)`,
  })
  continue
}
// (3) 现状不变：existing!==null && !isOverwrite → skill-rename-conflict；
//     existing===null && isOverwrite → skill-rename-conflict（无可覆盖）。
```

写盘成功后仍走既有 `commitSkillVersion`（RFC-101 单漏斗，覆盖即升版）；新建 `insertManagedRow(..., aclOpts.actor.user.id)`。

### 2.4 前端（`lib/skill-zip-import.ts` + `components/skills/ImportZipPanel.tsx`）

`availableActions` 四态（取代 `ImportZipPanel.tsx:294-298` 的三分支）：

| 候选状态 | 可选动作 | 初始决策 |
| --- | --- | --- |
| 无冲突 | `['import','skip']` | import |
| managed + canOverwrite | `['skip','overwrite','rename']` | skip |
| managed + !canOverwrite | `['skip','rename']`（**新**：禁用替换） | skip |
| external（canOverwrite=false） | `['skip','rename']`（**D4**：原仅 `['skip']`） | skip |

抽成纯函数供直测：

```ts
// lib/skill-zip-import.ts
export function availableActionsFor(c: SkillZipCandidateView): DecisionAction[] {
  if (c.conflict === undefined) return ['import', 'skip']
  if (c.conflict === 'managed' && c.canOverwrite === true) return ['skip', 'overwrite', 'rename']
  return ['skip', 'rename']
}
```

- `Select` 不再因 external 整列 `disabled`（现在恒 ≥2 项）。
- 冲突列：managed+!canOverwrite 显示「managed · 无权限替换」（新 i18n `skills.zipConflictManagedReadonly`）；其余不变。
- `initialDecisionFor`（`skill-zip-import.ts:26`）不变（有冲突→skip）。
- `validateRenameTarget` 不变（external/无权限行选 rename 时照常校验 kebab + 批内 + DB 撞名）。

---

## 3. Part B — Source 交互替换（轻量方案 D5）

### 3.1 端点契约（`routes/skill-sources.ts` + `shared/schemas/skill.ts`）

```
POST /api/skill-sources/:id/conflicts/replace
  body:  { name: SkillName }
  200:   { source: SkillSourceWithStats, replaced: string, imported: Skill }
  403:   forbidden                     (非 source registrar / admin；或对占用者无写权限)
  404:   skill-source-not-found
  422:   skill-source-conflict-stale   (name 在 source 目录里已不是有效 candidate)
```

新 schema：

```ts
export const ReplaceSourceConflictSchema = z.object({ name: SkillNameSchema })
export const ReplaceSourceConflictResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  replaced: z.string(),
  imported: SkillSchema,
})
```

`SkillSkipReport` **不变**——可替换性是 actor 相关的，不进持久化字段（前端实时推导，§3.3）。

### 3.2 服务 `replaceSourceConflict`（`services/skill-source.ts`）

```
replaceSourceConflict(db, fsOpts, actor, sourceId, name):
  1. source = 加载行；不存在 → NotFoundError('skill-source-not-found')
     （路由层已 requireSourceRegistrar）
  2. discovered = discoverSkillsInDir(source.path)
     若 name 不在 candidates → ValidationError('skill-source-conflict-stale')
  3. occupying = getSkill(db, name)
     若 null            → 占用已消失：reconcileSource(db, source) 后返回（幂等）
     若 sourceId===id   → 已归本 source（非冲突）：reconcileSource 后返回
  4. 权限闸：requireResourceOwner(db, actor, 'skill', occupying)   // 无权 → 403
  5. removeSkillRowAndFiles(db, fsOpts, occupying)                 // 删占用者，跳过引用检查
  6. reconcileSource(db, source)   // name 现无占用 → 作为 external 以 sourceId=id 导入
  7. imported = getSkill(db, name)；返回 { source: stats, replaced: name, imported }
```

**步骤 5 的关键点**：`deleteSkill`（`skill.ts:201`）在 skill 被 agent 引用时抛 `skill-in-use`。但「替换」保持 `name` 不变、引用按 name 解析、不破坏，故**不应**被引用检查拦。处理：抽 `deleteSkill` 的删除内核为

```ts
// services/skill.ts
export function removeSkillRowAndFiles(db, fsOpts, skill): void  // 删 DB 行 + managed 删 files/，无引用检查
```

`deleteSkill` = 引用检查 + `removeSkillRowAndFiles`；`replaceSourceConflict` 直接调内核。这是一次合理的 commonization（对齐 dedup-audit 精神）。

### 3.3 前端可替换性推导（`components/SkillSourcesCard.tsx`）

不新增端点、不泄漏 owner：`SkillSourcesCard` 已经能用 `useQuery(['skills'])` 拿到**当前用户可见**的 skills（含 `ownerUserId`）。对每个 `name-conflict-*` 冲突行：

```ts
const occupying = visibleSkills.find((s) => s.name === report.proposedName)
const canReplace =
  isAdmin ||                                            // admin 看得到所有、可替换
  (occupying !== undefined && occupying.ownerUserId === currentUserId)
```

- 占用者可见且属于我 / 我是 admin → `canReplace = true` → 显示可点「替换」按钮。
- 占用者可见但属于别人（public 他人 skill）→ `canReplace = false` → 按钮置灰。
- 占用者对我不可见（private 他人 skill，不在 `['skills']` 里）→ `canReplace = false` → 置灰。**天然正确**：不可见 ⟹ 非 owner ⟹ 无权替换，且不暴露其存在的 owner 身份。

当前用户 id / isAdmin 从 auth store 取（`stores/auth`，已有当前用户）。仅 `name-conflict-manual` / `name-conflict-source` 两类 reason 显示替换按钮；其余 skipped reason（no-skill-md 等）不显示。

替换按钮 → `POST /api/skill-sources/:id/conflicts/replace { name }`，成功后 `invalidateQueries(['skills'])` + `(['skill-sources'])`。后端 403 时 inline 显示「无权限替换」（复用现有 `describeError` / 错误条样式，置灰已基本挡住，403 是兜底）。

UI 一律走公共 class（`.btn .btn--xs`），冲突行替换按钮嵌在现有 `details > ul > li`（`SkillSourcesCard.tsx:81-85`）内，不新写 chrome。

### 3.4 reconcile 零改动

`reconcileSource` 的同名默认行为（跳过 + 记 `name-conflict-*`）**不动**。replace 是带外一次性提升：执行后占用者已删、source 重导入该 name → `skills.sourceId = id`，后续 reconcile 命中 `skill-source.ts:388` 的 `exist.sourceId === source.id` → accept+update 分支，稳定归属。归属即持久状态，无需额外 dismissal 表（D5）。

---

## 4. 耦合点

| 模块 | 关系 | 改动 |
| --- | --- | --- |
| `services/resourceAcl.ts` `isResourceOwner` / `requireResourceOwner` | 唯一判据，**只读复用** | 不改 |
| `services/skillVersion.ts` `commitSkillVersion` | ZIP overwrite 写盘后升版（RFC-101 既有漏斗） | 不改（既有路径自然走到） |
| `services/skill.ts` `deleteSkill` | Part B 替换删占用者需绕过引用检查 | 抽 `removeSkillRowAndFiles` 内核共用 |
| `services/skill-source.ts` `reconcileSource` / `discoverSkillsInDir` | Part B replace 复用 | 加 `replaceSourceConflict`，reconcile 本体不改 |
| `auth/actor.ts` `Actor` / `actorOf` | parse/commit/replace 都需 actor | parse 路由补传 actor |
| `stores/auth`（前端） | 取当前 user id / role 判 canReplace | 读现有状态 |

## 5. 失败模式

- **D8 同名存在性泄漏**：parse 用全表探测冲突，故「存在一个叫 X 的 skill」对所有用户可见——但这是 skill 名全局唯一的既有语义（`createManagedSkill` 撞名抛 `skill-name-in-use` 早已可探测），本 RFC **不新增**泄漏面，且 `canOverwrite` 对不可见者恒 false、**不暴露 owner 身份/内容**。若日后要求 per-user 命名空间，另起 RFC。
- **TOCTOU（parse↔commit）**：parse 给的 `canOverwrite` 仅供 UI 建议；commit 时重新 `getSkill` + 重新 `isResourceOwner` 裁决，以 commit 时为准。owner 在两步间变更不会导致越权。
- **被 agent 引用的占用者**：Part B 替换走 `removeSkillRowAndFiles`（跳过引用检查），保持 name → 引用不破坏。回归测试锁定。
- **占用者 replace 期间消失/改归属**：步骤 3 重查 `getSkill`，null 或已归本 source → 幂等 reconcile 返回，不报错。
- **external 占用者**：Part B 替换允许（requireResourceOwner 对 external 同样按 owner 判），归属从旧 source/manual 转到本 source；旧 source 下次 reconcile 视其为 `name-conflict-source` 跳过（对称）。Part A 中 external 作为**被 zip 覆盖**的对象仍禁止（`skill-external-cannot-overwrite`）——两者语义不同：Part B 是「用另一个 external 替换」，Part A 是「用 zip 内容覆盖 external 真身」。
- **绕过前端直调 API**：commit `skill-overwrite-forbidden` / replace 403 双重兜底，前端置灰仅 UX。

## 6. 测试策略（CLAUDE.md：随改动落地，必跑绿）

**shared**（`packages/shared` bun test）
- `SkillZipCandidateView` 解析带 `canOverwrite`；`skill-overwrite-forbidden` 在 failure 枚举内。

**backend**（`packages/backend` bun test）
- `computeConflictView` 纯函数四态：undefined→{}；external→{external,false}；managed+owner→{managed,true}；managed+otherUser→{managed,false}；managed+admin→{managed,true}。
- `parseSkillZipBuffer` 集成：四态候选的 view.canOverwrite 正确。
- `commitSkillZipBuffer` 权限闸：
  - 覆盖他人 managed → `skill-overwrite-forbidden`，磁盘 + DB 不变（owner 的内容未被动）。
  - 覆盖自己的 managed → created/updated 成功 + 升版。
  - admin 覆盖任意 managed → 成功。
  - 覆盖 external → `skill-external-cannot-overwrite`（回归，行为不变）。
  - 无权限行改名导入 → 新建成功（不被权限闸挡）。
- `replaceSourceConflict`：
  - registrar 替换自己有权的占用者 → 占用者删、source skill 以该 name 导入、`sourceId` 归位、`imported` 正确。
  - 替换无写权限的占用者 → 403。
  - 占用者被 agent 引用 → 仍替换成功（不被 `skill-in-use` 挡）—— **回归锁**，注释链 RFC-102。
  - 占用者已不存在 → 幂等（reconcile 后返回，不抛）。
  - name 非有效 candidate → 422 `skill-source-conflict-stale`。
  - 非 registrar/admin → 403（路由 `requireSourceRegistrar`）。
- `removeSkillRowAndFiles` 抽取后 `deleteSkill` 行为不回归（引用检查仍在）。

**frontend**（`packages/frontend` vitest）
- `availableActionsFor` 纯函数四态。
- `ImportZipPanel`：无权限 managed 行 `Select` 选项不含 overwrite、含 skip/rename；冲突列显示「无权限替换」。
- `SkillSourcesCard`：占用者属于我 → 替换按钮可点；属于别人/不可见 → 置灰；点击替换命中端点并 invalidate。
- canReplace 推导可抽纯函数 `canReplaceConflict(report, visibleSkills, currentUserId, isAdmin)` 直测。

**门禁**：`bun run typecheck && bun run test && bun run format:check` 全绿；push 后查 CI（feedback_post_commit_ci_check）；按 feedback_codex_review_after_changes 落码后跑 Codex review 修净。

## 7. PR 拆分

- **PR-A（修漏洞，先行）**：Part A 全部。shared 契约 → `computeConflictView` + parse/commit 后端闸 → 前端决策表四态 → 测试。可独立交付，立即堵住越权。
- **PR-B（Source 交互）**：Part B 全部。`removeSkillRowAndFiles` 抽取 → `replaceSourceConflict` + 路由 + schema → `SkillSourcesCard` 替换按钮 + canReplace → 测试。

A、B 无代码交集，强序仅为「先堵漏洞」；B 不依赖 A 的运行时产物。
