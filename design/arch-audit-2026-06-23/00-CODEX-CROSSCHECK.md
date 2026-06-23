# Codex 交叉核验合并结论 (2026-06-23)

> 18 份研究结果（17 子系统 + 综合）各交一个**独立 Codex（GPT-5，只读）**对抗式核验：逐条打开源码核实证据、推翻夸大、补漏报告未发现的问题、批判重构建议是否破坏现有不变量。各份原文见同目录 `*.codex.md`。
> **总判定：18/18 全部 `mostly-sound`**——没有一份被判 `flawed`，也没有一份是无瑕的 `sound`。结论：**调研方向与主结构诊断整体成立，但需要一次"严重级校准 + 去夸大 + 补漏"**。

---

## 1. Codex 确认成立的（研究的脊柱站得住）

- **7 大系统性根因全部获独立确认**：公共原语被绕过各写一份且已漂移成 bug（T1）、单一事实源只接线 1/N 维（T2）、核心抽象未一等公民化的 god-module/巨石（T3）、状态机靠事后扫描+call-site 约定（T4）、横切扩展点无声明式注册表（T5）、单进程假设隐式焊死（T6）、知识载体腐化（T7）。
- **多个 P1 真漂移 bug 逐一证据落实**：`retryNode` 漏透传 commitPush（01）、opencode token 读错字段计量缺 ~15×（06）、fanout 把 `list<markdown>` 按 `\n` 误裂（03/05）、信封裸正则嵌套 `</port>` 截断（05）、融合状态机无 CAS（11）、多仓 worktree 治理缺陷（07）。
- **最优目标架构方向被判"比直接拆 scheduler 安全"**：先修漂移 bug → 统一状态写入 → 声明式 registry → 最后才 XL 级 `runScope` 统一；output-kind registry 作为"仓内最佳样板"应被推广——Codex 认同。

## 2. Codex 校准 / 推翻的（**别过度重构**——这些是有意设计或夸大严重级）

> 这一节最省事：避免把下面这些当 bug 去"修"，否则是反向回归。

| 报告 | 被推翻/降级项 | Codex 反证（有意设计或事实纠正） |
|---|---|---|
| 01 | `cancelTask` 的 `allowedFrom` "漂移" | 入口语义不同（无 controller 兜底 vs 已 claim 路径），非同语义漂移：`task.ts:940-971` / `scheduler.ts:4291-4305` |
| 01 | wrapper revival 缺 `failed` | 有意终态，测试锁定 `done/failed` 铸新行：`scheduler.ts:2592-2621` |
| 03 | "实现 estimateShardTotal 即可支持嵌套 fanout" | v1 是 validator warning + runtime hard reject 的**有意边界**，死字段不能当可启用缺口 |
| 03 | "需新建 list 编解码中心" | 中心已存在 `shared/listWire.ts`，真实漏点是 fanout 没复用它 |
| 06 | OCI-07（plugin_origins 已坏） | **被 opencode 1.17.8 源码反证**：运行时传的是 merged `cfg` 含派生态，读取未坏 |
| 08 | "语言 visibility 必须后端产出" | schema 明确 optional + 前端 heuristic fallback，是有意 best-effort |
| 10 | CHOKE-5（runner 不复查 ACL） | RFC-099 **明确接受**的失败模式（引用闭包隐式授权），是审计能力缺口非偏离 |
| 11 | MEM-04/05/07（单进程 lease、prompt 硬编码、clarify 收件箱泄漏） | 单 daemon 是 CLAUDE.md 明示约束；prompt 硬编码是可 grep-lock 的有意选择；复用 /clarify 是 RFC-101 设计 |
| 13 | "flock 锁"/"27 表都有 schema_version"/"migrate 应 skip" | 实为 PID-file `O_EXCL`（非 flock）；实为 34 表、仅 ~12 列有 schema_version；migrate 语义就是手动 apply |
| 17 | "status 四套并行"/"无源码层采用度锁"/"首页 empty 全手写" | StatusBadge/McpProbeChip 都已包 StatusChip；empty/loading/data-table guard 已存在；首页 InboxPreview 已用 EmptyState |
| 14/15 | 多处 P2 → 应降 P3 | 多为路线图未完成（撤销重做/自动布局）或单 daemon 约束，非现行回归 |

**净效果**：综合报告整体"略偏激进"——约 10–15% 的发现需把严重级下调或重标为"有意设计 / 路线图缺口"，尤其 11/12/13/14/17 的部分 P1/P2。

## 3. Codex **补漏**的新问题（研究未发现，多为更具体/更硬——最高价值）

> 这些应**并入路线图**。按性质分组，全部带 Codex 给的 file:line。

### A. 安全（新增，优先级高）
- **端口文件经 worktree 内 symlink 越界读取 worktree 外文件**（05，High）——`envelope.ts:122-132` 只做词法包含检查，注释声称防 symlink 实则未防，测试还锁定读出 `TOP SECRET`；与 `worktreeFiles` 的 realpath 防护不一致。
- **缓存仓原始 URL 含凭据却经 API 全量返回**（07 + 10 **两位 reviewer 独立撞到**，High）——`gitRepoCache.ts:181-186` / `cached-repos.ts:25-29`，任何 `repos:read` 用户可读 `url` 原文，前端只 redact 不补救 API 泄漏。
- **登录"constant-time"注释不成立 → 账号/状态枚举**（10，Medium）——`auth.ts:38-45`，未知/禁用用户直接 401、仅错误密码跑 Argon2，叠加无速率限制可计时区分。
- **`/api/skill-sources` 无 ACL 过滤，泄漏所有本机绝对路径**（12，Medium）——`skill-sources.ts:50-52`。
- **Plugin/MCP rename 跨 ACL 边界级联改写不可见 private agent**（12，Medium）——`plugin.ts:239-273` / `mcp.ts:130-165`。

### B. 正确性 / 数据丢失（新增）
- **GC 删除可 resume 的 failed/interrupted worktree**（07 + 综合，**P1 数据丢失**）——`gc.ts:23` / `task.ts:1000`，与"cancel/失败保留 worktree 供恢复"的承诺冲突。
- **cross-clarify 消费 stamp 未按 `loopIter` 隔离**（09，High 正确性）——`clarifyRounds.ts:132/159` 写时标记同节点所有 loop_iter 的 answered，读路径却按 loopIter 过滤 → 后续轮次 External Feedback 被提前老化丢失。
- **复制 wrapper 后 `nodeIds` 未重写 + fanout 边丢 `boundary` 元数据**（14，High 数据破坏）——`canvasClipboard.ts:74-94`，粘贴出的 wrapper 仍引用原 child id，"删除含 inner"会误删原节点。
- **远端更新静默覆盖本地 dirty 草稿**（14，High）——`useWorkflowSync.ts:47-55` 注释承诺不 clobber，但 `workflows.edit.tsx:217-233` refetch 后无 dirty guard 直接 setDraft。
- **fanout aggregator 可接 wrapper boundary-input，validator 放行但运行时空输入**（03，High，green 但错数据）——`workflow.validator.ts:1307-1329` / `scheduler.ts:3731-3752`。
- **node/edge ID 唯一性从未校验**（04，P1 模型不变量）——`schema` 只要非空，`Map(node.id)` 重复会覆盖、错调度。
- **内置融合资源可被同名用户资源 shadow（无 owner 校验）+ 审批 ACL 未按设计复检技能写权/记忆管理权**（11，两条 P1）——`fusion.ts:182-210` / `fusion.ts:141-143`，违反 `systemResources.ts` 自己的 name+owner 判定，且权限撤销后旧 owner 仍可 approve。

### C. 接线漂移（**坐实并锐化了 T1**）
- **REST 入口不传 commit&push / `maxConcurrentNodes` 配置**（01 + 02，P1/P2）——`routes/tasks.ts:250-258/376-383/445-456`：service 层支持透传，但 start 之外的 resume/repair/retry 都不传，`maxConcurrentNodes` 更是**全生产路径未接线**，只有测试直调生效 → 线上恒走默认值。这是"原语存在但调用方绕过"的最硬实例。

### D. 不变量纠正（影响重构约束）
- **`OPENCODE_CONFIG_CONTENT` 并非绝对最高优先级**（06）——opencode 1.17 在其之后还合并 macOS managed preferences；企业/MDM 环境下同名 agent 仍可能覆盖平台注入。应作为启动期诊断或文档化限制，停止宣称"绝对最高"。
- **完整 user prompt 走 argv，长 prompt 会 E2BIG 启动失败**（06，High）——`runner.ts:633-690` / `memoryDistiller.ts:615-707`；统一适配层若不改传输方式（确认 opencode 是否支持 stdin/file prompt，否则加 size guard）解决不了。

### E. 前端 UI（扩展了"可抽取公共组件"答案）
- **account 是第 4 套 form-input chrome**（16，P1）——`account.tsx:138` `.account-form`，报告只数了三套。
- **登录页 submit 绕过 `.btn` 系统**（16，P2）；**account PAT 状态直写 `status-chip` 绕过 `<StatusChip>`**（16，P2）。
- **Workflow import 冲突用原生 `window.prompt`**（17，P2）——`workflows.tsx:49-52`，无法复用 Dialog a11y。
- **ACL 弹窗 loading/error 直接 `return null` → 空白弹窗**（17，P2）；**InboxDrawer 自写 dialog chrome 不走公共 `Dialog`**（17，P2，比 error-box 更高 a11y 风险）。
- **memory inbox/badge 实时性断层 + fusion 进 inbox 后测试只覆盖 review/clarify**（15，P2 多条）。

## 4. 对路线图的净影响

1. **rank 1（P1 漂移急修批）扩容**：并入 Codex 新发现的 P1——REST 配置未接线（01/02）、GC 删可恢复 worktree（07）、cross-clarify loopIter 隔离（09）、copy/paste 数据破坏 + dirty 覆盖（14）、node/edge id 唯一性（04）、融合资源 shadow + 审批 ACL 复检（11）。
2. **新增"安全急修"小批**（原报告权重不足）：端口 symlink 越界（05）、缓存仓凭据 URL 泄漏（07/10）、skill-sources 路径泄漏（12）、登录计时枚举（10）。
3. **rank 6（OpencodeProcess 适配层）增加两条硬约束**：传输方式必须解决 argv E2BIG；`OPENCODE_CONFIG_CONTENT` 优先级文档化纠正。
4. **重构护栏（综合 §5 硬规则）被 Codex 加固为不可破坏项**：RFC-097 CAS 所有权锁必须在 rollback/kick 之前；`allowTerminal` 等逃生口要显式建模、别被泛化 `trySetStatus` 掩盖；RFC-099 prompt 隔离作为资源注册表重构的硬测试；`dbTxSync` 只能同步 body、WS publish 改事务后 hook。
5. **严重级校准**：11/12/13/14/17 中约 10–15% 的 P1/P2 应按 §2 下调为"有意设计 / 路线图缺口 / P3 硬化"，避免过度重构。

---

## 附. 各份判定一览（全部 mostly-sound）

| 报告 | Codex 一句话 |
|---|---|
| 01 生命周期 | 主问题扎实，但部分 allowedFrom 特例是有意；漏 retryNode 校验顺序、HTTP 入口配置透传 |
| 02 调度器 | god-module/per-task sem/fanout 重复成立；漏 maxConcurrentNodes 全路径未接线 |
| 03 fanout | 主证据真实；部分 v1 有意禁入被写成 bug；漏 aggregator 空输入、kind 不兼容 |
| 04 工作流模型 | 高风险 drift 抓准；YAML/schema bump 目标说太硬；漏 node id 唯一性 |
| 05 端口/kind | 核心问题成立；漏 symlink 越界读取（安全）；少数低价值债同列 |
| 06 opencode | 核心风险充分；OCI-07 被源码反证；漏 argv 大 prompt E2BIG |
| 07 git/worktree | 主线抓准；部分回滚结论过期；漏缓存仓引用计数失效、GC 删可恢复 worktree |
| 08 结构化 diff | 识别准确；部分 best-effort 被当缺陷；低估 extractSymbols 重构复杂度 |
| 09 clarify/review | 主债与多缺陷成立；少数有意设计被当问题；漏 cross-clarify loopIter 隔离 |
| 10 ACL/认证 | 核心高风险成立；少数已接受不变量被当问题；漏缓存仓凭据 URL、登录计时 |
| 11 记忆/融合 | 多数证据成立；部分有意设计误判为泄漏；漏内置资源 shadow、审批 ACL 复检 |
| 12 资源管理 | 核心成立；严重级偏激进；RES-08/09 证据错误/过度推断 |
| 13 DB/基础设施 | 主方向成立；表数量/schema_version/flock 表述过期或夸大 |
| 14 画布编辑器 | 主架构债抓准；几处路线图缺口被当现行违规；漏 copy/paste + dirty 覆盖 |
| 15 数据层 | 缺统一订阅模型成立；几处夸大实时缺口；漏 memory inbox key、fusion 测试断层 |
| 16 UI 系统 | 缺组件入口与强制力成立；测试/i18n 现状有过期；漏 account/auth/status-chip 漂移 |
| 17 路由/业务 | 核心成立；严重级偏高、测试锁表述过度；漏 inbox memory 吞错、ACL 空弹窗、window.prompt |
| 00 综合 | 主结构病灶与 P1 成立；少量夸大；漏 GC 删可恢复 worktree、权威文档漂移 |
