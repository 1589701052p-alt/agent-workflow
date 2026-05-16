# RFC-017 Plan — Skill 父目录批量纳管：任务分解

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 拆分建议：**单 PR**（参考 RFC-011 / RFC-013 的"shared + backend + frontend + 测试"打包模式）。任务级别仍按下列编号拆，便于 commit 内分块。

## 任务表

| 编号       | 标题                                    | 依赖     | 估时 | 描述                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC-017-T1 | shared schemas + 错误码 + i18n key     | —        | S    | `packages/shared/src/schemas/skill.ts` 追加 `SkillSourceSchema` / `SkillSkipReportSchema` / `SkillSourceWithStatsSchema` / `CreateSkillSourceSchema` / `UpdateSkillSourceSchema`；`SkillSchema` 增 optional `sourceId`。`errors.ts` 加 5 条新错误码 + 文案 fallback；i18n zh-CN / en-US 各加 16 key（design.md §5.4）。 |
| RFC-017-T2 | DB schema + migration 0005             | T1       | S    | `packages/backend/src/db/schema.ts` 新增 `skillSources` 表 + `skills.sourceId` 列；`bun run drizzle-kit generate` 出 `0004_*` 已被 RFC-014 占用，本 RFC 取下一个序号 `0005_skill_sources.sql`；启动 migration helper 自动 apply；同时落 `tests/migration-0005.test.ts` 验证升降级 idempotent。 |
| RFC-017-T3 | discoverSkillsInDir 纯函数 + 单测       | T1       | S    | `services/skill-source.ts` 暴露 `discoverSkillsInDir(parentPath): { candidates, skipped }`。单测 6 case（design.md §6 backend / discover）。                                                                                                                       |
| RFC-017-T4 | reconcileSource + 引用守卫 + 单测       | T2, T3   | M    | 同文件加 `reconcileSource(db, source)` / `isReferencedByAgent` / `firstAgentReferencing`。单测 6 case（reconcile 三态 + 冲突两类 + 守卫）。                                                                                                                        |
| RFC-017-T5 | HTTP routes + 单测                      | T4       | S    | `routes/skill-sources.ts`：POST / GET / PATCH / DELETE / POST :id/rescan。`routes.ts` 总线挂载。`tests/skill-source-http.test.ts` 3 case + `tests/skill-source-cascade-delete.test.ts` 3 case。                                                                  |
| RFC-017-T6 | listSkills lazy reconcile + 单测        | T4       | S    | `services/skill.ts:listSkills` 头部对 enabled sources 跑 reconcileSource（吞错）；boot 序列加 `reconcileAllSources()`；`tests/skills-list-lazy-scan.test.ts` 1 case 验证外部新增能被 lazy 拾到。                                                                  |
| RFC-017-T7 | source-derived skill 写守卫扩展         | T4       | S    | `updateSkill` / `updateSkillContent` / `writeSkillFile` 三处 `sourceKind === 'external'` 检查扩为"external 或 sourceId != null"；source-derived 用 `skill-source-readonly`，原 external 仍 `skill-external-readonly`。补 2 case 单测。                              |
| RFC-017-T8 | 前端 SkillSourcesCard + Folder tab + pill | T5       | M    | `components/SkillSourcesCard.tsx` + `routes/skills.tsx` 列表头部挂载 + `routes/skills.new.tsx` Folder tab + `routes/skills.tsx` skill 行 `<SourcePill>`。`tests/skill-sources-card.test.tsx` 4 + `skill-folder-tab.test.tsx` 3 + `skill-source-pill.test.tsx` 2。 |
| RFC-017-T9 | 源代码层兜底 + STATE.md / plan.md 更新  | T6, T8   | S    | `tests/skill-source-runner-zero-touch.test.ts` 1 case；`design/plan.md` RFC 索引 RFC-017 状态 Draft → In Progress → Done；`STATE.md` 已完成 issue 表追加一行。                                                                                                     |

依赖图：

```
T1 ──┬─► T2 ──► T6
     ├─► T3 ──► T4 ──┬─► T5 ──► T8
     │              ├─► T6
     │              └─► T7
     └─► T8
                       ↓
                       T9
```

## PR 拆分

默认**单 PR**：

```
feat(skills): RFC-017 父目录批量纳管 skill source
- shared schemas + 5 错误码 + 16 i18n key (T1)
- migration 0005_skill_sources + drizzle schema (T2)
- services/skill-source.ts discoverSkillsInDir + reconcileSource + 守卫 (T3 T4)
- POST/GET/PATCH/DELETE/rescan routes (T5)
- listSkills lazy reconcile + boot reconcileAllSources (T6)
- source-derived skill 写守卫错误码 (T7)
- 前端 SkillSourcesCard / Folder tab / SourcePill (T8)
- 测试 +27 + 源码层兜底 + STATE.md / plan.md (T9)
```

如评审反馈拆分诉求强烈，可拆为：
- **PR-1**（T1–T7）：纯后端 + shared，提供 API；前端列表行 sourceId pill 临时硬隐藏。
- **PR-2**（T8）：前端 UI。

但本 RFC 默认走单 PR，PR-1 / PR-2 形态只在评审要求时启用。

## 验收清单（merge 前必过）

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] `bun run drizzle-kit generate` 不再产新 diff（migration 0005 已落入 `meta/_journal.json`）。
- [ ] 启动 daemon → `~/.agent-workflow/db.sqlite` 中 `skill_sources` 表创建、`skills.source_id` 列存在。
- [ ] curl 验证：
  - [ ] `POST /api/skill-sources { path: <dir>, label: 'demo' }` → 201 + imported 列表。
  - [ ] 在该 dir 外部 mkdir 一个新子 skill + 写 SKILL.md → `GET /api/skills` 返回包含新条目。
  - [ ] 外部删除一个子 skill → `GET /api/skills` 不再返该条；如有 agent 引用，`GET /api/skill-sources` 卡片显示 `lastScanError`。
  - [ ] `DELETE /api/skill-sources/:id` 在无引用时 204、有引用时 400 + blockers。
- [ ] 浏览器实测 `/skills` 顶部 Source folders 区段渲染、Folder tab 表单提交、列表行 SourcePill 出现/不出现按 sourceId 一致。
- [ ] 跑一条 agent.skills 引用 source-derived skill 的 task → opencode 子进程 staging 目录里 symlink 指向外部目录 + skill 正常加载。
- [ ] `tests/skill-source-runner-zero-touch.test.ts` 红 = 实现违背"runner 零改动"约束。
- [ ] CI 完整跑通（含 typecheck / test / format / 单二进制 build smoke / e2e）。
- [ ] `STATE.md` 顶部 "进行中 RFC" RFC-017 在 PR 合并后 → "已完成"行。
- [ ] `design/plan.md` RFC 索引 RFC-017 状态 → Done。

## 风险登记（落 PR 描述）

- 若线上观测 lazy 扫描拖慢 `GET /api/skills` p99 → 走 design.md §5.3 兜底方案（5s TTL）；属 v1.1 增量，不阻塞本 RFC。
- 若用户外部 source 目录在 NFS / 慢盘 → 同上。
- migration 0005 down 删 source-derived skill 行属预期回滚代价，CHANGELOG / README 同步说明。
