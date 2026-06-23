# Codex 核验：Agent / Skill / MCP / Plugin 资源管理 (12-agent-skill-mcp-plugin)

> 对应报告：`design/arch-audit-2026-06-23/12-agent-skill-mcp-plugin.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- RES-01 属实，但建议从 P2 降为 P3：引用守卫/反扫/闭包 union 确实分散在多处：`packages/backend/src/services/agent.ts:338`、`packages/backend/src/services/agent.ts:359`、`packages/backend/src/services/agentDeps.ts:108`、`packages/backend/src/services/skill.ts:229`；`mcpClosure`/`pluginClosure` 结构也几乎同构（`packages/backend/src/services/mcpClosure.ts:33`、`packages/backend/src/services/pluginClosure.ts:35`）。这是扩展债，不是当前故障。

- RES-02 属实，P2 合理：MCP save 只查存在不查 enabled（`packages/backend/src/services/agent.ts:338-351`），plugin save 查 enabled 并报 `plugin-disabled`（`packages/backend/src/services/agent.ts:359-388`）；运行期二者都跳过 disabled（`packages/backend/src/services/runner.ts:1491-1505`）。

- RES-03 基本属实，P2/P3：plugin 支持 id 或 name 查询（`packages/backend/src/services/plugin.ts:58-66`），但 agent 引用存 name 并在 rename 时级联（`packages/backend/src/services/plugin.ts:239-273`）。这确实是“半稳定 id”模型。

- RES-04/RES-10 属实，P2：skill 路径真值分裂。`skillRoot` 对 managed 直接硬编码 `appHome/skills/{name}/files`（`packages/backend/src/services/skill.ts:72-75`），scheduler 却读 `managedPath`（`packages/backend/src/services/scheduler.ts:4427-4429`），版本系统也硬编码路径（`packages/backend/src/services/skillVersion.ts:46-57`）。

- RES-07 属实，P2：ZIP 写入直接改 `files/`（`packages/backend/src/services/skill-zip.ts:348-381`），insert/update row 不调用 `commitSkillVersion`（`packages/backend/src/services/skill-zip.ts:389-425`）；版本漏斗自称 single funnel（`packages/backend/src/services/skillVersion.ts:1-9`），又明确承认 ZIP 是 out-of-funnel writer（`packages/backend/src/services/skillVersion.ts:521-534`）。

- RES-12 属实但低危，P3：`JSON.parse(existing.frontmatterExtra !== undefined ? '{}' : '{}')` 确实是死代码/笔误残留（`packages/backend/src/services/agent.ts:159-165`），当前随后用 `fresh.frontmatterExtra` 覆盖，行为未见直接错误（`packages/backend/src/services/agent.ts:166-183`）。

- RES-13/RES-14 大体属实：ZIP commit 测试验证覆盖文件但不验证版本递增（`packages/backend/tests/skill-zip-commit.test.ts:102-133`），版本测试独立覆盖 editor funnel（`packages/backend/tests/skill-versioning.test.ts:140-213`）；MCP 有 disabled 注入过滤测试，但没有 agent save 阶段的 disabled 对称测试（`packages/backend/tests/runner-mcp-inject.test.ts:141-147`，`packages/backend/tests/agent-mcp-not-found.test.ts:51-108`）。

## REFUTED / 伪问题（给反证 file:line）

- RES-08 的“in-flight Map 键固定导致第二次复用第一次 Promise”不属实：`checkForUpdate` 直接调用的是 `installPluginInner`，绕过了 `installPlugin` 和 `inFlight` Map（`packages/backend/src/services/pluginInstaller.ts:131-160`、`packages/backend/src/services/pluginInstaller.ts:314-333`）。但它确有另一个低概率问题：`Date.now()` 目录名同毫秒可碰撞，见 MISSED。

- RES-09 证据偏弱，暂不应作为 bug 报告：安装前总是重写一个空 `package.json`（`packages/backend/src/services/pluginInstaller.ts:181-197`），然后执行单个 `npm install ... spec`（`packages/backend/src/services/pluginInstaller.ts:208-220`）。`keys[keys.length - 1]` 的注释是防御性 fallback（`packages/backend/src/services/pluginInstaller.ts:263-277`），报告没有证明 npm 单 spec 会写多个 direct deps。

- “skillRoot 是 managedPath 的 canonical 出口”表述不准确：`skillRoot` 本身也不读 `managedPath`，而是硬编码默认路径（`packages/backend/src/services/skill.ts:72-75`）。真实问题是 scheduler 是少数读取 `managedPath` 的路径，和 service/version 的硬编码发生漂移。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- Workflow validator 完全漏检 MCP 引用/disabled 状态 — Medium — `packages/backend/src/services/workflow.validator.ts:588-663` — 同一段只校验 skills 与 plugins（含 closure），没有对应 MCP 分支；因此 disabled/stale MCP 只会在运行期被静默跳过（`packages/backend/src/services/runner.ts:1491-1497`），validate workflow 不能提前提示，和 plugin 行为继续分叉。

- Plugin/MCP rename 会跨权限修改所有引用 agent — Medium — `packages/backend/src/routes/plugins.ts:124-127`、`packages/backend/src/services/plugin.ts:239-273`、`packages/backend/src/routes/mcps.ts:110-113`、`packages/backend/src/services/mcp.ts:130-165` — 路由只要求操作者拥有 plugin/MCP；service 会级联更新所有 `agents.plugins`/`agents.mcp`，包括操作者不可见/不拥有的 private agent。保持引用一致性可以理解，但这是 ACL 边界上的真实副作用，应有设计明示、审计事件或改为“被引用则拒绝 rename”。

- Skill source 列表泄漏所有注册目录路径 — Medium — `packages/backend/src/routes/skill-sources.ts:50-52`、`packages/backend/src/services/skill-source.ts:144-152` — 资源 ACL 对 agent/skill/mcp/plugin/workflow 做了过滤，但 `/api/skill-sources` 无 registrar/admin 过滤，任何用户可看到所有 source 的本机绝对路径、label、childCount/skipped 摘要。

- `checkForUpdate` 绕过 in-flight 且 probeDir 只用 Date.now — Low — `packages/backend/src/services/pluginInstaller.ts:314-333` — 同一插件同毫秒并发检查可能共用同一 `probeDir` 并同时写 `<probeDir>/<pluginId>.check`，报告指出的 Map 问题不对，但目录碰撞问题仍存在。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的“统一 ReferableResource + 依赖图 + 版本漏斗”方向基本合理，但过度把未来扩展成本定为 P1。当前更值得先修的是具体不变量：MCP/plugin enabled 对称、ZIP 进入 skill version funnel、skill 路径唯一出口、workflow validator 补 MCP 检查、rename 跨 ACL 副作用。

统一资源依赖图要谨慎：现有 RFC-097 状态机 CAS 与 scheduler 运行路径依赖 agent closure 的确定 BFS 顺序（`packages/backend/src/services/agentDeps.ts:59-97`）。若引入泛型图，必须先保留现有 agent closure 顺序和错误码，不要一次性替换调度核心。

稳定 id 引用是长期更优，但不应作为短期改造入口。设计文档仍写明 agent/skill 用 name 作 URL 标识（`design/proposal.md:546`），opencode 注入也天然按 name 工作；贸然把引用面全改 id 会引入迁移、导入导出、人类可读性和 YAML 兼容成本。更优先的中间态是：继续 name 引用，但 rename 被引用资源时要么拒绝，要么只允许系统级事务并产生审计事件。

版本漏斗抽象不应先泛化到所有资源。agent/mcp/plugin 是 DB 真值源，skill 是 FS 真值源；直接抽 `commitResourceVersion` 容易做成过厚框架。建议先把 ZIP 接入现有 `commitSkillVersion`，再单独为 agent body 做轻量 history 表，验证收益后再抽公共骨架。

## 总评（sound / mostly-sound / flawed + 一句理由）

mostly-sound：核心证据多数成立，尤其是 MCP/plugin enabled 分叉、skill 路径漂移、ZIP 绕过版本漏斗；但严重级偏激进，且 RES-08/RES-09 有证据错误或过度推断。
