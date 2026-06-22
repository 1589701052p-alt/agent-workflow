# RFC-101 记忆→技能融合（Memory → Skill Fusion / 融合资产）— proposal

> 产品视角。技术设计见 `design.md`，任务分解见 `plan.md`。
> 状态：Draft（待用户批准后进入实现）。

## 1. 背景与动机

平台已有两套互补的知识载体：

- **记忆（memory，RFC-041/045/099）**：从 clarify / review / feedback 蒸馏或人工录入的**短条目**（`body_md` ≤ 4000 字），经管理员审批为 `approved` 后，在 agent 运行时按 scope（agent/workflow/repo/global）**自动注入**进系统提示。它是"软偏好"，零散、按条注入、有 token 预算上限。
- **技能（skill，RFC-016/017/019）**：文件系统为事实源的 `SKILL.md`（frontmatter + body）+ 支撑文件（references/ examples/ scripts/），由 opencode 在运行时按需加载，承载**结构化、可渐进披露的成体系知识**。

问题：随着同一主题的 approved 记忆越积越多，它们以零散条目的形式反复注入，既消耗 token 预算、又缺乏组织；而这些知识其实更适合**沉淀成一个成体系的技能**。今天没有任何机制把"一堆已审批记忆"提炼、融合进一个技能——只能人工把记忆逐条复制、手改 `SKILL.md`，既费力又容易丢失（技能**当前完全没有版本/历史**，改坏无法回退）。

本 RFC 引入**记忆→技能融合**：选取多条 approved 记忆，由一个内置 opencode agent 按技能写作规范把它们**融合进某个既有 managed 技能**，过程中通过**反问（clarify）**让融合者确认目标 / 细节 / 解冲突，融合产物以**修改前后 diff** 呈现给融合者确认，确认后替换旧技能、旧版本存档、版本号 +1，被融合的记忆标记为 `fused`（不再重复注入）。

这正是平台核心抽象（record-state → run-agent → diff → 人确认）的一次自然落地：技能就是"被多条记忆融合后的融合资产"。

## 2. 目标 / 非目标

### 目标

1. **G1 通用技能版本化（能力 A，地基）**：技能获得真正的内容版本号 + 历史存档 + 任意两版 diff + **一键回退**。**所有**写技能内容的路径（含现有编辑器 Save）都经统一漏斗存档 + 升版。
2. **G2 记忆→技能融合（能力 B，主功能）**：多选 approved 记忆 → 选目标 managed 技能 → 内置 `skill-merger` agent 融合（强制 ≥1 轮反问）→ 前后 diff → 批准 / 退回重做 → 提交。
3. **G3 融合资产可追溯**：被融合记忆转入终态 `fused`，记录被哪个技能的哪一版吸收；技能版本记录其来源（编辑器 / 融合 / 回退）与变更摘要。
4. **G4 最大化复用**：复用任务/调度/runner/git-wrapper/反问/diff/公共 UI 原语，不另起炉灶。
5. **G5 双入口**：`/memory`（先选记忆再选技能）与 `/skills/:name`（先开技能再选记忆）皆可发起，落入同一融合流程。

### 非目标

- **N1**：不支持把记忆融合进 **external 技能**（平台从不写 external 技能目录）——仅 managed 技能。
- **N2**：v1 不支持"从记忆**新建**技能"（仅更新既有 managed 技能）。
- **N3**：不引入跨记忆的自动去重/冲突静态检测引擎——冲突由 agent 在融合时发现并经反问交给人；框架不预判语义冲突。
- **N4**：不做内容级溯源（不追踪"技能正文里的哪一句来自哪条记忆"）。融合溯源**锚定在版本号**上（见 §6 D9）。
- **N5**：不改动记忆的注入预算 / 渲染（RFC-041）；`fused` 因不等于 `approved` 而被现有注入查询天然排除，零改动。

## 3. 名词

| 名词 | 含义 |
|------|------|
| 融合（fusion） | 把 N 条 approved 记忆的知识合并进一个目标 managed 技能的一次操作 |
| 融合者（merger） | 发起并/或审批一次融合的人；= 引擎任务的成员（owner + collaborator） |
| skill-merger | 执行融合的内置 opencode agent（writer，内嵌技能写作规范） |
| 引擎任务（engine task） | 驱动一次融合迭代的平台 task，跑内置工作流 `__skill_fusion__` |
| 临时仓（ephemeral repo） | 由目标技能 `files/` 播种、`git init` 的一次性 git 工作树，作引擎任务的 worktree |
| 融合记录（fusion record） | `fusions` 表的产品级实体，编排"运行→待批准→应用→完成/退回"，1 个融合贯穿多次迭代 |
| 技能版本（skill version） | 技能 `files/` 在某次写入后的不可变快照（`skill_versions` 行 + 磁盘归档） |

## 4. 用户故事

- **US1**：作为管理员，我在 `/memory` 勾选 5 条关于"lint 规范"的 approved 记忆，点"融合到技能…"，选目标技能 `lint`，写一句意图（"把这些 lint 偏好整理进技能，去重并按类别归类"），发起融合。
- **US2**：作为融合者，agent 先反问我："记忆 A 要求 2 空格缩进、记忆 D 要求 4 空格，技能现状是 tab——以哪个为准？"我在 `/clarify` 选择并补充说明，agent 据此修订。
- **US3**：融合结束，我在融合详情页看到 `SKILL.md` 与支撑文件的**修改前后 diff**、agent 的变更摘要、以及"已吸收 4 条 / 跳过 1 条（与现有内容重复）"。我觉得某节措辞不妥，点"退回并反馈"，写"references/style.md 的表格太啰嗦，精简成清单"，agent 在上次产物基础上再改一版。
- **US4**：满意后我点"批准"。技能 `lint` 从 v6 升到 v7，v6 存档进历史；被吸收的 4 条记忆变为 `fused → lint v7`，不再在运行时注入；被跳过的 1 条仍为 `approved`。
- **US5**：作为技能 owner，我在 `/skills/lint` 看到"版本"区，对比 v5↔v7，发现 v7 引入了不想要的内容，点"回退到 v5"——系统提示"此操作将解融合 2 条记忆（它们于 v6/v7 被吸收），它们将恢复为 approved 并重新参与注入"，我确认后技能生成 v8（内容 = v5），那 2 条记忆回到 approved。

## 5. 端到端流程

```
                       能力 B：记忆→技能融合
 /memory 多选 approved 记忆        /skills/:name 选 approved 记忆
        \                                   /
         \________ 选目标 managed 技能 + 意图 ________/
                          |
                          v
        创建 fusion 记录 + 引擎任务（iteration 1）
        worktree = 临时 git 仓（git init，baseline=技能当前 files/）
                          |
                          v
   内置工作流 __skill_fusion__ :  [ git-wrapper [ skill-merger agent + 强制 self-clarify ] ]
        agent cwd = 临时仓 = 技能文件；记忆正文 + 意图经 prompt 注入
                          |
        强制 ≥1 轮反问  --> 复用 /clarify UI（任务 awaiting_human）
        融合者答复目标/冲突 <------------------'
                          |
        最终轮：agent 编辑 files/（SKILL.md + 支撑文件）并 emit <workflow-output>
        git-wrapper 捕获全目录 diff（baseline → 工作树，含未跟踪）
                          |
        引擎任务 done -> fusion = awaiting_approval（暂存 proposed 工作树 + diff）
                          |
                          v
   ┌─────────── 融合详情：修改前后 diff（DiffViewer 多文件） ───────────┐
   │  当前技能 files/      vs      proposed files/                      │
   │  + agent 变更摘要 + 已吸收/跳过记忆清单                            │
   │   [批准]                         [退回并反馈]                      │
   └────────┬────────────────────────────────┬─────────────────────────┘
            v                                  v
   原子应用（能力 A 漏斗）：           创建 iteration K+1 引擎任务
   - 旧 files/ 存档为 v(N)             worktree 由"上一版 proposed 工作树"播种
   - proposed → files/ = v(N+1)       反馈经 prompt 注入；反问可再触发
   - 被吸收记忆 → fused (skill,v(N+1))  '----------> 回到上面的流程
   - fusion = done, 任务 = done
```

能力 A（通用版本化）独立于 B：编辑器在 `/skills/:name` 的每次 Save，也同样走"存档旧版 + 升版"漏斗，并在"版本"区暴露历史/对比/回退。

## 6. 决策登记（D-marks）

下列决策中 **D1–D10** 由用户在落档前的反问澄清中拍板，**D11–D17** 由设计者依现有代码/平台惯例确定，**在 RFC 评审中请用户确认或推翻**。

| # | 决策 | 选择 | 来源 |
|---|------|------|------|
| D1 | 执行 & 反问模型 | 作为真实平台**任务**跑内置 skill-merger agent，整体复用 clarify/ACL/输出信封 | 用户 |
| D2 | 被融合记忆去向 | 新增终态 `fused` + 溯源（`fused_into_skill` / `fused_into_skill_version`）；不再注入 | 用户 |
| D3 | 版本化范围 | **通用**：新增 `version` 列 + `skill_versions` 表；**每次**写入（含编辑器）都存档+升版 | 用户 |
| D4 | 入口 & 目标 | `/memory` 与 `/skills/:name` **双入口**；仅更新既有 **managed** 技能，不新建 | 用户 |
| D5 | 变更范围 | `SKILL.md` frontmatter+body **及支撑文件**；agent 在可写工作目录改文件，捕获全目录 diff | 用户 |
| D6 | 写作规范来源 | 把 skill-creator / skill-development 规范**内嵌**进内置 skill-merger agent 定义 | 用户 |
| D7 | 反问义务 | **强制 ≥1 轮**（复用 RFC-100 mandatory-clarify） | 用户 |
| D8 | 批准闸 | **自建** diff 闸：当前 vs proposed，批准 / 退回并反馈（重跑），复用 DiffViewer + Dialog | 用户 |
| D9 | 记忆选取范围 | 允许**跨 scope** 任选 approved 记忆（scope 仅作溯源元数据） | 用户 |
| D10 | 回退 | v1 含**一键回退**：回退到 vN 生成新版 v(M+1)=vN 内容；**解融合**所有 `fused_into_skill_version > N` 的记忆（恢复 approved），≤ N 的保持 fused | 用户 |
| D11 | 融合资产的归档语义 | 不变式：**`fused` ⟺ 其知识在技能"当前版本"中**；故回退跨融合版会解融合（见 D10），编辑器手删内容**不**自动解融合（仅锚定版本号，N4） | 设计者 |
| D12 | 已吸收 ⊆ 已选取 | agent 输出"已吸收 / 已跳过（含原因）"记忆 id；**仅已吸收**的标 fused；框架校验已吸收 ⊆ 已选取 | 设计者 |
| D13 | 发起权限 | 需对目标 managed 技能有**写权限**（owner/admin，RFC-099 技能 ACL）+ 对每条所选记忆有 `memory:read` + scope 可见 | 设计者 |
| D14 | 融合记忆所需权限 | 标记记忆为 fused 是对记忆的管理写——**需对每条记忆 can-manage**（同 archive：agent/workflow 记忆 owner、repo/global 记忆 admin）；发起与应用两处都校验，picker 标注不可管理项。**请用户确认松紧** | 设计者 |
| D15 | 批准者 | = 引擎任务成员（owner + collaborator），与 clarify 回答权一致 | 设计者 |
| D16 | 临时仓实现 | 复用 `preCreatedWorktree`（RFC-020）后门播种临时 git 仓，不改任务启动 schema | 设计者 |
| D17 | agent 编辑时机 | skill-merger **仅在最终（stop）轮**改文件；反问轮纯 Q&A 不改文件 → 规避 rerun 回退/重复编辑 | 设计者 |

## 7. 验收标准

**能力 A（版本化）**

1. 既有 managed 技能在迁移后获得 `version=1`，且其当前 `files/` 被存档为 `v1`（历史可见、可对比、可回退）。
2. 在 `/skills/:name` 编辑器 Save（改 body 或支撑文件）后，技能 `version` +1，旧内容进历史，"版本"区出现新行（source=editor）。
3. "版本"区可列出全部历史、对比任意两版（多文件 DiffViewer）、一键回退；回退生成新版（source=restore），永不破坏性覆盖。
4. external 技能无版本区（只读，不适用）。

**能力 B（融合）**

5. 从 `/memory` 多选 ≥1 条 approved 记忆可发起融合并选 managed 目标技能；从 `/skills/:name` 也能发起并选记忆。两路落入同一融合流程。
6. skill-merger **必须**至少反问 1 轮才能产出；反问经既有 `/clarify` UI 由任务成员回答（含逐题协作草稿 RFC-099）。
7. 融合产出在融合详情页以**当前 vs proposed 多文件 diff** 呈现，并列出 agent 变更摘要与已吸收/跳过记忆清单。
8. 批准后：目标技能升版（source=fusion）、旧版进历史、`files/` 更新为 proposed；**已吸收**记忆转 `fused` 并记录 `(skill, version)`；**被跳过**记忆仍 approved。以上在一个 DB 事务内原子完成。
9. 退回并反馈：发起新一轮迭代，临时仓由上一版 proposed 播种 + 反馈注入；可再次反问；直到批准或取消。
10. `fused` 记忆不在运行时注入（注入查询仅取 approved，byte-equal 不变）；`/memory` 以 chip 显示 `fused → {skill} v{n}`。
11. 回退跨融合版时按 D10 解融合，回退 UI 事前列出将被解融合的记忆，确认后这些记忆恢复 approved。

**通用门禁（CLAUDE.md）**：`bun run typecheck && bun run test && bun run format:check` 全绿，单二进制 build smoke + e2e 绿；每个改动带测试（见 design.md §测试策略）。

## 8. 触发

2026-06-23 用户：「给系统增加把记忆融合进 skill 成为融合资产的能力：选多条已批准记忆合并入某 skill，参考 skill-creator/skill-writer 写法更新 skill，过程能启动反问让合并者确认目标/细节/解冲突，结束后看修改前后对比，确认则替换旧 skill、旧 skill 存档历史版本、版本号 +1。先完全规划好再动手。」
