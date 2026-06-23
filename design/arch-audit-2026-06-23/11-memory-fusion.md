# 记忆 / 蒸馏 / 融合 — 架构审计 (2026-06-23)

> 子系统 key=11-memory-fusion。范围：记忆状态机（含 fused 终态）、蒸馏调度与作业、记忆注入、记忆→技能融合引擎。
> 只读审计。证据均为相对仓库根的 file:line。与既有审计重叠处已标注。

## 0. 健康度一句话

记忆长链（RFC-041~050）已是相当成熟、防御性极强的子系统（live-read 注入、快照冻结、dbTxSync 原子化、降级不 5xx 都做得到位）；真正的架构债集中在**融合引擎（RFC-101）以「后门复用 task/scheduler」换取的快速落地**——它引入了一台**没有 CAS 守卫的并行状态机**、**永不回收的临时仓**、以及一条**会把融合自身 clarify 反喂蒸馏的递归记忆回路**，这三处是本子系统当前最该补的结构性缝。

## 1. 当前架构与职责

记忆子系统由三条相对独立的管线组成，共享 `memories` 表与 `MemoryStatus` 状态机（candidate→approved→{archived|superseded|fused|rejected}）：

1. **蒸馏管线**（写候选）：clarify/review/feedback 三类事件经 `enqueueDistillJob` 入队（5s debounce + scopeResolved 快照），daemon 1Hz `distillTick` 合并同 debounceKey 的 siblings、spawn 一个 system opencode agent（`aw-memory-distiller`，非 DB 行、OPENCODE_CONFIG_CONTENT 注入），解析 `candidates` 端口落候选行；失败指数退避 3 次后 permanent failed。
2. **注入管线**（读 approved）：runner 每次 runNode 调 `injectMemoryForRun`，按 agent-closure/workflow/repo/global 四 scope 拉 approved 记忆，按 token budget 截断（recency-only），渲染 `--- BEGIN INJECTED MEMORY ---` 块追加到主 agent inline prompt，并把 post-clip 集快照进 `node_runs.injected_memories_json`（RFC-046/047）。
3. **融合引擎**（消费 approved → 写技能 + 标 fused）：`createFusion` 校 ACL → 播种临时 git 仓（拷技能 files/）→ 经 `preCreatedWorktree` 后门 `startTask` 跑内置 `aw-skill-fusion` 工作流（强制 clarify + `aw-skill-merger` agent 原地改文件 + 写 manifest）→ 任务终态时 `reconcileFusion`（懒触发 + 60s tick）算 diff 入 awaiting_approval → approve 走 `commitSkillVersion`（OCC + txExtra 原子 `fuseMemoriesTx`）/ reject 重跑。

**关键文件**：`services/memory.ts`（CRUD + 状态机 + fuse/unfuse + RFC-099 scope ACL）、`memoryDistiller.ts`（prompt/spawn/parse/persist，1258 行）、`memoryDistillScheduler.ts`（enqueue + 1Hz tick + backoff）、`memoryInject.ts`、`distillerSourceContext.ts`（RFC-044 render+clip 纯函数）、`distillSessionCapture.ts`（RFC-043 capture，自承认 90% 抄 sessionCapture）、`fusion.ts`（849 行，融合状态机 + 后门复用）、`shared/schemas/{memory,fusion}.ts`、`routes/{memories,memoryDistillJobs,fusions}.ts`、`systemResources.ts`（built-in 隐藏单一事实源）。

## 2. 设计问题（Design）

**[MEM-01] 融合状态机无 CAS，与 RFC-097 任务状态机的硬约束公开背离** — 级别 P1｜类型 design/impl-bug｜证据 `services/fusion.ts:70-82`（定义并 export `FUSION_TRANSITIONS` + `isValidFusionTransition`）vs `services/fusion.ts:620-630`（`setFusionStatus` 是裸 `db.update(...).set({status})`，无 `where(status=from)` 守卫）｜影响：CLAUDE.md 把「状态写必须走 CAS 转移表」列为架构硬约束（RFC-097，`trySetTaskStatus`，s14 守卫禁直写），但融合自建了一台**形似而神不似**的状态机：转移表存在却**从未被任何写路径调用**（`grep isValidFusionTransition` 全仓零调用点，仅测试断言纯函数）。`approveFusion`（648 读 status / 658 写 applying）、`rejectFusion`（728/791）都是「先 SELECT 判 status，再无条件 UPDATE」的 check-then-act，两次并发 approve / approve+reject 都能各自通过 status 检查。技能层有 `commitSkillVersion` 的 OCC 兜底（见 MEM-02），但 reject 路径、cancel 路径、reconcile 与 approve 的竞态都裸奔——例如 60s reconcile tick 把某 fusion 从 running 推 awaiting_approval 的同时用户 cancel，两个 `db.update` 互相覆盖，最终态不确定。｜建议：要么给融合也上 `trySetFusionStatus(allowedFrom, to)`（CAS：`UPDATE fusions SET status=to WHERE id=? AND status IN(allowedFrom)`，返回 changes>0），让 `isValidFusionTransition` 真正成为写闸；要么删掉这张「假装在守卫」的死代码转移表（它给读者错误的安全感，比没有更危险）。优先前者。

**[MEM-02] 「approve = applying」原子性靠技能 OCC 间接兜底，融合侧自身可留半态** — 级别 P2｜类型 design｜证据 `services/fusion.ts:640-709`（approveFusion 内 `setFusionStatus(applying)` 与 `commitSkillVersion` 之间无事务包裹）｜影响：`commitSkillVersion` 的 `expectedVersion=baseSkillVersion` OCC（`skillVersion.ts:293-298`）确实能挡住「技能漂移」与「双 approve 第二次」（第二次时 N≠base→conflict）；`fuseMemoriesTx` 也在同 tx 内（`memory.ts:596-626`，只动 approved 行、幂等）。但融合**行自身**的 `status='applying'` 写在 tx 外（658），若进程在 `commitSkillVersion` 抛非 conflict 错（如磁盘满）后、`failFusion` 前崩溃，融合永久卡 `applying`——而 `applying` 不是 `running`，**reconcile 不碰它**（`reconcileFusion:439` 只处理 running），也没有任何 recover-applying 路径（对比蒸馏有 `recoverRunning`，任务有 RFC-097 interrupted）。该态对用户表现为「卡住、无法 cancel」（cancel 在 822 拒终态但 applying 非终态、可 cancel，勉强有退路，但语义混乱）。｜建议：approve 的「applying 标记 + commit + done/fail」三步要么进一个 dbTxSync（commitSkillVersion 已是 dbTxSync，可把状态写折进 txExtra/包一层），要么给 `applying` 加 reconcile 兜底（启动时把孤儿 applying 视作 failed 或重新评估）。

**[MEM-03] 注入是纯 recency 截断，完全忽略蒸馏精心生产的 category/tags/scope-relevance** — 级别 P2｜类型 design｜证据 `memoryInject.ts:286-301`（`clipByBudget` 按 createdAt DESC 走到 budget 溢出即砍）+ 蒸馏强制每条带 `[category:xxx]` 前缀与 tags（`memoryDistiller.ts:87-141`）｜影响：蒸馏侧投入大量 prompt 工程让模型给每条记忆打 10 类 category + 语义 tags + scope 绑定，**但注入侧一个字段都不用**——既不按 task 内容做相关性筛选，也不优先注入 invariant/compliance 这类「硬规则」而压低 convention 这类「软偏好」，纯按时间新旧填预算。结果：一个 repo 攒到几十条 approved 记忆后，注入的就是「最近 N 条」而非「最该让本 agent 看到的 N 条」，老的关键 invariant 会被新的琐碎 convention 挤出预算（`clipByBudget` 砍尾=砍最老）。这是「数据生产远超数据消费」的设计断层。｜建议：注入至少引入 category 优先级权重（invariant/compliance/data-semantics 优先于 convention/quality-bar），中期可按 task 的 workflow/agent 标签做 tag 重叠加权。这是 RFC 级改动，先记账。

**[MEM-04] 蒸馏调度器是单进程内存 worker，与「daemon 单实例」假设深度耦合，无租约** — 级别 P2｜类型 design/extensibility｜证据 `memoryDistillScheduler.ts:1-12`（注释明示「不 lease，单 daemon 单 in-process worker」）+ `recoverRunning:400-417`（启动/stop 时把所有 running 无条件刷回 pending）｜影响：`distillTick` 的「SELECT pending → UPDATE running → run → UPDATE done」没有 `WHERE status='pending'` 的 CAS 抢占（281-284 直接按 id 批量改），依赖「只有一个 tick 在跑」。若未来要水平扩展 daemon（多实例 / HA），两个实例的 tick 会同时捞到同一批 pending 并双跑同一蒸馏（重复 spawn opencode、重复落候选）。`recoverRunning` 更危险：它把**任意** running 行刷回 pending，多实例下会把另一实例正在跑的作业打回（=另一份重复 spawn）。融合的 `reconcileRunningFusions` 同理无锁（`fusion.ts:523-536`）。｜建议：当前单实例语义下不是 bug，但要在 STATE/设计里把「这俩 loop 绑死单实例」标成显式约束；任何 HA RFC 必须先给 distill_jobs / fusions 上行级租约（`leased_by` + `lease_expires_at` + CAS 抢占）。

**[MEM-05] 蒸馏 prompt（system + 10 类 category + 语言指令）硬编码在 .ts 源码里，升级=改代码+发版** — 级别 P3｜类型 design/extensibility｜证据 `memoryDistiller.ts:81-166`（DISTILLER_SYSTEM_PROMPT 86 行硬编码，且被 hash baseline + grep guard 锁死）｜影响：注释把「prompt 在源码 = 升级走 PR」当优点（可 grep、可 review），对**框架自身**合理；但对一个「部署到各种业务域」的平台，category 体系（域术语/不变量/合规…）和语言策略其实是**部署级偏好**，不同客户想加自己的 category（如 `[category:security-control]`）就得改框架源码。这是「框架 prompt vs 业务可配 prompt」的边界没划清。｜建议：v1 可接受；若出现「客户想定制 category」需求，应把 category 列表抽成配置（settings 或 per-deploy file），system prompt 骨架仍锁源码。记账，非紧急。

## 3. 实现问题 / Bug（Impl）

**[MEM-06] 融合临时仓 `appHome/fusions/{id}/iterN/work` 永不回收，磁盘单调增长** — 级别 P1｜类型 impl-bug/perf｜证据 `fusion.ts:274-276`（`fusionWorkDir`）+ 全仓 `grep -iE "rm|clean|gc|delete" 命中 fusions 目录 = 0`（无任何清理代码）+ RFC-101 design.md:304 声称「融合 done/failed/canceled 后由 worktree GC 或 fusion 清理回收」｜影响：设计文档明确承诺了 GC，但**实现里根本不存在**这条 GC。每次 createFusion 建 `iter1/work`、每次 reject 建 `iterN/work`（reject 还会先拷整份技能 files/ 再覆盖上一版 proposal，761-768），全是完整 git 仓（含 `.git`）。done/failed/canceled 后这些目录全部留在盘上，永久累积。融合是「N 个记忆合 1 技能」的高频运维动作，长期跑必然把 `~/.agent-workflow/fusions/` 撑爆。注意这跟普通任务 worktree 不同：普通任务 worktree 在 `worktrees/` 下、有 RFC 提到的 GC 路径覆盖；融合仓在独立的 `fusions/` 目录，**不在任何 GC 扫描范围**。｜建议：终态融合（done/failed/canceled）应在状态落定时 `rmSync(join(appHome,'fusions',id), {recursive,force})`（proposed 已 copy 进 skill version snapshot，approve 后不再需要工作树；reject 重跑前也已把上一版拷进新 iter）；或在 daemon hourly background 加一条 fusions GC。务必同时修正 design.md:304 的失实承诺。

**[MEM-07] 融合引擎任务出现在普通 `/api/tasks` 列表 + clarify 收件箱，泄漏框架内部噪音** — 级别 P2｜类型 impl-bug/coupling｜证据 `task.ts:1471-1511`（listTasks 无 built-in 工作流过滤）+ `systemResources.ts`（只过滤 /agents、/workflows 列表，**不过滤 tasks**）+ `fusion.ts:395-405`（startTask 以 actor.user.id 为 owner 建真实任务）｜影响：融合内置工作流/agent 在列表里被 `excludeBuiltinWorkflows/Agents` 隐藏了，但它驱动的**任务行**没被隐藏——用户在 `/tasks` 会看到一堆 `fuse → {skill}` 的任务，点进去是个跑内置 `aw-skill-fusion` 工作流的怪任务；而且融合强制 clarify，那一轮 clarify 会进 clarify 收件箱（任务 awaiting_human），用户在收件箱看到「请确认融合目标」的反问，但融合本该走 `/fusions` 专属 UI 审批。这是「借任务引擎跑融合」这条后门复用泄漏到了所有以任务为中心的 UI 面（list/inbox/badge）。｜建议：给 tasks 加 built-in 工作流过滤（复用 systemResources 的 isBuiltin 判定，按 task.workflowId→workflow.name+owner 判定），在 listTasks / clarify-inbox / pending-badge 统一排除融合任务；或给 task 行加 `kind='fusion'` 标记让前端归类。

**[MEM-08] 融合自身的强制 clarify 反喂蒸馏 → 记忆从融合再生记忆的递归回路** — 级别 P2｜类型 impl-bug｜证据 `clarify.ts:558-568`（answerClarify 无条件 `enqueueDistillJob({sourceKind:'clarify'})`）+ 融合工作流定义含 clarify 节点（`fusion.ts:231,246-253`）+ 融合 prompt 强制至少一轮 clarify（`fusion.ts:154-155`）｜影响：融合任务必然产生一个 clarify session，answerClarify 不区分任务来源，照常入蒸馏队列。于是「merger 问『要不要把这两条记忆合并』+ 用户答『合并』」这段 Q&A 会被蒸馏成**新的候选记忆**——内容是关于「如何融合记忆」的元 Q&A，对业务毫无价值，污染候选审批队列。极端情况下融合越多、垃圾候选越多。`computeEligibleScopes` 还会把融合任务的 repo（临时仓，repoUrl=null）和 agent（隐藏的 aw-skill-merger）算进 scope，scope 解析基本是空，候选大多落 global，更扎眼。｜建议：`enqueueDistillJob` 入口（或 answerClarify）排除 built-in 工作流的任务（与 MEM-07 同一过滤源）；蒸馏不该消费框架自身产生的事件。

**[MEM-09] OQ-6 已知限制：restore 跨融合版来回，记忆停 approved 但知识已回技能 = 轻度重复注入** — 级别 P3｜类型 impl-bug（已知）｜证据 `memory.ts:633-662`（`unfuseMemoriesTx` 只解 `fusedIntoSkillVersion > aboveVersion` 的记忆）+ RFC-101 design.md:439（OQ-6 自述）｜影响：先 restore 到融合版以下（解融合某记忆→approved，**清空溯源**）再 restore 回该融合版，因溯源已清无法自动重融，记忆停 approved 但其知识已在技能里 → 该知识既被注入（approved 记忆）又在技能里 = 轻度重复。非数据丢失，已被 RFC-101 OQ-6 覆盖、有代码注释。｜建议：维持现状记账；完整修法（skill_versions 记录每版吸收的 memory ids，restore 按 target 版集合重融）留后续 RFC，已在 OQ-6 写明。**本审计仅交叉印证其仍未修。**

**[MEM-10] sessionID 抽取双份实现 guard 不一致（已被 dedup-audit 覆盖，此处印证危害落在蒸馏侧）** — 级别 P3｜类型 impl-bug/coupling｜证据 `memoryDistiller.ts:792-832`（extractEventText）+ `memoryDistiller.ts:1127-1145`（extractFirstSessionIdFromStdout）vs `runner.ts` 对应函数；dedup-audit-2026-06-13.md:53 第 7 项明确指出两份 sessionID 抽取「guard 不一致（runner 无 length>0 会 latch 空串）」｜影响：蒸馏侧 `extractFirstSessionIdFromStdout:1141` 有 `candidate.length>0` 守卫（正确），runner 侧没有；两者自称 lockstep 但已漂移。落在蒸馏侧的具体危害：若 runner 漂移导致空 sessionId 被 latch，RFC-043 session capture 会抓错根 session。｜建议：已被 dedup-audit 覆盖（§建议抽 `opencode-event-extraction` 公共原语），此处仅强调蒸馏与 runner 必须共用同一抽取器，否则 RFC-043 capture 与 worker capture 长期漂移。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 重点

**[MEM-EXT-01] 新增一种「记忆源」要碰 ~13 处，无中央 source-kind 注册表** — 触发场景：半年后想把「commit message / PR 评论 / 外部 issue / agent 运行失败摘要」也蒸馏成记忆（产品方向上极可能）。｜根因：`sourceKind: 'clarify'|'review'|'feedback'` 这个三值 union 被手抄/硬编码在至少 13 处（`grep` 命中：schemas/memory.ts 枚举、db/schema.ts 列、memoryDistiller.ts 的 LoadedSourceEvents 三字段 + loadSourceEvents 三分支 + buildDistillerUserPrompt 三段、memoryDistillScheduler.ts buildDebounceKey、memoryDistillJobDetail.ts safeLoadSourceEvents 三分支 + deepLink 三模板、enqueue 三调用点 clarify.ts/review.ts×3/taskFeedback.ts）。每种源各有：DB 表、id 列、加载 SQL、prompt 渲染段、detail 摘要+deepLink、enqueue 触发点。｜现在加功能要碰：枚举（shared）+ 列约束（schema/migration）+ `LoadedSourceEvents` 加字段 + `loadSourceEvents` 加分支 + RFC-044 source-context 加载（若新源有 transcript）+ `buildDistillerUserPrompt` 加渲染段 + `safeLoadSourceEvents` 加分支 + deepLink 模板 + 新 enqueue 调用点。一处漏改 = 该源的候选缺上下文或 detail 页空白。｜目标形态：定义 `MemorySourceProvider` 接口（`kind`、`loadEvents(ids)`、`renderForPrompt(ev)`、`summarize(ev)→{summary,deepLink}`、`enqueueHook`），各源实现一个 provider 注册进 registry；distiller/detail/scheduler 遍历 registry 而非 switch。新源 = 加一个 provider 文件 + 注册一行。

**[MEM-EXT-02] 融合「借任务引擎」是后门复用，每个任务侧新能力都要回头适配融合** — 触发场景：任务侧加新功能（多仓、新 wrapper、任务级 RBAC 收紧、worktree GC、任务归档、新生命周期态），或想让融合支持「无 clarify 的快速模式 / 批量融合多技能」。｜根因：`createFusion` 经 `preCreatedWorktree`（RFC-020 为 multipart upload 设计的口子）+ 伪造 `repoPath=临时仓` 来满足 StartTask schema（`fusion.ts:384-405`），把融合塞进任务引擎。这是「为复用 scheduler/runner/git-wrapper 而把融合伪装成任务」，但融合不是任务：它没有真 repo、它的 worktree 在独立目录不受任务 GC 管（MEM-06）、它出现在任务 list/inbox（MEM-07）、它的 clarify 反喂蒸馏（MEM-08）。每一处「任务引擎的隐含假设」（worktree 在 worktrees/、任务该被列出、clarify 该被蒸馏）都成了融合的隐 bug。｜现在加功能要碰：任务引擎任何改动都得问「融合这条后门会不会被波及」；融合想加批量/无-clarify 模式得改内置工作流定义 + reconcile diff 逻辑 + manifest 契约。｜目标形态：把「在临时 git 仓里跑一个 agent、产出 worktree diff」抽成 task/fusion 共用的**显式** primitive（如 `runAgentInEphemeralRepo({seedDir, workflow, inputs}) → {taskId, worktreePath, diff}`），融合调它而非伪造任务；该 primitive 自带「不进任务 list / 不喂蒸馏 / 临时仓自清理」的语义，让后门复用变成有契约的复用。

**[MEM-EXT-03] 注入侧四 scope（agent/workflow/repo/global）硬编码，加新 scope 维度要散改注入+蒸馏+ACL** — 触发场景：想加「team scope / org scope / per-task ephemeral scope」或「按 tag 集合的虚拟 scope」。｜根因：四 scope 在 `memoryInject.ts:loadInjectableMemories`（四段独立 SQL + byScope 四字段 + formatMemoryBlock 四段拼接）、`memoryDistiller.ts:loadScopeContexts`（四 if）、`memory.ts` 的 RFC-099 scope ACL（`loadScopeAclRow` 只认 agent/workflow，repo/global 写死规则，`canViewMemory/canManageMemory` 硬编码 repo||global 分支）全部硬编码。scope 是个本该多态的概念却被四处 switch 实现。｜现在加功能要碰：MemoryScope 枚举 + 注入四段 + 蒸馏四 if + ACL 三函数的硬分支 + budget 四字段（ScopeBudget）+ 前端 scope picker。｜目标形态：`MemoryScopeKind` 注册表，每 scope 提供 `resolveIds(task)`、`aclRow(id)`、`visibilityRule`、`injectBudgetDefault`；注入/蒸馏/ACL 遍历注册的 scope kinds。至少先把 `canViewMemory/canManageMemory` 的 repo/global 硬分支抽成数据驱动表。

**[MEM-EXT-04] 蒸馏候选「写入即固定形态」，加新候选属性（如 confidence/expiry/embedding）要改 prompt+parse+schema+persist+inject 全链** — 触发场景：想给记忆加「置信度评分」「过期时间」「向量 embedding 用于相关性注入（见 MEM-03）」。｜根因：候选形态在 `DISTILLER_SYSTEM_PROMPT` 的 JSON shape（硬编码字符串）、`RawCandidate` 接口、`MemorySchema`、`validateAndPersistCandidate` 的 insert、注入 snapshot 五处各写一遍，无单一形态源。｜现在加功能要碰：prompt JSON 描述（且被 hash baseline 锁，改它要更新 baseline）+ RawCandidate + MemorySchema + insert values + InjectedMemorySnapshot + node_runs 列。｜目标形态：候选字段集中定义一次（zod schema 派生 prompt 描述片段 + insert 列），prompt 的 JSON shape 段由 schema 自动生成而非手写字符串，杜绝「prompt 描述与 schema 漂移」。

**[MEM-EXT-05] capture 子系统自承认 90% 复制 sessionCapture，第三个 capture owner 会逼出三份** — 触发场景：融合 merger 的 opencode session 也想被捕获展示（目前融合 session 没有 RFC-043 式 capture），或任何第四类 spawn-and-capture。｜根因：`distillSessionCapture.ts:1-9` 注释明示「near-90% copy of captureChildSessions，不抽象因为 node_runs 与 distill_jobs schema 不同；第三个 owner 出现时再 revisit」。这是被记账的技术债，但融合 session capture 正是那个「第三 owner」的诱因。｜现在加功能要碰：要给融合加 session 展示，要么第三次抄 capture，要么此刻动手抽象。｜目标形态：抽 `captureOpencodeSession({rootSessionId, sink: (events)=>void})` 核心，owner 差异（落哪张表、attemptIndex vs retryIndex）由 sink 适配器吸收。dedup-audit 的 `inflight-dedup-and-captured-subprocess` / `parse-session-tree-adapter` 簇与此相关。

## 5. 耦合 / 分层违规

**[MEM-11] `fusion.ts` 作为 orchestrator 反向依赖 5 个 service，模块环靠「无人 import 回来」的口头约定维系** — 级别 P2｜类型 coupling｜证据 `fusion.ts:13-15,35-42`（import agent/skill/skillVersion/memory/task/workflow/lifecycle 七个 service，注释自辩「nothing the runtime imports imports fusion.ts back」）｜影响：融合是叶子 orchestrator 没错，但它直接 import 了 task.ts 的 `startTask/cancelTask/StartTaskDeps`、lifecycle 的 `trySetTaskStatus`、skillVersion 的 `commitSkillVersion` 内部 + memory 的 `fuseMemoriesTx` 内部。其中 `trySetTaskStatus` + `cancelTask` 的组合（`fusion.ts:825-845` cancel 时手动判任务态再选 cancelTask 或 trySetTaskStatus）说明融合**绕过了任务取消的统一入口**，自己拼了一套「awaiting_human/review 时直接 CAS 终态」的逻辑——这是因为 cancelTask 拒绝 parked 态（825-828 注释）。任务取消语义被复制进了融合。memory.ts 也被 binary-build module-cycle 历史（MEMORY.md reference_binary_build_module_cycle）证明对环很敏感。｜建议：cancel 的「parked 任务终态化」应是 task/lifecycle 的公共能力（如 `forceTerminateTask`），融合调它，而非在 fusion.ts 复刻 trySetTaskStatus 调用。

**[MEM-12] `memory.ts` 文件中段 `import` 把 RFC-099 ACL 逻辑塞在文件 684 行处（运行时 import 在文件中部）** — 级别 P3｜类型 coupling/整洁｜证据 `memory.ts:684-692`（`import type {Actor}` / `import {canViewResource...}` 出现在第 684 行，文件中部而非顶部）｜影响：纯整洁问题——RFC-099 D12 的 scope ACL（canViewMemory/canManageMemory/filterMemoriesByScopeVisibility/annotateMemoryManageRights）被追加在 CRUD 之后，import 也随之落在中段。可读性差、易被误以为是两个文件。这 5 个 scope-ACL 函数也正是 dedup-audit `memory-scope-acl-resolution`（5 站）想抽的簇。｜建议：import 提顶；scope-ACL 段考虑拆 `memoryAcl.ts`，与 dedup-audit 建议合流。

## 6. 测试 / 可观测性缺口

**[MEM-13] 融合无并发 approve / 双 reconcile / cancel-race 测试，CAS 缺失无回归网** — 级别 P2｜类型 test-gap｜证据 `tests/fusion-engine.test.ts` 仅覆盖 happy path / OCC-conflict / manifest-omit / 状态机纯函数（114-279），无任何并发或竞态用例｜影响：MEM-01/MEM-02 的竞态（双 approve、reconcile vs cancel、孤儿 applying）完全没有测试锁定。CLAUDE.md 的 test-with-every-change 要求 bug 修复先写红测试；这些竞态目前连暴露用例都没有。`isValidFusionTransition` 测了纯函数但没测「它实际守卫了写」（因为它根本没守卫，见 MEM-01）。｜建议：补「awaiting_approval 下并发两次 approve → 一次 done 一次 conflict 且技能只 bump 一次 + 记忆只 fused 一次」「reconcile 与 cancel 交错 → 终态确定」用例；这些用例会直接逼出 MEM-01 的 CAS 修复。

**[MEM-14] 蒸馏/融合的运维可观测性薄：失败计数、积压、临时仓占用无指标** — 级别 P3｜类型 observability｜证据 全文 `createLogger` + WS broadcast，但无 metrics/计数器导出；融合临时仓占用（MEM-06）无任何上报；distill 队列积压（pending 堆积）只能逐行查 DB｜影响：单实例小规模可用 log 兜，但「蒸馏连续失败」「fusions 目录吃满磁盘」「pending 队列堆积到 backoff 永远追不上」这类运维信号没有聚合面。distill 有 last_error 落行（好），但没有「最近 N 次蒸馏成功率」「队列深度」的聚合。｜建议：daemon background check（已有 resource-limit 1Hz）顺带统计 distill pending 深度 + fusions 目录大小，超阈值 warn；这是低成本高价值的运维护栏。

## 7. 目标形态（Target architecture）

理想的记忆/蒸馏/融合子系统应满足：

1. **统一状态机基座**：融合状态写走与任务同源的 CAS 原语（`trySetStatus(table, id, from[], to, extra)`），`isValidFusionTransition` 成为该原语的转移表参数而非装饰性死代码。任务/融合/蒸馏三台状态机共享同一 CAS 实现与同一「孤儿恢复」框架（running/applying 孤儿在启动时统一 reconcile）。
2. **source-kind / scope-kind 注册表化**：记忆源与 scope 维度从「散落 13 处的 switch」收敛为两张 provider 注册表，新增源/scope = 加一个 provider + 注册一行，distiller/inject/detail/ACL 全部遍历注册表。
3. **融合不再伪装成任务**：抽 `runAgentInEphemeralRepo` 显式 primitive（seed→run→diff），自带「不进任务面 / 不喂蒸馏 / 终态自清临时仓」契约；融合、未来的「沙盒 agent 试跑」等都复用它。任务引擎的新能力不再隐式波及融合。
4. **注入消费追上生产**：注入引入 category 优先级 + tag 相关性加权（中期上 embedding），让蒸馏精心打的标签真正影响「让 agent 看到哪些记忆」，而非纯 recency 填预算。
5. **capture 单实现**：一份 `captureOpencodeSession` 核心 + sink 适配器，worker/distill/融合三 owner 共用，杜绝「90% 抄」漂移。
6. **运维护栏**：daemon 周期统计 distill 队列深度 + fusions 磁盘占用 + 蒸馏成功率，超阈值告警；fusions 目录纳入 GC。

落地次序建议：先补 MEM-01 CAS + MEM-06 GC + MEM-07/08 任务面/蒸馏排除（P1/P2、低风险高收益、可独立 PR），再做 source-kind 注册表（EXT-01，纯重构）与 runAgentInEphemeralRepo（EXT-02，结构性、需 RFC），最后做注入相关性（MEM-03/EXT-04，产品级 RFC）。

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 级别 | 类型 | 一句话动作 |
|---|---|---|---|---|---|
| 1 | MEM-01 | 融合状态机无 CAS，转移表是死代码 | P1 | design/impl-bug | 上 `trySetFusionStatus` CAS，让转移表真守卫 |
| 2 | MEM-06 | 融合临时仓永不回收，磁盘单调增长 | P1 | impl-bug/perf | 终态删 `fusions/{id}` 或加 GC，修 design.md 失实承诺 |
| 3 | MEM-08 | 融合 clarify 反喂蒸馏 = 递归记忆回路 | P2 | impl-bug | enqueueDistillJob 排除 built-in 工作流任务 |
| 4 | MEM-07 | 融合任务泄漏进 tasks 列表/clarify 收件箱 | P2 | impl-bug/coupling | listTasks/inbox/badge 统一过滤 built-in 工作流任务 |
| 5 | MEM-02 | approve 的 applying→done 非原子，孤儿 applying 无恢复 | P2 | design | applying 标记折进 commit tx，或加 applying reconcile |
| 6 | MEM-EXT-02 | 融合「借任务引擎」后门，任务新能力反复波及融合 | P2 | extensibility | 抽 runAgentInEphemeralRepo 显式 primitive |
| 7 | MEM-EXT-01 | 新增记忆源要碰 13 处，无 source-kind 注册表 | P2 | extensibility | MemorySourceProvider 注册表 |
| 8 | MEM-03 | 注入纯 recency，忽略 category/tag 相关性 | P2 | design | 注入引入 category 优先级（RFC 级） |
| 9 | MEM-04 | 蒸馏/融合 loop 绑死单实例，无租约 | P2 | design | 显式记账「单实例约束」，HA 前先上租约 |
| 10 | MEM-13 | 融合并发竞态零测试 | P2 | test-gap | 补双 approve / reconcile-cancel-race 用例 |
| 11 | MEM-11 | 融合复刻任务取消逻辑，绕过统一入口 | P2 | coupling | 抽 forceTerminateTask 给融合调 |
| 12 | MEM-EXT-03 | 四 scope 硬编码，加 scope 维度散改 | P2 | extensibility | scope-kind 注册表 / ACL 数据驱动 |
| 13 | MEM-EXT-05 | capture 90% 抄，第三 owner 逼出三份 | P2 | extensibility | 抽 captureOpencodeSession 核心 |
| 14 | MEM-09 | OQ-6 restore 来回轻度重复注入 | P3 | impl-bug(已知) | 维持记账，后续 RFC |
| 15 | MEM-10 | sessionID 抽取双份 guard 漂移 | P3 | coupling | 已被 dedup-audit 覆盖，合流抽公共原语 |
| 16 | MEM-05/12/14 | prompt 硬编码 / import 落中段 / 运维指标薄 | P3 | design/coupling/obs | 记账，随重构顺手 |

> 交叉印证既有审计：MEM-10（sessionID 双份）、MEM-11/12（memory-scope-acl 5 站）已被 `dedup-audit-2026-06-13.md`（§第 7 项 / 第 34、53 项）覆盖；MEM-EXT-05 与其 `inflight-dedup-and-captured-subprocess`、`parse-session-tree-adapter` 簇相关。MEM-09 即 RFC-101 OQ-6，本审计仅确认其未修。scheduler-audit-2026-06-10.md 的 R2（dbTxSync）已在 memory.ts 落地（promoteCandidate/patchMemory 已用 dbTxSync），本子系统该项已闭环。
