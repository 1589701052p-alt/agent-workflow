# RFC-102 技能导入同名冲突——可选替换 + 写权限校验

> 状态：Draft（落档待用户批准后进入实现）
> 触发：2026-06-23 用户「批量导入 skill 时发现同名，让用户选择是否替换；没有权限则该 skill 不允许替换」。

## 1. 背景

平台有**两条**批量导入 skill 的路径，它们对「同名 skill」的处理方式不一致，且都存在缺口：

### 1.1 ZIP 包批量导入（RFC-019）

两阶段：`parse`（预览，标记冲突）→ `commit`（按用户决策写盘）。决策表已支持 `跳过 / 替换(overwrite) / 改名(rename)`。

**缺口（越权漏洞）**：`commitSkillZipBuffer`（`services/skill-zip.ts:182`）覆盖一个 managed skill 时，**只判断 `sourceKind !== 'external'`，完全不校验当前用户对该 skill 是否有写权限**——直接 `rmSync` 旧 `files/` 目录重写（`skill-zip.ts:325-328`）。

对比正规的 skill 修改/删除路径（`PUT /api/skills/:name`、`DELETE`、`/content`、`/file`、`/versions/:v/restore`）**全部**先 `requireResourceOwner(db, actor, 'skill', existing)`（`routes/skills.ts:161/168/188/217/232/266`）。唯独 ZIP 覆盖旁路了这道闸。

后果：用户 B 上传一个含 `foo` 的 zip，只要 `foo` 是 managed，B 就能覆盖用户 A 拥有的 `foo`——违反 RFC-099 资源 ACL。`parse` 端点（`routes/skills.ts:103`）当前甚至不接收 `actor`，无法据权限给建议。

### 1.2 Source 目录扫描导入（RFC-017）

注册一个父目录，后台懒扫描（daemon boot + 每次 `GET /api/skills`）把直接子目录作为 external skill 导入。`reconcileSource`（`services/skill-source.ts:382-397`）对同名按优先级「手动导入 > 先注册 source > 后注册 source」**静默跳过**，记 `name-conflict-manual` / `name-conflict-source`，编码进 `lastScanError`，前端 `SkillSourcesCard.tsx:77-88` 折叠展示。

**缺口**：用户**无法主动选择「替换」**那个被占用的同名——只能先到先得地放弃。

### 1.3 共同根因

「能否替换一个已存在 skill」的唯一正确判据是 RFC-099 的写权限 `isResourceOwner(actor, skill)`（owner 或 admin，`services/resourceAcl.ts:140-143`）。两条导入路径都**没有复用**这个公共原语：ZIP 路径自写了 `sourceKind === 'external'` 的近似判断，Source 路径根本不暴露替换能力。这正是 `design/dedup-audit-2026-06-13.md` 记录的「公共原语被绕过、各写一份」缝隙之一。

## 2. 目标

1. **ZIP 导入**：覆盖同名 skill 前校验写权限。
   - 有权限（owner/admin，且是 managed）→ 可「替换」。
   - 无权限 → 该行禁用「替换」，仅允许「跳过 / 改名新建」。
   - 后端**独立兜底**：直接调 API 绕过前端禁用时，覆盖无权限返回失败 `skill-overwrite-forbidden`（不只靠前端置灰）。
2. **Source 导入**：在 Source 管理卡的同名冲突行提供「替换」操作。
   - 有权限（对被占用 skill 是 owner/admin）→ 可替换：删占用者、把 source 版本导入为该 name。
   - 无权限 → 禁用「替换」（前端置灰 + 后端 403 兜底）。
3. **统一判据**：两条路径的「能否替换」都走 `isResourceOwner`，复用 RFC-099 单一事实源。

## 3. 非目标

- 不改 skill 名**全局唯一**语义。撞名探测存在性是既有现状（`createManagedSkill` 撞名抛 `skill-name-in-use`，`skill.ts:91`），本 RFC 不收紧也不放大（见 design §失败模式 D8）。
- 不引入「跳过决策」的持久化表。Source 的「不替换」= 维持现状静默跳过，不点替换按钮即可（轻量方案，零 migration）。
- 不改 external skill「真身在文件系统、不可被 zip 覆盖」的技术约束（`skill-external-cannot-overwrite` 保留）。
- 不改 zip 包**内部**自带同名目录的处理（仍在 parse 阶段直接 `skill-name-duplicated-in-zip` 拒绝，`shared/skill-zip.ts:163-186`）。
- 不改 `reconcileSource` 的默认行为（同名仍默认跳过；替换是带外的一次性用户操作）。

## 4. 用户故事

- **US-1**（ZIP，有权限）：我是 `foo` 的 owner。上传含 `foo` 的 zip，决策表该行冲突标「managed」，可选「替换」；选替换 → 导入成功、`foo` 内容更新、升一版（走既有 `commitSkillVersion`）。
- **US-2**（ZIP，无权限）：`foo` 是别人的。上传含 `foo` 的 zip，该行标「managed · 无权限替换」，「替换」选项不出现；我可「跳过」或「改名为 `foo-mine` 新建」。若我伪造请求直接 `overwrite`，后端返回 `skill-overwrite-forbidden`。
- **US-3**（ZIP，admin）：管理员可替换任意 managed 同名。
- **US-4**（ZIP，external 冲突）：同名是 external skill，不可替换（技术约束），但我可「改名新建」或「跳过」。
- **US-5**（Source，有权限）：我注册的 source 目录里有 `bar`，但 DB 里已有我自己的 `bar`。Source 卡冲突行显示「替换」按钮；点击 → 旧 `bar` 被 source 版本取代（归属转为该 source）。
- **US-6**（Source，无权限）：占用 `bar` 的是别人的 skill。「替换」按钮置灰（或点击后 403）；我无法替换。

## 5. 验收标准

- [ ] ZIP `parse` 响应每个冲突候选带 `canOverwrite`（actor 相关）；external 恒 false。
- [ ] ZIP `commit` 覆盖他人 managed → `skill-overwrite-forbidden`；覆盖自己的/admin → 成功；external → `skill-external-cannot-overwrite`（不变）。
- [ ] ZIP 前端决策表：无权限 managed 行与 external 行均为 `['skip','rename']`；有权限 managed 为 `['skip','overwrite','rename']`；无冲突 `['import','skip']`。
- [ ] Source `POST /:id/conflicts/replace`：有权替换成功（占用者删除 + source 版本以该 name 导入 + `sourceId` 归位）；无权 403；占用者已不存在则幂等；name 非有效 candidate → 422；非 registrar → 403。
- [ ] Source 前端冲突行：有权显示可点「替换」，无权置灰；替换后 invalidate `['skills']` + `['skill-sources']`。
- [ ] 全部新增/改动带测试（见 design §测试策略）；`bun run typecheck && bun run test && bun run format:check` 全绿；Codex review 通过；CI 绿。

## 6. 决策登记

| 编号 | 决策 | 取值 | 来源 |
| ---- | ---- | ---- | ---- |
| D1 | 范围：哪条导入路径 | **两条都做**（ZIP 补权限 + Source 加交互替换） | 用户已答 |
| D2 | 无权限时 UI 行为 | **禁用替换，但可改名新建** | 用户已答 |
| D3 | 「权限」定义 | RFC-099 写权限 `isResourceOwner`（owner 或 admin） | 建议默认 |
| D4 | ZIP external 冲突可选动作 | 由「只 skip」改为 **`skip + rename`**（与无权限 managed 统一为「不可替换但可改名」） | 建议默认·待确认 |
| D5 | Source 替换实现方案 | **轻量**：`replace` 端点 + reconcile，归属靠现有 `skills.sourceId`，**零新表零 migration**；「跳过」= 不操作 | 建议默认·待确认 |
| D6 | 后端独立权限闸 | ZIP commit 越权 → `skill-overwrite-forbidden`；Source replace 越权 → 403 `forbidden`。前端置灰仅 UX | 安全必须 |
| D7 | PR 拆分 | **PR-A**（ZIP 权限，修漏洞，先行）→ **PR-B**（Source 交互替换），强序 | 建议默认·待确认 |
| D8 | 同名存在性 | parse 沿用全表冲突探测；同名存在性对所有用户可见（与现有 skill 全局唯一命名一致），但 **owner 身份与 private 内容不泄漏**，`canOverwrite` 对不可见者恒 false | 已知限制 |

> D4 / D5 / D7 在 `ExitPlanMode` 时复述给用户确认；其余为安全/一致性默认。
