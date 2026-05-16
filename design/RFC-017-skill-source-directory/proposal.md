# RFC-017 Proposal — Skill 父目录批量纳管：一次登记，自动跟随增删

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：design/proposal.md §3.2（Skill 管理）+ design/design.md §3（skills 表）+ §4.3（Skill 运行期注入）

## 1. 背景

当前 skill 只有两种来源：

- **managed** —— `~/.agent-workflow/skills/{name}/files/` 由平台拥有，UI 写。
- **external** —— 用户给一条具体 skill 目录的绝对路径（如 `~/.claude/skills/code-reviewer`），平台 symlink 到 per-run staging，文件内容编辑后**单条 skill 内的变化是实时透传的**（symlink 路径不变）。

但 external 一次只登记**一条具体 skill**。用户常见诉求是：手里有 `~/.claude/skills/`、`~/work/team-skills/` 这类目录，里面已经维护了十几条 skill，希望"指一下父目录"就把里面所有 skill 都拉进来用；以后那个目录新加 / 删除 skill，平台也能自动跟上，**不要让我每多 / 少一条都来 UI 手动 import 一次**。

如果不解决，用户每加一条 skill 就要打开 `/skills/new` → External tab → 复制粘贴路径 → 输 name → 描述。十几条 skill 等于十几次手工录入；并且后续他在外部把某条 skill 重命名 / 删掉，平台的 skills 表会留下指向"已不存在路径"的脏行，agent 引用时运行期才报 `skill-not-found`。

### 1.1 为什么要现在做

- M1–M5 已全部 Done（81/81 issue 关闭），近期 RFC 主要在 review / canvas / markdown 渲染等前端方向（RFC-007 / 010 / 013 / 014 / 016 等），skills 管线本身从 P-1-17 落地后只有零星修补，是补齐"批量纳管"能力的好窗口。
- 改动面集中在 **backend service + 一条 migration + 列表页一块小 UI**，runner / staging / agent 引用解析全部零改动（见 §1.2）。回滚成本低。
- 与并行 RFC 完全正交（review / canvas / markdown / wrapper UX 都不沾 skills 数据流），不会与任何 in-flight 分支撞车。

### 1.2 本 RFC 不动哪些地方

- **不动** `services/runner.ts` / `services/runtime.ts` 对 skill 的 per-run staging 逻辑——源目录纳管进来的子 skill 仍以 `sourceKind='external'` + `externalPath` 落 DB，runner 用现有 symlink 路径就能跑。
- **不动** `WorkflowDefinition` / `Agent.skills` 字段——agent 仍按 skill **name** 引用，不感知"这条 skill 来自手动 import 还是某父目录扫出来的"。
- **不动** 单条 external skill 现有的"只读 + 文件内容编辑实时透传"语义；本 RFC 引入的"父目录扫出来的"子 skill 共享同一只读约束（详见 design.md §4）。
- **不动** YAML workflow 导入导出格式。
- **不动** managed skill 的 UI 编辑路径（`/skills/:name` description + body + 文件树编辑）。

## 2. 目标

### 2.1 做

1. **新增"skill 父目录"概念**（下称 **skill source**）。
   - 用户在 UI 给一条父目录绝对路径 + 可选 label（默认取末段目录名）。
   - 平台落一条 `skill_sources` 行（详见 design.md §3.1），并对该目录做一次首次扫描：
     - 父目录直接子项里**每个含 `SKILL.md` 的子目录** = 一条 skill；子目录名即 skill name（必须匹配 `SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/`，否则跳过 + warning）。
     - 扫到的每条子 skill upsert 进现有 `skills` 表，`sourceKind='external'`、`externalPath = {parent}/{child}/`、`sourceId = {skill_source.id}`。**不递归更深层**——只看直接子目录，避免树状目录被意外纳管。
2. **后续"实时跟随"采用 lazy 扫描**（启动 + GET /api/skills 时各重扫一次）。
   - daemon 启动钩子里对每条 `skill_sources` 跑一次 reconcile（新增 → upsert，磁盘消失 → 删 skills 行）。
   - 每次 `GET /api/skills` 在返回前，对**已启用**的 `skill_sources` 重做一次同样的 reconcile。读自身磁盘是廉价 syscall（O(子目录数) 次 `readdir` + 每条子 skill 一次 `stat SKILL.md`），50 条 skill 量级不会成为瓶颈。
   - **不上 fs.watch / chokidar**（见 §2.2）。
3. **冲突解决规则**（按优先级降序）：
   - 手动登记的 managed / external skill **永远胜出**——同名情况下源目录扫到的同名子目录被丢弃，记 warning（落 `lastScanError`，UI 红点提示）。
   - 两条 source 扫到同名 skill —— 先登记的 source 胜出，后登记的丢弃，记 warning。
   - 子目录名不符合 `SKILL_NAME_RE` —— 跳过，记 warning。
   - 子目录没有 `SKILL.md` —— 静默忽略（视作普通文件夹，不算 skill）。
4. **删除 / 禁用 source**。
   - `DELETE /api/skill-sources/:id`：从 `skills` 表级联删它带进来的所有 skill 行；级联前与现有"agent.skills 引用了这条 skill 时不允许删"的守卫复用——只要任一被该 source 带进来的子 skill 仍被任何 agent 引用，整条 source 删除拒绝 + 列出阻塞引用，让用户先解绑或迁移。
   - source 可 `enabled=false` 暂停：reconcile 时把它带的子 skill 视作"应删除"。再次启用时 reconcile 把存在的子目录拉回来。
5. **手动 rescan 入口**。
   - `POST /api/skill-sources/:id/rescan` —— 用户偏好"我刚改完外部目录、不想等下次列表请求"时可用。UI 在 source 卡片上提供按钮。
6. **UI**：
   - `/skills` 页顶部新增"Source folders"区段：列出已登记 source（path + label + 子 skill 计数 + 最后扫描时间 + 状态 chip + Rescan / Remove 按钮）。
   - 列表里的 skill 行：若 `sourceId` 存在，name 旁多一颗小 pill「from {source.label}」+ 点击跳到该 source 卡片。
   - 新建入口：`/skills/new` External tab 旁追加 "Folder" tab——表单含 path + label，提交后跳回 `/skills` 列表，顶部显示成功 banner + 列出本次扫到的子 skill / 冲突。
7. **错误码新增**：`skill-source-path-missing` / `skill-source-path-not-dir` / `skill-source-path-in-use` / `skill-source-children-referenced` / `skill-source-readonly`（后者在用户对 source-derived skill 尝试改 description / body 时回，与现有 `skill-external-readonly` 区分以便提示文案更精确）。

### 2.2 不做

- **不做** fs.watch / chokidar 主动监听。lazy 已经覆盖用户"打开 skills 列表 / 创 agent 时下拉 skills"等所有进入点；主动 watch 引入跨平台差异（macOS FSEvents / Linux inotify）、watch handle 生命周期 / daemon 重启重订阅、被 watch 的目录在 IDE 里被批量改名时的事件风暴等额外复杂度，与"夹一下父目录"的诉求相比性价比不高。如未来用户在 `/tasks/:id` 跑任务途中改外部 skill 文件想见生效，可走 §2.1 #5 的手动 rescan。
- **不做** source-derived skill 在 UI 内编辑——保持与单条 external 同语义"外部目录请自行用编辑器改文件"。
- **不做** 递归扫描深层目录。只识别 source 父目录的**直接子目录**为 skill 候选；如果用户想纳管嵌套结构里某一层，可以分别登记两条 source。
- **不做** glob / 排除规则。v1 不接受 `excludes: ['archive/**']` 这类配置；用户想排除请改子目录名前加 `_` 或把它移走。
- **不做** "managed source folder"——本 RFC 仅对外部目录批量纳管；平台 managed skill 仍是单条创建。
- **不做** SKILL.md frontmatter `name` 字段与目录名不一致时的双向处理。**目录名为准**——frontmatter.name 与目录名不一致时记 warning，DB row 取目录名（与 external import 当前行为一致）。
- **不做** 把 source-derived skill 转为 managed 的一键迁移按钮——超出本 RFC 范围，后续如有诉求另开 RFC。

## 3. 用户故事

**S1（happy path：纳管 `~/.claude/skills/`）**
用户已经在 `~/.claude/skills/` 下维护了 6 条 skill（`code-reviewer / api-designer / sql-formatter / ...`）。打开 `/skills/new` → 选 "Folder" tab → 路径填 `/Users/foo/.claude/skills`，label 填 "Claude skills"，提交。回到 `/skills` 列表，顶部 banner："已纳管 6 条 skill，0 冲突"，下方 skill 行每条都带 "from Claude skills" pill。

**S2（自动跟随新增）**
用户 1 周后在外部 IDE 里新建 `~/.claude/skills/test-writer/SKILL.md`。下一次他打开 `/skills` 列表，页面渲染时 lazy 扫描把 `test-writer` upsert 进 skills 表，列表里直接出现这条；同样在 `/agents/new` 表单的 Skills 下拉里也能立刻选到——**用户没做任何额外动作**。

**S3（自动跟随删除）**
用户在外部把 `~/.claude/skills/sql-formatter` 整个目录删了。下次 `/skills` 列表打开 → reconcile 发现 SKILL.md 不在了 → 从 `skills` 表删该行。如果有任何 agent 仍在 `agent.skills` 里引用 `sql-formatter`，删除拒绝 + UI 在 source 卡片显示红点 "1 child skill 仍被 agent 'code-auditor' 引用，请先解绑"——避免 agent 运行期报 skill-not-found 是后置故障。

**S4（手动 rescan）**
用户刚在外部目录加了一条 skill，但他正在打开一个 agent detail 页配 skills 下拉、不想去切到 `/skills` 触发 lazy 扫描。他切到 `/skills` 顶部 source 卡片点 "Rescan"，1s 内卡片刷新 "扫到 7 条 skill (+1)"。

**S5（冲突）**
用户先手动 import 了一条 external skill name = `code-reviewer` 指向 `~/work/old-stuff/code-reviewer/`；又登记 source `~/.claude/skills/`，里面同样有 `code-reviewer` 子目录。扫描完成后 source 卡片显示 warning "1 条 skill 因同名被丢弃：code-reviewer（与手动登记的 external skill 冲突）"。手动那条胜出，列表里 `code-reviewer` 不带 source pill。

**S6（source 行删除）**
用户决定下掉 `~/.claude/skills/` 这条 source。`/skills` 列表 source 卡片点 Remove。如果它带进来的子 skill 没有任何 agent 引用，确认对话框列出"将删除 6 条 skill"，确认后 source 行 + 6 条 skill 都删；agent 引用拒绝时弹出阻塞列表（与 S3 同样路径）。

## 4. 验收标准

### 功能

- **A1（登记）**：`POST /api/skill-sources { path, label? }` 接受绝对路径 + 落 source 行 + 跑首次扫描 + 返回 `{ source, imported: Skill[], skipped: {name, reason}[] }`。路径不存在 → 400 `skill-source-path-missing`；指向文件 → 400 `skill-source-path-not-dir`；同一规范化路径已登记 → 409 `skill-source-path-in-use`。
- **A2（首次扫描）**：父目录里"直接子目录 + 含 SKILL.md"被识别为 skill，name 与目录名一致，description 取 SKILL.md frontmatter.description；不含 SKILL.md / 子目录名违反 `SKILL_NAME_RE` 的子项被 skipped 数组列出。
- **A3（lazy 跟随增）**：external 目录在登记后新增一个合规子 skill → 下次 `GET /api/skills` 返回列表包含新条目；agent.skills 下拉里同样能选到。
- **A4（lazy 跟随删）**：external 目录删除一个子 skill 子目录 → 下次 `GET /api/skills` 在 reconcile 中把对应 skills 行删除（前提：没有 agent 仍在引用它）。
- **A5（agent 引用守卫）**：若 lazy 删 / source 删 / 子 skill 删的目标仍被任何 agent.skills 引用 → reconcile **跳过删除**该子 skill（不阻断整次扫描），source 卡片在 `lastScanError` 上累计 `still-referenced:{name}` 列表；UI 红点 + 文案。`DELETE /api/skill-sources/:id` 在级联前对所有子 skill 跑同一守卫，**任一**被引用 → 400 `skill-source-children-referenced` + body 列出 `[{skillName, byAgent}]`。
- **A6（冲突优先级）**：手动 managed/external 与 source 同名 → 手动胜出，source 候选 skipped；两条 source 同名 → 先登记者胜出。
- **A7（rescan）**：`POST /api/skill-sources/:id/rescan` 不依赖列表请求，立刻跑一次 reconcile，返回 `{ imported: [], deleted: [], skipped: [] }` 三段。
- **A8（启用 / 停用）**：`PATCH /api/skill-sources/:id { enabled: false }` → reconcile 把该 source 带的所有子 skill 删（受 A5 守卫）；`{ enabled: true }` 重扫并重新引入。
- **A9（runner 零改动）**：跑一条 agent 引用某 source-derived skill 的 task → opencode 子进程的 `OPENCODE_CONFIG_DIR/skills/{name}/` 仍是对 `externalPath` 的 symlink，agent 能正常加载 skill（与 single-external 同行为）。
- **A10（UI）**：`/skills` 顶部出现 Source folders 区段；新建 Folder tab 表单可正常提交；列表 skill 行 source pill 仅出现在 `sourceId != null` 的行；尝试编辑 source-derived skill 的 description/body 弹"该 skill 由 source folder 纳管，请在外部目录编辑文件"，与 single-external 同行为，但错误码区分为 `skill-source-readonly`。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿；CI 单二进制 build + e2e 不退化。
- **B2** 不退化既有 skills / agents 测试集（managed / external 既有路径继续按现行规则跑）。
- **B3** backend tests 至少 +18（service 12 + http 6，详见 design.md §6）；frontend tests 至少 +9（列表 source 区段 4 + Folder 创建表单 3 + source pill 2）。
- **B4** 一条新 migration `0005_skill_sources.sql`，可重复 apply / rollback；启动时 migration helper 自动执行。
- **B5** `services/runner.ts` / `services/runtime.ts` 0 LOC 改动——除导入 type 调整外。
- **B6** lazy 扫描成本：50 条 skill / source 量级单次扫描 < 30ms（design.md §5.3 性能预算）。超出预算时降级为 5 秒 TTL debounce（v1 不实现，留作 v1.1 兜底）。

### 回归防护

- **C1** `tests/skill-source-discover.test.ts` 顶部注释链回本 RFC：「locks RFC-017 §2.1 #1 — discoverSkillsInDir 只识别直接子目录 + 必须含 SKILL.md + name 必须匹配 SKILL_NAME_RE；递归更深、空子目录、name 违规子目录被 skipped 数组带出。红了说明扫描规则被改坏」。
- **C2** `tests/skill-source-reconcile.test.ts` 锁 reconcile 三态（imported / deleted / skipped）+ 引用守卫（agent.skills 引用时不删 + 累计 lastScanError）；红了说明 A4 / A5 语义被破坏。
- **C3** `tests/skill-source-cascade-delete.test.ts` 锁 `DELETE /api/skill-sources/:id` 行为：守卫触发返 400 + 列出阻塞引用；无阻塞时级联删 source + 所有子 skill；红了说明 source 删除变成"无视引用的硬删"。
- **C4** `tests/skill-source-conflict.test.ts` 锁冲突优先级（手动 > source、先登记 source > 后登记 source）。
- **C5** 源代码层兜底：`tests/skill-source-runner-zero-touch.test.ts` 用 fs 读 `services/runner.ts` + `services/runtime.ts`，断言"skill_source" 字面量不在两文件出现（仅经 `Skill` 类型间接消费），防止后续重构把 sourceId 误透传到 runner 路径。

## 5. 风险与回滚

- **风险**：lazy 扫描可能在 large parent dir 拖慢 `GET /api/skills`。**缓解**：design.md §5.3 给出 30ms 预算 + v1.1 5s TTL debounce 兜底；首版可观测 `lastScanError` + `lastScanDurationMs` 字段（仅 service 层记录，UI 不渲染）。
- **风险**：用户外部 IDE 同时改多文件，lazy 扫描读到半态 SKILL.md。**缓解**：discover 用 `try { parseFrontmatter } catch { skip + record }`，单条 skill 解析失败不影响其它。
- **风险**：source 卡片"被引用"提示与 agent 写入并发——agent 端 PATCH skills 后 source 重扫前的中间态。**缓解**：reconcile 跑在写事务外，任何"应删但被引用"统一不删 + 记 warning，等下次扫描自然恢复。
- **回滚**：migration 0005 down 即可（drop `skill_sources` 表、drop `skills.source_id` 列）；前后端代码以单 PR 落地、`git revert` 即可整体回退；DB 中已落的 source-derived skill 行因 `sourceKind='external'` 与单条 external 同质，down migration 同步清除（详见 design.md §3.2）。
