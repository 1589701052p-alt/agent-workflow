# RFC-102 任务分解

## 依赖与顺序

```
PR-A（ZIP 写权限，修越权漏洞，先行）
  T1 shared 契约 → T2 后端 parse/commit 闸 → T3 前端决策表 → T4 测试
PR-B（Source 交互替换）
  T5 deleteSkill 内核抽取 → T6 replaceSourceConflict + 路由 + schema → T7 前端 → T8 测试
```

PR-A 与 PR-B 无代码交集；强序仅为「先堵漏洞」。每个 PR 内 T 顺序为编译依赖序。

---

## PR-A — ZIP 写权限

### RFC-102-T1 — shared 契约
- `schemas/skill.ts`：`SkillZipCandidateViewSchema += canOverwrite?: boolean`；`SkillZipCommitFailureCodeSchema += 'skill-overwrite-forbidden'`。
- 验收：`packages/shared` typecheck + 新增解析测试绿。

### RFC-102-T2 — 后端 parse / commit 闸（`services/skill-zip.ts` + `routes/skills.ts`）
- 加纯函数 `computeConflictView(actor, existing)`。
- `parseSkillZipBuffer` 加 `actor` 形参，用 `computeConflictView` 填 `conflict` + `canOverwrite`（`byName` 仍全表）。
- `routes/skills.ts` parse 端点传 `actorOf(c)`。
- `commitSkillZipBuffer` 的 `aclOpts` 改 `{ actor }`；覆盖闸序：external → `!isResourceOwner` 报 `skill-overwrite-forbidden` → 现状；新建 owner 取 `actor.user.id`；commit 端点传 `{ actor: actorOf(c) }`。
- 验收：backend typecheck；§6 parse/commit case 绿。

### RFC-102-T3 — 前端决策表（`lib/skill-zip-import.ts` + `components/skills/ImportZipPanel.tsx`）
- 纯函数 `availableActionsFor(candidate)` 四态；`CandidateRow` 改用它（取代 `:294-298`）。
- external/无权限 managed 不再整列 `disabled`；冲突列加「managed · 无权限替换」。
- i18n：`skills.zipConflictManagedReadonly`（en-US + zh-CN 对称）。
- 验收：frontend typecheck；`availableActionsFor` 纯函数测 + 面板渲染测绿。

### RFC-102-T4 — PR-A 测试汇总
- shared / backend / frontend 全部 §6·PR-A 相关 case；门禁三绿；Codex review；push 查 CI。

---

## PR-B — Source 交互替换

### RFC-102-T5 — `deleteSkill` 内核抽取（`services/skill.ts`）
- 抽 `removeSkillRowAndFiles(db, fsOpts, skill)`（删 DB 行 + managed 删 `files/`，**无引用检查**）。
- `deleteSkill` = 引用检查 + 调内核；行为不回归（既有 `skill-in-use` 测试仍绿）。
- 验收：backend typecheck + 既有 skill 删除测试绿 + 内核单测。

### RFC-102-T6 — `replaceSourceConflict` + 路由 + schema
- `schemas/skill.ts`：`ReplaceSourceConflictSchema` + `ReplaceSourceConflictResponseSchema`。
- `services/skill-source.ts`：`replaceSourceConflict(db, fsOpts, actor, sourceId, name)`（design §3.2 七步：discover 校验 → getSkill → `requireResourceOwner` → `removeSkillRowAndFiles` → `reconcileSource` → 返回）。
- `routes/skill-sources.ts`：`POST /:id/conflicts/replace`，先 `requireSourceRegistrar(actorOf(c), id)` 再调服务。
- 验收：backend typecheck；§6 replaceSourceConflict 全 case 绿（含「被引用仍可替换」回归锁、幂等、422、403）。

### RFC-102-T7 — 前端 Source 替换（`components/SkillSourcesCard.tsx`）
- 纯函数 `canReplaceConflict(report, visibleSkills, currentUserId, isAdmin)`。
- `name-conflict-*` 行加 `.btn .btn--xs` 替换按钮：`canReplace` 决定 disabled；点击 `POST /:id/conflicts/replace`，成功 invalidate `['skills']`+`['skill-sources']`，403 inline 错误。
- 复用现有 `details/ul/li` 结构与公共 class，不新写 chrome。
- 验收：frontend typecheck；canReplace 纯函数测 + 卡片渲染/点击测绿。

### RFC-102-T8 — PR-B 测试汇总
- §6·PR-B 全 case；门禁三绿；Codex review；push 查 CI。

---

## 总验收清单

- [ ] T1–T4（PR-A）：ZIP 越权漏洞堵死，无权限 UI 正确，后端兜底。
- [ ] T5–T8（PR-B）：Source 冲突可交互替换，权限正确，被引用占用者可替换。
- [ ] 两 PR 各自 `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] 各自 Codex review 通过、findings 修净（feedback_codex_review_after_changes）。
- [ ] push 后 CI 全绿（feedback_post_commit_ci_check）。
- [ ] `STATE.md` 完工后状态改 Done、加已完成行；`design/plan.md` RFC 索引状态更新。

## 非目标 / 后续增强（不在本 RFC）

- Source 冲突「跳过」决策持久化表（降噪）——当前不点替换即维持静默跳过，足够。
- ZIP `parse` 用 `canViewResource` 收紧同名存在性（per-user 命名空间）——需另起 RFC，改 skill 全局唯一语义。
- Source `GET /:id/conflicts` 专用 actor-aware 端点（更强预判 UX）——当前前端从 `['skills']` 推导已足。
