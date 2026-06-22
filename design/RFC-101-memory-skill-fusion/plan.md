# RFC-101 记忆→技能融合 — plan（任务分解）

> 子任务编号 `RFC-101-T*`。强序：**PR-A（版本化地基）→ PR-B（融合引擎）→ PR-C（UI + 入口）**。
> 每个 PR 自带测试（CLAUDE.md test-with-every-change）；push 后立刻查 CI（feedback_post_commit_ci_check），push 前 `bun run typecheck && bun run test && bun run format:check` + `bun run build:binary` smoke。

## PR-A — 通用技能版本化（能力 A，地基，可独立上库）

依赖：无。交付后技能即获版本/历史/对比/回退，本身有独立价值。

- **T-A1 schema + 迁移**：`skills.content_version` 加列；新建 `skill_versions` 表（§2.1/2.2）；迁移含**既有技能 v1 回填**（磁盘 `versions/v1/files` + 行）。迁移测试（加列、建表、回填、幂等）。
- **T-A2 `services/skillVersion.ts`**：`commitSkillVersion`（落盘→DB 事务→sync live 定序 + `contentHash` 空写短路）、`reconcileSkillLiveFiles`（启动期对账）、`listSkillVersions`/`getSkillVersionContent`/`diffSkillVersions`/`restoreSkillVersion`。纯函数预言：`skillVersionRelativePath`、`memoriesToUnfuseOnRestore`（解融合选择，先建好供 PR-B 复用）。
- **T-A3 写路径漏斗化**：`createManagedSkill`/`writeSkillContent`/`writeSkillFile`/`deleteSkillFile`（`services/skill.ts`）全部改走 `commitSkillVersion`；`updateSkill`（仅 description）不升版。**源码文本断言**锁"SKILL.md 写入唯一漏斗"。
- **T-A4 API + WS**：`GET versions` / `GET versions/:v/content` / `GET versions/diff` / `POST versions/:v/restore`（`routes/skills.ts`）；WS `skill.version.created`/`skill.restored`（复用或新建技能频道，定接入）。
- **T-A5 前端历史 UI**：`/skills/:name` 加"版本"区——历史列表（version/source/author/date/summary + StatusChip）、对比任意两版（**复用 DiffViewer** 多文件）、回退（确认 Dialog；此阶段回退仅技能内容，解融合在 PR-B 接线）。i18n en+zh。复用 Dialog/Form/EmptyState/LoadingState，**禁止**自写 chrome。
- **T-A6 回归**：既有技能编辑器测试更新（Save 后 version+1 + 历史行）；external 技能无版本区。

**PR-A 验收**：迁移后既有技能有 v1 历史；编辑器 Save 升版+存档；历史/对比/回退可用且非破坏性；三门禁 + binary smoke + e2e 绿。

## PR-B — 融合引擎（能力 B 后端）

依赖：PR-A（apply 复用 `commitSkillVersion`；回退解融合复用 `memoriesToUnfuseOnRestore`）。

- **T-B0 系统资源播种**（先验证 OQ-2）：内置 `__skill_merger__` agent（body 内嵌写作规范 §6，readonly:false，outputs=changelog/incorporated/skipped）+ `__skill_fusion__` workflow（git-wrapper[skill-merger + self-clarify, RFC-100 mandatory]）；daemon 启动幂等 upsert。
- **T-B1 临时仓播种**（先验证 OQ-1）：`seedFusionWorktree(skill)` → 拷 files/ + `git init` + baseline commit；`createFusion` 经 `preCreatedWorktree` 启动引擎任务（必要时 `repoPath=fusionWorkDir`）。真实 git 集成测试。
- **T-B2 memories `fused` 迁移 + 转移**：整表重建迁移（模板 0035）加 `fused` + 溯源列 + CHECK；`fuseMemories`/`unfuseMemories`（memory.ts，复用 `transitionStatus` 守卫，终态不可 promote/edit）；状态机红/绿测试 + 迁移测试。**源码文本断言** memoryInject 永不取 fused。
- **T-B3 `services/fusion.ts`**：`fusions` 表迁移；`createFusion`（ACL D13/D14 校验 → 播种 → 启动）；`onEngineTaskSettled` 钩子（done→awaiting_approval + 校验 incorporated⊆selected；终态→failed）；`applyFusion`（OCC + `commitSkillVersion(source=fusion)` 同事务 `fuseMemories`）；`rejectFusion`（iteration++ 由上版 proposed 播种 + feedback 注入）；`cancelFusion`；`fusionTransition` 纯函数守卫。
- **T-B4 routes/fusions.ts + WS + shared schema**：`/api/fusions*` 路由；`fusion.*` WS；shared `schemas/fusion.ts` + memory/skill schema 增字段；ACL 谓词 `canLaunchFusion`/`canApproveFusion`/`canFuseMemory`。
- **T-B5 后端测试**：端到端融合（mock runner）、退回迭代、apply 原子性（升版+fused 同事务）、OCC 冲突、记忆中途失效跳过、prompt 隔离源码断言。

**PR-B 验收**：可经 API 跑完"发起→反问→产出→批准→升版+记忆 fused"全链路；退回迭代、OCC、失败回滚均正确；门禁全绿。

## PR-C — 融合 UI + 双入口

依赖：PR-B。

- **T-C1 `/memory` 多选 + 入口**：approved 列表加多选；选 ≥1 条（且可管理）后出"融合到技能…"动作 → 发起 Dialog（**Select** 选 managed 技能 + 意图 TextArea + 可选 model override）。不可管理记忆在 picker 标注/禁选（D14）。
- **T-C2 `/skills/:name` 入口**：在版本区旁加"融合记忆…"按钮 → Dialog 多选 approved 记忆（搜索/ChipsInput 风格）+ 意图 → 发起。
- **T-C3 融合详情视图**（`/fusions/:id` 或任务详情内嵌）：状态 + 进行中给 `/clarify` 链接；`awaiting_approval` 给批准面板——**当前 vs proposed 多文件 diff（DiffViewer）** + changelog + 已吸收/跳过记忆清单 + [批准]/[退回并反馈（反馈 TextArea）]/[取消]。
- **T-C4 fused 呈现 + 回退解融合接线**：`/memory` 显示 `fused → {skill} v{n}` chip + 溯源；PR-A 回退 UI 接 `memoriesToUnfuseOnRestore` dry-run，事前列出"将解融合 X 条"。
- **T-C5 i18n + e2e**：全部新串 en+zh；Playwright：发起→反问→批准→升版；回退→解融合。视觉对齐自查（对照 /agents、/skills、/memory）。

**PR-C 验收**：双入口可发起；反问经既有 UI；前后 diff 批准/退回闭环；fused chip + 回退解融合提示正确；门禁 + e2e 绿。

> 拆分备注：PR-B 偏大，必要时再拆 B-data（T-B2/B3/B4 数据与服务）+ B-engine（T-B0/B1/B5 引擎接线与测试）。

## 估算（粗略）

| PR | 范围 | 估算 |
|----|------|------|
| PR-A | 版本化地基 + 历史/对比/回退 UI | 4–6 工作日 |
| PR-B | 融合引擎（含两张迁移 + 系统资源 + ACL） | 6–9 工作日 |
| PR-C | 双入口 + 融合详情/批准 UI + e2e | 4–6 工作日 |

## 总验收清单

- [ ] 既有技能迁移后有 v1 历史；编辑器 Save 升版+存档（PR-A）
- [ ] 历史列表 / 两版对比 / 一键回退（非破坏性）可用（PR-A）
- [ ] `/memory` 与 `/skills/:name` 双入口可发起融合（PR-C）
- [ ] skill-merger 强制 ≥1 轮反问，经既有 `/clarify` 回答（PR-B/RFC-100）
- [ ] 融合产出以当前 vs proposed 多文件 diff 呈现，含 changelog + 已吸收/跳过（PR-C）
- [ ] 批准 → 技能升版（source=fusion）+ 旧版进历史 + 已吸收记忆转 fused + 跳过记忆仍 approved，全原子（PR-B）
- [ ] 退回并反馈 → 基于上版 proposed 重跑、可再反问（PR-B/C）
- [ ] fused 记忆不再注入（byte-equal 不变）+ `/memory` chip 溯源（PR-B/C）
- [ ] 回退跨融合版按 D10 解融合，UI 事前列出（PR-A 接线 + PR-C）
- [ ] OCC 兜住并发融合/编辑/回退冲突（PR-B）
- [ ] prompt 隔离：融合归属绝不进 agent 上下文（源码断言，PR-B）
- [ ] 三门禁 + binary smoke + e2e 全绿；每改动带测试

## 落档登记

- `design/plan.md` RFC 索引加 RFC-101 行（状态 Draft→In Progress→Done）。
- `STATE.md` 顶部加"进行中 RFC：RFC-101"一行；完工后转 Done 并入已完成表。
