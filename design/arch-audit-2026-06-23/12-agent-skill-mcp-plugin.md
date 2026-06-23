# Agent / Skill / MCP / Plugin 资源管理 — 架构审计 (2026-06-23)

> 子系统 key: `12-agent-skill-mcp-plugin`
> 范围：四类资源的源真相一致性、依赖闭包、版本历史、清单快照、注入。
> 与既有审计的关系：`design/dedup-audit-2026-06-13.md` 已覆盖闭包孪生 / 反向引用扫描 / frontmatter
> 解析 / agent-md 名数组字段等"逐字重复"层面。本报告**不重复**它们的去重落点，而是上升到
> **架构形态 + 扩展性**视角：四类资源该不该共用一套 CRUD/版本/闭包/注入原语，半年后加新资源类型
> 或新闭包维度会逼人 fork 到什么程度，理想目标形态是什么。

---

## 0. 健康度一句话

资源管理是全仓**分层最干净、ACL 收口最好**的子系统之一（`resourceAcl.ts` 单一事实源、save-time
引用守卫齐全、`dbTxSync` 修过 rename 半提交），但**四类资源各自演化、没有共同的资源抽象**：CRUD /
反向引用 / 闭包 / 注入被 fork 成 3-5 份并已开始漂移（MCP 不查 enabled、plugin 双 id/name 身份、
skill 路径解析两套、ZIP 导入绕过版本漏斗），半年内只要加"第 5 类资源"或"第 2 个闭包维度"就会
再 fork 一轮 —— 健康但**抽象债在累积**。

---

## 1. 当前架构与职责

四类可被 agent 引用的资源，全部以 **DB 行 + name 唯一约束**为锚，但源真相分裂：agent/mcp/plugin
是 **DB 为真值源**（JSON 列在 service 边界 (un)marshal），skill 是 **文件系统为真值源**（DB 仅存索引
`source_kind/managed_path/external_path`，`proposal.md:59`）。引用关系靠 agent 行里的 JSON 数组
（`dependsOn` / `mcp` / `plugins` / `skills`）维系；save 时每类各有一个"存在性/启用性"守卫，delete/rename
时各有一个"谁在引用我"反向扫描。运行期调度器在 `prepareNodeRunInjection` 里展开 **agent dependsOn
闭包**，再沿闭包 union 出 skills/mcps/plugins 三套资源，喂给 `runner.buildInlineConfig` 拼成
`OPENCODE_CONFIG_CONTENT` inline JSON（agent/mcp/plugin）+ `OPENCODE_CONFIG_DIR/skills/`（skill copy/symlink）。

**关键文件清单**：
- CRUD：`services/agent.ts`(495) / `skill.ts`(476) / `mcp.ts`(247) / `plugin.ts`(345)
- 依赖闭包：`services/agentDeps.ts`(206, BFS 真闭包) / `mcpClosure.ts`(94) / `pluginClosure.ts`(103)（后两者仅一层 union，非真闭包）
- 版本/历史：`services/skillVersion.ts`(554, 仅 skill 有) + `db/schema.ts:271 skill_versions`
- skill 文件来源：`skill-source.ts`(604, 目录源) / `skill-zip.ts`(425, ZIP 导入)
- 安装/探测：`pluginInstaller.ts`(397, npm/git/file 安装) / `mcpProbe.ts`(580) / `mcpProbeStore.ts`(137)
- 清单快照：`inventory.ts`(259) + `shared/inventory.ts`
- 注入合成：`scheduler.ts:4330 prepareNodeRunInjection` + `runner.ts:1447 buildInlineConfig`
- ACL：`services/resourceAcl.ts`（单一事实源，4 路由统一消费）

---

## 2. 设计问题（Design）

**[RES-01] 没有"可引用资源"统一抽象，四类各自演化** — P2｜design/coupling｜
证据：`agent.ts:338 validateMcpReferences` / `agent.ts:359 validatePluginReferences` /
`agentDeps.ts:108 validateDependsOn` / `skill.ts:214 findAgentsUsingSkill` 各写一份；闭包
`mcpClosure.ts` vs `pluginClosure.ts` 逐字孪生（`collectMcpNamesFromClosure` ≡
`collectPluginNamesFromClosure`，仅字段名 `mcp`↔`plugins` 不同）。｜影响：每类资源的"引用守卫 +
反向扫描 + 闭包 union + inline 注入"是同一套概念的 4 份独立实现，已开始漂移（见 RES-02/03/04）。｜
建议：引入 `ReferableResource` 描述符（`{ table, refColumn, kind, hydrate, toInlineEntry }`），把
save 守卫 / 反向扫描 / 闭包 union / inline 合成都参数化到 1 份。这是比 dedup-audit 的
`resourceClosure.ts` 泛型更上层的目标形态（dedup 只合并闭包遍历，本条合并整条引用生命周期）。

**[RES-02] MCP 与 plugin 的"启用性"语义不对称** — P2｜design｜
证据：`agent.ts:359-388` plugin 在 save 时既查存在又查 `enabled`（`plugin-disabled` 422）；
`agent.ts:338-351` MCP **只查存在不查 enabled**。运行期 `runner.ts:1493`(mcp) 与 `:1505`(plugin)
**都**跳过 `enabled===false`。｜影响：保存引用了 disabled MCP 的 agent 会成功（无警告），spawn 时静默
丢该 MCP；同样情形的 plugin 在 save 就 422。两类"被引用的可禁用资源"行为应当一致却分叉，用户心智
模型不可预测。｜建议：在统一描述符里把 `enabledCheckAtSave` 作为一个 flag，两类要么都 warn 要么都 block。

**[RES-03] plugin 双 id/name 身份，其余三类纯 name 身份** — P2｜design｜
证据：`plugin.ts:58 getPlugin(idOrName)` 先按 id 再按 name 查；路由按 `/{id|name}` 双查；但
agent.plugins[] 存的是 **name**，`renamePlugin` 必须级联改 agent 行（`plugin.ts:245 dbTxSync`）。
agent/mcp/skill 全是 name-only。｜影响：plugin 有"稳定 id + 可变 name"双身份，但引用面仍按 name →
既要 id 路由又要 name 级联，是两类资源标识模型混用；未来若想给 agent/mcp/skill 也加稳定 id（避免
rename 级联），现有 plugin 的"半 id"实现不是个能照搬的范式。｜建议：定一个统一的"引用标识"策略——
要么全部走稳定 id（引用面存 id，name 纯展示，rename 零级联），要么全部纯 name（删 plugin 的 id 查询面）。

**[RES-04] skill 路径解析存在两套真值** — P2｜impl-bug 倾向/coupling｜
证据：`skill.ts:72 skillRoot()` 是 canonical（external 返回 `externalPath`，managed 返回
`appHome/skills/{name}/files`）；但 `scheduler.ts:4428` 注入时**另写一份**
``${appHome}/${row.managedPath ?? \`skills/${name}/files\`}``，且 `skillVersion.ts:46 skillFilesDir`
**硬编码** `appHome/skills/{name}/files` 完全忽略 `managed_path` 列。｜影响：DB 里 `managed_path`
本是真值源索引，但版本漏斗根本不读它；若某行 `managed_path` 被改成非默认值，注入路径与版本快照路径
会指向不同目录 → skill 内容/版本错位。当前所有写路径都写默认 `skills/{name}/files`（`skill.ts:111`/
`skill-zip.ts:402`）所以暂时无 bug，但**真值源被三处各自假设**是定时炸弹。｜建议：所有路径派生唯一
出口 `skillRoot(skill)`，scheduler/skillVersion 都消费它，彻底删掉 `managed_path` 列或让它成为唯一来源。

**[RES-05] 只有 skill 有内容版本历史，agent/mcp/plugin 的可编辑正文/配置无历史** — P2｜design｜
证据：`db/schema.ts:271 skill_versions` + `skillVersion.ts` 整套漏斗；agent 有可编辑 `bodyMd` +
`frontmatterExtra`（`agent.ts:200`）却无任何版本表；mcp `config` / plugin `options` 同样无历史
（plugin 的 `resolvedVersion` 是安装版本号，非编辑历史）。｜影响：RFC-101 给 skill 投入了 554 行
版本漏斗 + 崩溃对账 + restore，但同等重要的 agent 正文（直接进 prompt、改错会污染所有引用它的工作流）
零回滚能力。这是"为一类资源建了重型基础设施，却没设计成可复用到其他三类"的典型——版本能力被
skill 私有化。｜建议：把 `commitSkillVersion` 漏斗抽象成 `commitResourceVersion(resourceKind, …)`，
agent/mcp 复用同一 `*_versions` 表模式（agent 正文进 prompt 的风险其实最高，最该先有历史）。

**[RES-06] 闭包只有"agent→agent"一个维度，资源间无依赖图** — P2｜design/extensibility｜
证据：`agentDeps.ts` 是唯一的真闭包（BFS + 环检测）；`mcpClosure`/`pluginClosure` 只是沿 agent 闭包
做一层 union，资源**本身**不能依赖资源（plugin 不能依赖 plugin、skill 不能依赖 mcp）。｜影响：当前
够用，但模型把"依赖闭包"和"资源 union"混成两套机制；任何"让资源 X 也能声明依赖"的需求（见 §4 CP-2）
都要新建第三套闭包。｜建议：见 §4 CP-2 与 §7 目标形态——统一为一张资源依赖图 + 一个通用 BFS。

---

## 3. 实现问题 / Bug（Impl）

**[RES-07] ZIP 导入/覆盖绕过版本漏斗，已知但未修的历史完整性缺口** — P2｜impl-bug｜
证据：`skill-zip.ts:348 writeCandidate` 直接 `writeFileSync` 写 `files/`，`insertManagedRow:389`/
`updateManagedRow:415` **从不调用** `commitSkillVersion`；`skillVersion.ts:9-13` 头注释自承"THE
single funnel"，`:528-534` 又承认 RFC-019 ZIP 是"out-of-funnel writer"；RFC-101 design.md:440
明确记 "ZIP 覆盖未升版属 P2 历史完整性缺口，记入 follow-up"。｜影响：(a) ZIP 新建的 skill **没有
v1 快照**，要等下次任一读路径触发 `ensureInitialSkillVersion` 懒补；(b) ZIP **覆盖**已有 skill 时
`content_version` 不变、`files/` 内容已换 → 历史里永久丢失这次变更，且 `versions/v{cur}` 与真实
`files/` 内容不符（对账器 `:536` 又故意不 clobber 以免丢 ZIP 写入，于是不一致被永久接受）。｜建议：
ZIP 写路径改走 `commitSkillVersion(source:'zip-import')`；这是 RES-01 统一漏斗的直接收益。

**[RES-08] checkForUpdate 探测目录命名/清理依赖时间戳，并发可碰撞** — P3｜impl-bug｜
证据：`pluginInstaller.ts:321` `probeDir = join(root, \`${pluginId}.check-${Date.now().toString(36)}\`)`
然后 `:323 installPluginInner(\`${pluginId}.check\`, …, {pluginsDir: probeDir})` —— in-flight Map
（`:131`）键是 `${pluginId}.check`（固定，不含时间戳），但目录含时间戳。｜影响：同一 plugin 同一毫秒
内两次 checkForUpdate，in-flight Map 会让第二次复用第一次的 Promise（返回它的 probeDir 结果），而
`finally` 里 `:333 rm(probeDir)` 各删各的 → 逻辑上低危（结果仍正确），但 in-flight 键与目录键不一致
是个设计裂缝；若未来 probeDir 命名改为确定性，会真冲突。｜建议：in-flight 键与目录派生用同一 token。

**[RES-09] `readInstalledPackage` 多依赖时"取最后一个"是脆弱启发式** — P3｜impl-bug｜
证据：`pluginInstaller.ts:276` `requestedName = keys[keys.length - 1]`，注释自承"host pkg.json 手改过
就取最后一个"。｜影响：正常单 spec 安装写一个 dep，安全；但 git/github spec 经 npm 解析后若 host
deps 出现多于一个键（npm 行为版本相关），"取最后"无原理保证就是用户请求的那个，可能再次surfaced
错误的 resolvedVersion（正是 RFC-031 修过的 zod 误报类 bug 的同源风险）。｜建议：记录安装前的
deps 集合做差集，或显式从 spec 解析包名而非依赖 npm 落盘顺序。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[CP-1] 加"第 5 类可引用资源"要碰 ≥9 处、fork 4 套模式** — P1｜extensibility｜
未来场景：半年后要加"prompt 片段库 / shared-config / dataset"等第 5 类资源给 agent 引用。
根因：没有 RES-01 的统一资源抽象，"可引用资源"= CRUD service + 引用守卫 + 反向扫描 + 闭包 union +
inline 注入 + ACL projection + 路由 + 前端 picker 的 8-9 件套，每件都是按资源 fork 的。
现在加功能要碰：① 新 service（仿 `mcp.ts`）② `agent.ts` 加 `validateXxxReferences`（仿 :338/:359）
③ 新 `xxxClosure.ts`（仿 `mcpClosure.ts` 逐字）④ `prepareNodeRunInjection`（scheduler.ts:4403-4410）
加一段 collect+load ⑤ `runner.buildInlineConfig`（:1447）加 mcp/plugin 之外第三个分支
⑥ `db/schema.ts` 加表 + agent 加 `xxx` JSON 列 ⑦ `rowToAgent`/`createAgent`/`updateAgent` 加列
marshal（agent.ts 三处）⑧ ACL kind 注册 ⑨ 前端 picker（dedup-audit `list-multiselect-picker` 已点名）。
目标形态：一个 `ReferableResource` 注册表，新资源 = 填一个描述符 + 1 张表；守卫/扫描/闭包/注入/ACL
全部表驱动（见 §7）。这是本子系统**最高价值**的重构。

**[CP-2] 让任何资源"声明依赖"要新建第三套闭包** — P1｜extensibility｜
未来场景：plugin A 依赖 plugin B（opencode plugin 间有依赖）、或 skill 引用 mcp。
根因：RES-06——真闭包只存在于 `agentDeps.ts`，`mcpClosure`/`pluginClosure` 是"沿 agent 闭包 union"
的退化形态，不能表达资源自身依赖。现在加功能要：在对应 service 加依赖列 + 仿 `agentDeps.ts:59
resolveDependsClosure` 再写一份 BFS+环检测（206 行模式）+ 在 `prepareNodeRunInjection` 把单层 union
换成二维闭包合并。环检测、`allowMissing`、cyclePath 报错全要重写。
目标形态：一张 `resource_deps(from_kind,from_name,to_kind,to_name)` 边表 + 一个泛型
`resolveClosure(kind,name)` BFS；agentDeps 成为它的一个实例，mcp/plugin/skill 自动获得依赖能力。

**[CP-3] 给 agent/mcp/plugin 加"内容历史/回滚"要把 skillVersion 整套照抄一遍** — P1｜extensibility｜
未来场景：agent 正文进 prompt、改错污染全工作流，最该要回滚；产品迟早要 agent/mcp 版本历史。
根因：RES-05——`skillVersion.ts` 的漏斗（archive→bump→sync）+ 崩溃对账 + restore + diff + OCC 全
绑死在 skill 的 `files/` 文件系统模型上（`skillFilesDir`/`skillVersionDirAbs` 硬编码路径），且
DB-为真值源的 agent/mcp（JSON 列，非 files/）连存储模型都不同。现在加功能要：要么给 agent 新建一套
JSON-blob 版本漏斗（漏斗逻辑重写，因为没有 files/ 树可 hash/cp），要么把 agent 正文落盘成 files/
（违反 proposal.md:47 "DB 为真值源"）。两条路都重。
目标形态：把版本漏斗抽象成 `commitResourceVersion(kind, snapshotFn, hashFn)`，对 skill 用
files/-tree 实现，对 agent/mcp 用 JSON-blob 实现，共享 OCC/对账/restore/diff 骨架。

**[CP-4] inline 注入合成是手写 if/分支，加注入维度要改 runner 核心** — P2｜extensibility/coupling｜
未来场景：要给 inline config 加第 4 种注入（如 `command` / `formatter` / 第三方 tool 配置）。
根因：`runner.ts:1447 buildInlineConfig` 把 agent/mcp/plugin/permission 各写一段命令式拼装
（`:1491 mcpMap` / `:1502 pluginArr` 各自 dedupe+enabled 过滤+toEntry），`scheduler.ts:4403-4410`
对应也各 collect+load 一段。新增维度 = 改这两个核心函数的内部、再加一对 collect/load。
目标形态：注入维度也表驱动——每个 `ReferableResource` 描述符提供 `toInlineEntry(row)` 与注入挂载点
（`config.mcp` / `config.plugin` / `OPENCODE_CONFIG_DIR/skills`），`buildInlineConfig` 遍历注册表而非
手写分支。

**[CP-5] skill 的 4 种来源（managed/external/source-derived/zip）写路径分叉，加第 5 种来源要改全家** — P2｜extensibility｜
未来场景：加"git 仓库作为 skill 源"或"远程 registry skill"。
根因：skill 来源已有 managed（`skill.ts` 写）、external 手导（`skill.ts:140`）、source-derived
（`skill-source.ts` reconcile）、zip（`skill-zip.ts`），四者各有自己的"写 files/ + 插 row + 是否进
版本漏斗"逻辑（RES-07 即其代价：zip 路径忘了进漏斗）。`ensureSkillIsWritable`（`skill.ts:464`）已要
区分 `sourceId != null`（source-readonly）vs 纯 external（external-readonly）两套错误码。
目标形态：把"来源"抽成 `SkillSource` 策略（`read()`/`isWritable()`/`reconcile()`），写漏斗只认
"是否可写 + 写完是否升版"两个布尔，新增来源 = 加一个策略实现，不碰漏斗。

---

## 5. 耦合 / 分层违规

**[RES-10] scheduler 重新实现 skill 解析，绕过 skill service** — P2｜coupling｜
证据：`scheduler.ts:4414 resolveSkills` 自己 `db.select().from(skills)` + 自己拼路径（:4428），
而非调用 `skill.ts:72 skillRoot` / `getSkill`。｜影响：skill 路径/来源判定逻辑在 service 与
scheduler 两处独立演化（已是 RES-04 漂移的一半）；skill service 加新来源类型时 scheduler 不会自动
跟进。｜建议：scheduler 经 skill service 的导出函数解析（`getSkill`+`skillRoot`），删除本地副本。

**[RES-11] `prepareNodeRunInjection` 是跨子系统的"上帝合成点"** — P2｜coupling｜
证据：`scheduler.ts:4330` 一个函数同时 import 并编排 `agentDeps`(闭包)、`mcpClosure`、`pluginClosure`、
`resolveSkills`(本地)，返回 4 类资源。｜影响：四类资源的运行期编排集中在调度器里，资源子系统自身
没有"给我这个 agent 的全部注入物"的统一出口；调度器因此与每类资源的 collect/load 细节强耦合（CP-4
的根）。｜建议：把"agent → 完整注入清单"下沉为资源子系统的单一导出
`resolveInjectionBundle(db, agent)`，scheduler 只调一次。

**[RES-12] agent.ts updateAgent 的 frontmatterExtra 合并有可疑死代码** — P3｜coupling/test-gap｜
证据：`agent.ts:162` `JSON.parse(existing.frontmatterExtra !== undefined ? '{}' : '{}')` —— 三元两支
都是 `'{}'`，等价于 `JSON.parse('{}')`，且 `existing.frontmatterExtra` 此时已是对象不是字符串。这段
sidecar 合并逻辑（:153-199）糅了 outputKinds/role/outputWrapperPortNames 三个 RFC 的 reserved-key
搬运，复杂度高且有明显笔误残留。｜影响：当前行为正确（baseFm 后续被覆盖），但这是"把多个 sidecar
字段塞进一个 JSON 列"的复杂度债，每加一个 RFC sidecar 就更长更易错。｜建议：sidecar 字段升为
一等 DB 列，或抽 `mergeSidecar(existing, patch, keys[])` 纯函数 + 单测锁定。

---

## 6. 测试 / 可观测性缺口

**[RES-13] ZIP 导入与版本漏斗的交互无测试** — P2｜test-gap｜
证据：`tests/skill-zip-commit.test.ts` 与 `tests/skill-versioning.test.ts` 各自独立；无测试断言
"ZIP 覆盖后 content_version 是否升 / versions/ 是否与 files/ 一致"。｜影响：RES-07 的历史丢失缺口
没有回归网，未来想修时也没有红用例标注意图。｜建议：补一条"ZIP overwrite 既有 skill → 期望升版（修复后）
或显式标记当前已知缺口"的测试。

**[RES-14] disabled MCP 引用的 save/spawn 行为无对称测试** — P2｜test-gap｜
证据：plugin 有 `plugin-disabled` 422 路径（agent.ts:380）必然有测试；MCP 无对应守卫故无对应测试，
spawn 时静默丢 disabled MCP（runner.ts:1493）的行为无断言。｜影响：RES-02 不对称无人锁定，改一边
另一边不会红。｜建议：补"agent 引用 disabled mcp → save 行为 + spawn inline config 不含它"的断言。

**[RES-15] 注入合成缺结构化可观测** — P3｜observability｜
证据：`runner.ts:555` 日志只记 `mcpCount`/`agents` 计数，不记"哪些闭包成员贡献了哪些资源、哪些
name 在 hydrate 时被静默丢弃"。`loadMcpsByNames`/`loadPluginsByNames` 静默 skip 不存在的 name
（mcpClosure.ts:46-56 注释承认），无任何事件。｜影响：运行期 agent 缺了某 MCP/plugin（被删/被禁）
时，操作者只能从"行为不对"反推，无直接信号。｜建议：hydrate 时把"requested vs resolved"的差集发
一条结构化 warn/event（与 RES-11 统一出口一起做）。

---

## 7. 目标形态（Target architecture）

理想下，本子系统应围绕**一个资源抽象 + 一张依赖图 + 一个注入管线**收敛：

1. **`ReferableResource` 注册表**（解 RES-01 / CP-1 / CP-4）
   每类资源声明一个描述符：
   ```
   { kind, table, nameCol, refColumnOnAgent, schema,
     hydrate(db,names) -> Row[], toInlineEntry(row) -> {mountPoint, value},
     enabledCheckAtSave: 'block'|'warn'|'none', isWritable(row), supportsVersioning }
   ```
   save 守卫、反向引用扫描、闭包 union、inline 合成、ACL projection 全部遍历注册表而非按类 fork。
   新增第 5 类资源 = 填一个描述符 + 1 张表。

2. **统一资源依赖图 + 泛型闭包**（解 RES-06 / CP-2）
   一张 `resource_deps(from_kind,from_name,to_kind,to_name)` 边表，一个
   `resolveClosure(kind,name,opts)` BFS（环检测 / allowMissing / cyclePath 复用 `agentDeps.ts` 已成熟
   的实现）。`agentDeps` 退化为它的实例；mcp/plugin/skill 自动获得"资源依赖资源"能力。
   `mcpClosure`/`pluginClosure` 删除，换成"沿 agent 闭包 + 资源自身闭包"的二维遍历。

3. **资源版本漏斗抽象**（解 RES-05 / CP-3 / RES-07）
   `commitResourceVersion(kind, name, produce, opts)` 抽出 OCC + 崩溃对账 + restore + diff 骨架；
   skill 用 files/-tree 后端（现 `skillVersion.ts`），agent/mcp 用 JSON-blob 后端。**所有**写路径
   （含 ZIP 导入）强制经漏斗，杜绝 out-of-funnel writer。

4. **单一注入出口**（解 RES-10 / RES-11 / RES-15）
   资源子系统导出 `resolveInjectionBundle(db, agent) -> { agents, skills, mcps, plugins, … }`，
   内部遍历注册表 + 依赖图，hydrate 差集发结构化事件。scheduler 只调一次，runner `buildInlineConfig`
   遍历 bundle.entries 而非手写分支。

5. **标识策略统一**（解 RES-03 / RES-04）
   选定全资源统一标识（推荐：引用面存稳定 id、name 纯展示、rename 零级联），删 plugin 的"半 id"
   特例；skill 路径派生唯一出口 `skillRoot`。

---

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话建议 |
|---|---|---|---|---|---|
| 1 | CP-1 | 加第 5 类资源要碰 ≥9 处 fork 4 套 | P1 | extensibility | 引入 `ReferableResource` 注册表，表驱动守卫/扫描/闭包/注入/ACL |
| 2 | CP-3 | agent/mcp 加历史要照抄 skillVersion | P1 | extensibility | 抽 `commitResourceVersion`，agent 正文最该先有回滚 |
| 3 | CP-2 | 资源声明依赖要建第三套闭包 | P1 | extensibility | 统一 `resource_deps` 边表 + 泛型 `resolveClosure` |
| 4 | RES-07 | ZIP 导入/覆盖绕过版本漏斗丢历史 | P2 | impl-bug | ZIP 写路径改走 `commitSkillVersion(source:'zip-import')` |
| 5 | RES-04 | skill 路径解析三处各自假设 | P2 | coupling | 路径派生唯一出口 `skillRoot`，scheduler/skillVersion 都消费 |
| 6 | RES-02 | MCP/plugin 启用性 save 守卫不对称 | P2 | design | 统一 enabledCheck 策略，两类要么都 warn 要么都 block |
| 7 | RES-11 | prepareNodeRunInjection 上帝合成点 | P2 | coupling | 下沉为 `resolveInjectionBundle` 单一出口 |
| 8 | RES-05 | 版本能力被 skill 私有化 | P2 | design | 把版本漏斗设计成可复用到 4 类（CP-3 同根） |

**与既有审计的重叠声明**：闭包孪生（mcpClosure/pluginClosure 逐字）→ 已被 `dedup-audit-2026-06-13.md`
§`mcp-plugin-closure-twins`(#35) 覆盖；5 处反向引用扫描 → 已被 `find-agents-referencing-reverse-scan`(#36)
覆盖；frontmatter 解析 / agent-md 名数组字段 → `frontmatter-parser-and-helpers`(#24) /
`agent-md-name-array-field`(#54)；plugin in-flight dedup → `inflight-dedup-and-captured-subprocess`。
本报告把这些"逐字重复"上升为**架构抽象缺失**（RES-01/CP-1）的征兆，落点比 dedup 的单点公共模块更上层。
