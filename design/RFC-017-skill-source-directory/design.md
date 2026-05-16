# RFC-017 Design — Skill 父目录批量纳管

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 修订基线：design/design.md §3（数据模型）+ §4.3（Skill 注入）+ §10（API）

## 1. 总体架构

```
┌─────────────────────┐    register / rescan
│ POST /api/skill-    ├────────────────────┐
│   sources           │                    ▼
└─────────────────────┘     ┌──────────────────────┐
                            │ services/skill-source│
┌─────────────────────┐     │ ─ discoverSkillsInDir│
│ GET  /api/skills    │     │ ─ reconcileSource    │
│  (lazy reconcile)   ├────►│ ─ enforceRefGuard    │
└─────────────────────┘     └─────┬────────────────┘
                                  │ upsert / delete
                                  ▼
                            ┌──────────────────────┐
                            │ skills 表 (含 sourceId)│
                            └──────────────────────┘
                                  ▲
                                  │ 现有 symlink staging 不变
                                  │
                            ┌──────────────────────┐
                            │ services/runner.ts   │ ← 零改动
                            └──────────────────────┘
```

设计哲学：**source-derived skill = external skill + sourceId tag**。runner、staging、agent 引用解析全部走现有 external 路径；本 RFC 只在 DB / service / HTTP / UI 上加一层"批量纳管 + lazy reconcile"。

## 2. 接口契约

### 2.1 新增 HTTP routes

| Method   | Path                              | Body / Query                                                              | 响应                                                                                                                  | 错误码                                                                                          |
| -------- | --------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST`   | `/api/skill-sources`              | `{ path: string, label?: string }`                                        | `201 { source: SkillSource, imported: Skill[], skipped: SkillSkipReport[] }`                                          | 400 `skill-source-path-missing` / `skill-source-path-not-dir` / 409 `skill-source-path-in-use`  |
| `GET`    | `/api/skill-sources`              | —                                                                         | `200 { sources: SkillSourceWithStats[] }`（stats: childCount, lastScanAt, lastScanError, skipped）                     | —                                                                                               |
| `PATCH`  | `/api/skill-sources/:id`          | `{ label?: string, enabled?: boolean }`                                   | `200 { source: SkillSourceWithStats }`（enabled 切换内部触发 reconcile）                                              | 404                                                                                             |
| `DELETE` | `/api/skill-sources/:id`          | —                                                                         | `204` 或 `400 skill-source-children-referenced` body `{ blockers: { skillName, byAgent }[] }`                         | 404 / 400                                                                                       |
| `POST`   | `/api/skill-sources/:id/rescan`   | —                                                                         | `200 { source: SkillSourceWithStats, imported: Skill[], deleted: string[], skipped: SkillSkipReport[] }`              | 404                                                                                             |

### 2.2 复用现有 `GET /api/skills`

逻辑改动：返回前对所有 `enabled=true` 的 source 跑 `reconcileSource`（详见 §4.1）。若某 source reconcile 抛错，整次列表请求**不失败**——异常被 `try/catch` 收纳并记录到该 source 的 `lastScanError`，列表照常返回当前 DB 快照。

不新增 query 参数（"返回是否带 source pill 信息"复用 `Skill.sourceId` 字段即可）。

### 2.3 Shared schemas（新增）

`packages/shared/src/schemas/skill.ts` 追加：

```ts
export const SkillSourceSchema = z.object({
  id: z.string(),
  path: z.string(),           // absolute, canonicalized (realpath)
  label: z.string(),          // defaults to basename(path)
  enabled: z.boolean(),
  lastScannedAt: z.number().int().nullable(),
  lastScanError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type SkillSource = z.infer<typeof SkillSourceSchema>

export const SkillSkipReportSchema = z.object({
  childPath: z.string(),
  proposedName: z.string().optional(), // present iff name conflict / regex fail
  reason: z.enum([
    'no-skill-md',
    'invalid-name',
    'name-conflict-manual',     // managed/external manual 占用
    'name-conflict-source',     // 另一 source 先占
    'frontmatter-parse-failed',
    'still-referenced',          // 用于 lazy 删守卫触发
  ]),
  detail: z.string().optional(),
})

export const SkillSourceWithStatsSchema = SkillSourceSchema.extend({
  childCount: z.number().int(),
  skipped: z.array(SkillSkipReportSchema),
})

export const CreateSkillSourceSchema = z.object({
  path: z.string().min(1),
  label: z.string().optional(),
})

export const UpdateSkillSourceSchema = z.object({
  label: z.string().optional(),
  enabled: z.boolean().optional(),
})
```

并在 `SkillSchema` 加一项可选字段 `sourceId: z.string().optional()`（managed / hand-imported external 时不携带；source-derived 携带）。

### 2.4 错误码新增（`packages/shared/src/errors.ts`）

| code                              | http | 触发                                                                |
| --------------------------------- | ---- | ------------------------------------------------------------------- |
| `skill-source-path-missing`       | 400  | path 不存在                                                          |
| `skill-source-path-not-dir`       | 400  | path 存在但不是目录                                                  |
| `skill-source-path-in-use`        | 409  | 同一规范化路径已登记                                                 |
| `skill-source-children-referenced`| 400  | 删 source 时 ≥ 1 子 skill 仍被 agent.skills 引用                     |
| `skill-source-readonly`           | 403  | 对 source-derived skill 尝试改 description / bodyMd / files          |

`describeApiError` zh-CN / en-US 两 bundle 同步加 5 条文案（按 RFC-001 后续约定，i18n 缺 key 时 fallback 到 `code: msg`，本 RFC 给齐）。

## 3. 数据模型

### 3.1 新表 `skill_sources`

```ts
export const skillSources = sqliteTable('skill_sources', {
  id: text('id').primaryKey(),                              // ULID
  path: text('path').notNull().unique(),                    // realpath() canonicalized absolute
  label: text('label').notNull(),                           // UI 显示用；默认 basename(path)
  enabled: integer('enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  lastScannedAt: integer('last_scanned_at'),                // unix ms; null = 未扫
  lastScanError: text('last_scan_error'),                   // 简短错误（如 ENOENT / EACCES）；详细 skipped JSON 不入库
  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
})
```

### 3.2 `skills` 表追加 `source_id` 列

```ts
// 在现有 skills 定义末尾追加：
sourceId: text('source_id').references(() => skillSources.id, { onDelete: 'set null' }),
```

`onDelete: 'set null'` 由 service 层在 cascade 删 source 时显式先把它带的 skills 行 delete 掉（见 §4.3）——`set null` 只是给"DB 文件层被外部工具改坏 / migration 半成态"兜底，正常运行不会留下"orphan source_id"行。

最新 `skipped` 列表 / `imported` 列表都不入库（每次 reconcile 重新生成），从前端拿到的是接口实时返回值；仅 source 表里以 `lastScanError`（≤ 512 字节文本）做"红点"指示。

### 3.3 Migration `0005_skill_sources.sql`

```sql
CREATE TABLE skill_sources (
  id TEXT PRIMARY KEY NOT NULL,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scanned_at INTEGER,
  last_scan_error TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

ALTER TABLE skills ADD COLUMN source_id TEXT REFERENCES skill_sources(id) ON DELETE SET NULL;
CREATE INDEX skills_source_id_idx ON skills(source_id);
```

Drizzle migration helper（启动时 idempotent apply）继续走 P-0-05 那套 `_journal.json` 流程。

## 4. 数据流

### 4.1 `reconcileSource(db, source)` 核心算法

```ts
async function reconcileSource(
  db: DbClient,
  source: SkillSourceRow,
): Promise<{ imported: Skill[]; deleted: string[]; skipped: SkillSkipReport[] }> {
  // 1) 列父目录
  let entries: Dirent[]
  try {
    entries = await readdir(source.path, { withFileTypes: true })
  } catch (e) {
    await db.update(skillSources).set({ lastScanError: errCode(e), lastScannedAt: Date.now() })
      .where(eq(skillSources.id, source.id))
    return { imported: [], deleted: [], skipped: [] }
  }

  // 2) 发现候选
  const candidates: { name: string; absPath: string; skillMdPath: string }[] = []
  const skipped: SkillSkipReport[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!SKILL_NAME_RE.test(e.name)) {
      skipped.push({ childPath: join(source.path, e.name), proposedName: e.name, reason: 'invalid-name' })
      continue
    }
    const skillMd = join(source.path, e.name, 'SKILL.md')
    if (!existsSync(skillMd)) {
      skipped.push({ childPath: join(source.path, e.name), reason: 'no-skill-md' })
      continue
    }
    candidates.push({ name: e.name, absPath: join(source.path, e.name), skillMdPath: skillMd })
  }

  // 3) 冲突过滤（与现存 skills 表对照）
  const existingByName = new Map(
    (await db.select().from(skills)).map((r) => [r.name, r]),
  )
  const accepted: typeof candidates = []
  for (const c of candidates) {
    const exist = existingByName.get(c.name)
    if (!exist) { accepted.push(c); continue }
    if (exist.sourceId === source.id) { accepted.push(c); continue } // 本 source 已纳管
    if (exist.sourceId == null) {
      skipped.push({ childPath: c.absPath, proposedName: c.name, reason: 'name-conflict-manual' })
      continue
    }
    skipped.push({ childPath: c.absPath, proposedName: c.name, reason: 'name-conflict-source' })
  }

  // 4) Diff 现有 source-derived skills vs accepted
  const wanted = new Set(accepted.map((c) => c.name))
  const owned = (await db.select().from(skills).where(eq(skills.sourceId, source.id)))

  const toDelete: SkillRow[] = []
  for (const r of owned) {
    if (wanted.has(r.name)) continue
    // 5) 引用守卫：被 agent 引用就不删
    if (await isReferencedByAgent(db, r.name)) {
      skipped.push({ childPath: r.externalPath ?? '', proposedName: r.name, reason: 'still-referenced' })
      continue
    }
    toDelete.push(r)
  }

  // 6) Upsert + delete in single tx
  const imported: Skill[] = []
  await db.transaction(async (tx) => {
    for (const c of accepted) {
      const content = parseSkillMd(c.skillMdPath) // 失败时记 skipped + continue
      if (!content.ok) {
        skipped.push({ childPath: c.absPath, reason: 'frontmatter-parse-failed', detail: content.error })
        continue
      }
      const existing = existingByName.get(c.name)
      if (existing && existing.sourceId === source.id) {
        await tx.update(skills).set({ description: content.description, externalPath: c.absPath, updatedAt: Date.now() })
          .where(eq(skills.id, existing.id))
      } else {
        await tx.insert(skills).values({
          id: ulid(),
          name: c.name,
          description: content.description,
          sourceKind: 'external',
          managedPath: null,
          externalPath: c.absPath,
          sourceId: source.id,
        })
      }
      imported.push(rowToSkill(await readSkillByName(tx, c.name)))
    }
    for (const r of toDelete) await tx.delete(skills).where(eq(skills.id, r.id))
    await tx.update(skillSources).set({
      lastScannedAt: Date.now(),
      lastScanError: skipped.length === 0 ? null : summarizeSkipped(skipped),
    }).where(eq(skillSources.id, source.id))
  })

  return { imported, deleted: toDelete.map((r) => r.name), skipped }
}
```

`discoverSkillsInDir(parentPath)` 抽出 #1 + #2 为纯函数，便于单测；`reconcileSource` 不抽离 transaction（与 DB 紧耦合）。

### 4.2 lazy 触发点

`services/skill.ts:listSkills` 改造：

```ts
export async function listSkills(db: DbClient): Promise<Skill[]> {
  const sources = await db.select().from(skillSources).where(eq(skillSources.enabled, true))
  for (const s of sources) {
    try { await reconcileSource(db, s) } catch (e) { /* 已被 reconcile 自身 catch；这里兜底 */ }
  }
  const rows = await db.select().from(skills)
  return rows.map(rowToSkill)
}
```

`bootstrapDaemon` 启动序列里在 migration 之后、HTTP 监听之前同样跑一次 `reconcileAllSources`。

### 4.3 source 删除级联

```ts
async function deleteSkillSource(db: DbClient, id: string) {
  const owned = await db.select().from(skills).where(eq(skills.sourceId, id))
  const blockers: { skillName: string; byAgent: string }[] = []
  for (const r of owned) {
    const ag = await firstAgentReferencing(db, r.name)
    if (ag) blockers.push({ skillName: r.name, byAgent: ag.name })
  }
  if (blockers.length > 0) {
    throw new ValidationError('skill-source-children-referenced', `${blockers.length} child skill(s) referenced`, { blockers })
  }
  await db.transaction(async (tx) => {
    await tx.delete(skills).where(eq(skills.sourceId, id))
    await tx.delete(skillSources).where(eq(skillSources.id, id))
  })
}
```

## 4.4 source-derived skill 写入守卫

`services/skill.ts` 现有三处写入（`updateSkill` / `updateSkillContent` / `writeSkillFile`）只检查 `sourceKind === 'external'`。本 RFC 把守卫扩到 "external **或** sourceId != null" 共用：

- `sourceKind === 'external' && sourceId == null` → 错误码沿用 `skill-external-readonly`。
- `sourceKind === 'external' && sourceId != null` → 错误码替换为 `skill-source-readonly`（让 UI 给出"请在 source 目录里改"的更明确提示）。

## 5. 与现有模块的耦合点

### 5.1 runner / runtime（零改动）

`services/runtime.ts:stageSkillsForRun(node, agentSkills, …)` 当前根据 `skill.sourceKind` 决定 copy（managed）vs symlink（external）。source-derived 行 `sourceKind='external'` + `externalPath` 已就位，走 symlink 分支即可。无需新增 sourceId 感知。

回归防护：源代码层断言 `services/runner.ts` / `services/runtime.ts` 不出现 `sourceId` / `skillSources` / `skill_source` 字面量（参 §6 C5）。

### 5.2 Agent CRUD（零改动）

`agent.skills: string[]` 仍按 skill name 引用。新建 / 编辑 agent 时 `/api/skills` 下拉里 source-derived 与 manual 同列、可选；只要 reconcile 已把它落 DB，引用解析就成立。

### 5.3 Workflow validator（零改动）

`workflow.validator.ts` 的 `skill-not-found` 规则在 agent 引用某 skill 但 DB 里没行时仍然按现有逻辑触发——lazy reconcile 在 GET 前刷新即可。validator 调用方（编辑器 / launcher）走 backend 路由，路由内调 reconcile，时序正确。

### 5.4 UI（前端）

新增组件：

- `components/SkillSourcesCard.tsx` —— `/skills` 列表页顶部组件；拉 `useQuery(['skill-sources'])`；行模板含 label + path + childCount + Rescan / Remove / 编辑按钮 + 红点状态。
- `routes/skills.new.tsx` 加 "Folder" tab —— form: `path` (TextInput) + `label` (TextInput, optional) + submit。
- `routes/skills.tsx` 列表行 —— 若 `sourceId` 非空，在 name 后渲染 `<SourcePill>`，hover tooltip 显示 source label + path；点击导航到 `/skills` 页且锚定到对应 source 卡片（用 `#source-{id}`）。
- 列表页头部状态 banner：上一次 lazy reconcile 出现 skipped 时显示 "{n} skill(s) skipped during scan" + "View details" 展开 skipped 报告。

i18n（zh-CN / en-US）新增 ~16 key：
`skills.sources.title / addFolder / pathLabel / labelLabel / rescan / remove / lastScanned / childCount / readonlySource / skippedBanner / skippedDetails / removeConfirmTitle / removeConfirmBlocked / pathInUseError / pathMissingError / pathNotDirError`

## 5.3 性能预算

- 单次 `reconcileSource`：父目录 readdir（< 5ms） + 每子目录 1 次 `existsSync(SKILL.md)`（< 0.5ms / 个） + 接受候选每个 `parseFrontmatter` (≤ 32KB → < 1ms / 个) + 1 次 select all skills（< 5ms / 50 行）+ 1 次 transaction（< 5ms）。
- 50 条 skill / 1 条 source → 总 ≤ 30ms；3 条 source → ≤ 90ms。GET /api/skills 现有 p99 < 50ms（DB select all），加上 lazy reconcile 后 p99 预算放宽到 < 200ms。
- v1.1 fallback（如线上观测超预算）：在 `skill_sources.lastScannedAt` 上做 5 秒 TTL —— GET 时如 `Date.now() - lastScannedAt < 5000` 跳过本次扫描，直接走 DB。v1 不实现，避免引入"看到的列表不实时"的认知负担。

## 5.4 路径规范化

`realpath` 解析 `~` / 软链 / 多余 `/`，结果做唯一约束。submit 时 service 层 fail-fast：
- 路径以 `~` 开头 → expand HOME。
- `realpath(path)` 抛 ENOENT → 400 `skill-source-path-missing`。
- `realpath` 成功但 `statSync(real).isDirectory()` false → 400 `skill-source-path-not-dir`。
- 标准化后 path 已在 `skill_sources.path` 命中 → 409 `skill-source-path-in-use`。

## 6. 测试策略

### Backend（≥ 18 case）

- `tests/skill-source-discover.test.ts`（6 case，纯函数）：
  - 直接子目录含 SKILL.md → accepted
  - 直接子目录不含 SKILL.md → skipped no-skill-md
  - 子目录名含大写 / 空格 → skipped invalid-name
  - 父目录里的文件（非目录）→ 忽略
  - 嵌套孙目录里的 SKILL.md → 不被识别（只看直接子目录）
  - SKILL.md frontmatter parse 失败 → skipped frontmatter-parse-failed
- `tests/skill-source-reconcile.test.ts`（6 case）：
  - 首次扫描 imports 全部合规子 skill
  - 第二次扫描在外部新增子目录后 imports 该新增项
  - 第二次扫描在外部删除子目录后 deletes 对应 skills 行
  - 同名冲突手动 manual 胜出 → skipped name-conflict-manual
  - 同名冲突先 source 胜出 → skipped name-conflict-source
  - 子 skill 被 agent.skills 引用时 reconcile 跳过删除 + skipped still-referenced
- `tests/skill-source-cascade-delete.test.ts`（3 case）：
  - 无引用：删 source + 级联删全部子 skill + skill_sources 行消失
  - 有引用：400 `skill-source-children-referenced` + body 列出 blockers
  - 删 source 后再次 GET /api/skills 不再返回该 source 带的子 skill
- `tests/skill-source-http.test.ts`（3 case）：
  - POST happy / 重复 path 409 / 路径不存在 400
- `tests/skills-list-lazy-scan.test.ts`（1 case）：
  - 注册 source 后在外部 mkdir 新子目录 + 写 SKILL.md → 下次 GET /api/skills 返回包含新条目（不需手动 rescan）

### Frontend（≥ 9 case）

- `tests/skill-sources-card.test.tsx`（4 case）：
  - 拉到 0 条 → 渲染空态
  - 拉到 2 条 → 渲染卡片 + label + childCount + lastScanned 相对时间
  - Rescan 按钮触发 POST + 卡片刷新
  - Remove 按钮：无阻塞确认 → DELETE 204 → 卡片消失；有阻塞 400 → 弹阻塞列表，行不消失
- `tests/skill-folder-tab.test.tsx`（3 case）：
  - `/skills/new` Folder tab 存在 + form 提交后跳 list 页 + banner 显示 imported / skipped 计数
  - path 不存在 → 400 文案
  - 路径已在用 → 409 文案
- `tests/skill-source-pill.test.tsx`（2 case）：
  - `sourceId != null` 的行渲染 pill；点击导航到 `/skills#source-{id}`
  - `sourceId == null` 的行不渲染 pill

### 源代码层兜底

- `tests/skill-source-runner-zero-touch.test.ts`（1 case）：fs 读 `services/runner.ts` + `services/runtime.ts`，断言 `"sourceId"` / `"skillSources"` / `"skill_source"` 字面量不出现。

### Playwright e2e（不扩）

本 RFC 不动 e2e 主流；CI 复用现有 main.spec 即可。

## 7. 失败模式与降级

| 场景                                | 行为                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Source 父目录被外部 unlink          | reconcile 抛 ENOENT → `lastScanError = 'path-missing'`；不删 owned skills（保护"外部目录可能临时挂载断开"场景）；UI 红点提示    |
| Source 父目录权限拒绝               | 同上，`lastScanError = 'permission-denied'`                                                                                     |
| SKILL.md 半态（外部正在写）          | parseFrontmatter 抛错 → skipped frontmatter-parse-failed；不影响其它候选；下次扫描自动恢复                                       |
| reconcile 中途数据库锁              | transaction 抛错被 `listSkills` 层 catch → 返当前快照，不阻断列表请求；下次扫描重试                                              |
| 同一 source 被并发两次 reconcile    | DB transaction 串行；后到的 upsert 看到已变化的 existingByName，分支正确处理                                                    |

## 8. 兼容性 / 回滚

- 现有 managed / external skill 行：`source_id IS NULL`，行为零变化。
- migration 0005 down：drop index → drop `skills.source_id` 列 → drop `skill_sources` 表。down 流程需要把 `source_id IS NOT NULL` 的 skills 行**也一并清掉**（否则 down 后 these rows 残留但语义错误），down SQL 在 ALTER 之前先 `DELETE FROM skills WHERE source_id IS NOT NULL`。
- 单 PR 落地 + `git revert` 整体回滚；如已落 source 行的用户回滚后会丢失 source 登记 + 该 source 带进来的子 skill 引用，agent 引用此前 source-derived skill 的会变成 skill-not-found——属预期回滚代价，README / CHANGELOG 写明。

## 9. Out of scope（再次明确）

- v1.1 候选：fs.watch 实时同步、5s TTL 缓存、glob 排除、SKILL.md frontmatter `name` 作为名字源、source-derived → managed 一键迁移。
- 这些都不在本 RFC PR 范围。如需任一项另开 RFC。
