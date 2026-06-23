# 反问 / 评审 / 协作 — 架构审计 (2026-06-23)

> 审计范围：反问运行时统一（self/cross/single-agent）、clarify_rounds 双写漂移、review 重试级联、协作草稿 last-write-wins、强制反问。
> 代码锚点：`services/{clarify,clarifyFallback,clarifyRounds,crossClarify,review,reviewRoundStart,taskCollab,taskFeedback}.ts`、`shared/clarify.ts`、`shared/reviewMultiDoc.ts`、`routes/{clarify,reviews,taskFeedback}.ts`、`services/scheduler.ts`（派发段）。
> 相关 RFC：005/014/023/026/052/056/058/059/063/064/070/078/079/090/097/099/100。
> 既有审计交叉：`dedup-audit-2026-06-13.md`（#8 clarify-rounds-dual-write、#10 legacy-clarify-prompt-context、parse-question-scopes/compute-remaining）、`scheduler-audit-2026-06-10.md`（S-3 review approve 卡死、S-9 HTTP reset --hard 绕 writeSem、S-10 装饰性事务、S-25 代理信号反推 rerun 成因、S-27 review resume 吞 409）。

---

## 0. 健康度一句话

功能正确性经过 RFC-058/064/070/074/097/099/100 多轮加固后已相当扎实（双写、provenance、CAS、prompt 隔离都到位），但**架构债很重**：clarify 状态横跨 3 张表 + 8 处手工双写，prompt 组装逻辑（self/cross/review/inline/followup 五维）全部塞进 scheduler 的 ~250 行 16 个互相牵制的布尔门里，「统一」只统一了一半（统一了表与 REST，没统一服务层、WS 事件与 prompt context 入口）——下一个 RFC 改这块时几乎必然要碰 4-6 个文件并加第 17 个布尔门。

---

## 1. 当前架构与职责

clarify/review/协作是「人工把关 + 回流重跑」子系统：agent 产出 `<workflow-clarify>` 信封 → 服务层铸 intermediary node_run 并 park `awaiting_human/_review` → HTTP 提交决策 → 回滚/铸重跑行 → `resumeTask` 让调度器再派发，重跑行的 prompt 由 scheduler 注入历史 Q&A / 评审意见 / External Feedback。三条 clarify 路径（self-clarify、cross-clarify designer 侧、cross-clarify questioner 侧）+ review（单文档/多文档）+ 强制反问（RFC-100）+ inline session（RFC-026）+ 协作草稿（RFC-099）共用这套骨架。

**关键文件**：
- `services/clarify.ts`（1210 行）— self-clarify 全生命周期 + 仍存活但**生产死代码**的 `buildClarifyPromptContext`。
- `services/crossClarify.ts`（1570 行）— cross-clarify（多源聚合、reject 持久化、designer 重跑、questioner 级联）。
- `services/clarifyRounds.ts`（890 行）— 统一表 `clarify_rounds` 的读路径（`buildPromptContext` 三分支 + `selectAnsweredRoundsForConsumer`）+ 协作草稿 + 归属冻结。
- `services/review.ts`（2502 行）— anchor 重算、doc_version 归档、approve/reject/iterate、sibling 级联、prompt 组装。
- `services/scheduler.ts`（派发段 ~1690–2380）— 真正决定「这次重跑注入哪种 context」的 16-布尔门状态机。
- `shared/clarify.ts`（729 行）、`shared/reviewMultiDoc.ts`（161 行）— 纯渲染/解析原语。
- `services/{reviewRoundStart,taskCollab,taskFeedback}.ts`、`routes/*` — 派生时间锚点、成员制权限、反馈 CRUD、REST。

---

## 2. 设计问题（Design）

**[CRC-01] clarify 状态横跨 3 张表、8 处手工双写 —— 单一事实源未落地** — 级别 P1｜类型 design/coupling｜证据 `db/schema.ts:888/941/1028`（`clarifySessions` / `crossClarifySessions` / `clarifyRounds` 三表并存）；写点 `clarify.ts:216,509,939`、`crossClarify.ts:244,452,601,1339`、`lifecycleInvariants.ts:539-548`（CR-1 abandoned 升级也双写）｜影响：RFC-058 的目标是 `clarify_rounds` 做单一事实源、T17 删除 legacy 表，但至今 legacy 两表仍是**部分读路径的权威**（`submitClarifyAnswers` 先读 `clarifySessions`、cross readiness/External Feedback 全读 `crossClarifySessions`），`clarify_rounds` 仅供 REST inbox + `buildPromptContext` + CR-1 扫描。三表靠每个写动作手写 2-3 条 INSERT/UPDATE 保持一致，**任何一处漏写就静默漂移**。dedup-audit #8 已记此为「加 2 个 mapper」的 medium，但**低估了规模**（实为 8 站跨 4 文件，且 CR-1 那处它没列入）。已确认漂移实例见 CRC-02。｜建议：把所有 clarify 写收敛进 `clarifyRounds.ts` 的 `insertRound/markAnswered/markAbandoned/cleanup` 4 个 mapper（legacy 表的镜像写在 mapper 内部，调用方一律不直接 touch legacy 表），为 T17 删表铺路；这是比 dedup-audit 提的 2-mapper 更彻底的收口。

**[CRC-02] cross-clarify 截断警告在统一表里恒为 null —— 删 legacy 表后彻底丢失** — 级别 P2｜类型 design/impl-bug｜证据 `crossClarify.ts:260` 硬编码 `truncationWarningsJson: null`，而 `:268-273` 确实检测到 `args.truncationWarnings` 后**仅记日志**；self 路径 `clarify.ts:232` 是真传值的｜影响：cross-clarify 信封默认 `maxQuestions = +Infinity`（`shared/clarify.ts:422`），看似不会触发问题数截断，但**每问选项数仍受 `CLARIFY_MAX_OPTIONS_PER_QUESTION` 截断**（`shared/clarify.ts:138-144`），所以 cross 路径真实会产生选项截断警告，却既不入 legacy 表也不入统一表。RFC-058 删 legacy 表后，self 的警告还在（dual-write 有传），cross 的将永久消失，UI 永远看不到「你的选项被截断了」。已被 dedup-audit #8 覆盖（明确点了 `crossClarify.ts:261`），此处仅补「选项截断也会丢，不只是问题数」的细节。｜建议：CRC-01 的 mapper 接 `truncationWarnings` 参数，cross 路径传真值。

**[CRC-03] self-clarify 与 cross-clarify 是两套并行 WS 事件族，统一只做了一半** — 级别 P2｜类型 design/extensibility｜证据 WS 事件枚举：`clarify.created/answered/draft.updated` vs `cross-clarify.created/answered/rejected/designer-rerun-batched`（`clarify.ts:1030-1057`、`crossClarify.ts:1506-1555`、`clarifyRounds.ts:800`），前端各有一套 handler（`grep` 确认 11 个独立 case）｜影响：REST（`/api/clarify` 统一）、DB（`clarify_rounds` 统一）都收敛了，**唯独 WS 事件与服务层入口没收敛**。`clarify.draft.updated`（协作草稿）只在 self 路径有——cross-clarify 表单的协作草稿**没有实时同步广播**（虽然 `saveClarifyDraft` 走统一表能存，但 cross 的提交走 `submitCrossClarifyAnswers`，二者 WS 不一致）。新增第三种 clarify 形态时要再造一族事件。｜建议：统一为 `clarify.round.{created,answered,draft_updated}` + `kind` 字段，前端单一 handler 按 kind 分流。

**[CRC-04] prompt context 组装是 scheduler 里的 16-布尔门隐式状态机，而非显式服务** — 级别 P1｜类型 design/coupling｜证据 `scheduler.ts:2090-2340`：`isClarifyRerun / isCrossClarifyTriggeredRerun / isQuestionerCrossClarifyRerun / hasClarifyChannel / hasExternalFeedbackChannel / effectiveHasClarifyChannel / applyLatestDirective / sessionMode / resumeDecision / clarifyContext / crossClarifyContext / priorOutputBlock / ...`（实测 16 个 `const` 门，互相条件依赖）｜影响：「该注入哪种 context、是否强制 ask-back、是否 inline resume、directive 是否传递」这个**核心业务决策**没有单一函数承载，散在 scheduler 里。RFC-100（强制反问）的全部逻辑就是这里的 `effectiveHasClarifyChannel = hasClarifyChannel && directive!=='stop' && (reviewContext===undefined || isClarifyRerun)` 三条件与；RFC-064「统一运行时」名义上统一了，实际只是把三个 reader 的入口合到 `buildPromptContext`，**调度决策仍是三分支布尔判断**。这是 scheduler-audit S-25「用代理信号反推 rerun 成因」的延伸——RFC-098 用 `rerun_cause` 列替掉了部分代理信号，但门的数量没减。每加一种交互（如「条件式 review」「agent 主动 stop」）都要在这 250 行里再插一个门并重测全部 (consumerKind × cause) 真值表。｜建议：抽 `resolveInteractionContext(node, runRow, definition, db): { clarifyContext?, reviewContext?, crossContext?, mandatoryAskBack, resumeSessionId }` 纯/半纯函数，scheduler 只调用一次；真值表用数据驱动（一张 `(consumerKind, cause) → 行为` 表）而非嵌套布尔。

**[CRC-05] review 重试级联用 `error_message` 字符串前缀承载调度契约** — 级别 P2｜类型 design｜证据 `review.ts:1742` `supersedeMarker = ${REVIEW_SUPERSEDE_MARKER_PREFIX}${decision}${rolledBack?'-rollback':''}`，写进被取消行的 `errorMessage`（`:1759`），而 RFC-095 让 `isDispatchable` 靠 grep 这个前缀决定取消行是否可复活｜影响：`node_runs` 没有 `error_summary` / 结构化 supersede 原因列，于是把「这是 review-supersede 而非真失败」「文件已回滚」两个布尔编码进自由文本错误信息。`-rollback` 后缀、`decision` 子串都是 load-bearing 的解析点，任何错误信息格式调整都可能让调度器误判取消行的可派发性。｜建议：加 `node_runs.supersede_kind` + `rolled_back` 两个结构化列，错误信息回归纯人读。

**[CRC-06] cross-clarify reject「持久化 stop」按节点 id 跨所有 loop_iter 生效，与 Q&A 按 loop_iter 隔离的语义不对称** — 级别 P2｜类型 design｜证据 `crossClarify.ts:1028-1045` `hasPersistentStop` 查询**不带 loopIter**（注释自述「regardless of loop_iter」），而所有 Q&A 读写都带 loopIter（`:195-202`、`clarifyRounds.ts:255,285`）｜影响：用户在 loop 第 1 轮对某 cross-clarify 点了「拒绝」，则该节点在**之后所有迭代**永久短路为 done（`dispatchCrossClarifyNode` 短路）。这是有意设计（reject 持久化），但与「Q&A 历史按 loop_iter 重置」放在一起会让用户困惑：第 2 轮 questioner 想重新问，节点却恒短路。无 UI 解除入口。｜建议：要么文档化「reject 即任务级永久关闭该通道」并在 UI 明示，要么让持久化也按 loop_iter 作用域（与 Q&A 对齐）。

---

## 3. 实现问题 / Bug（Impl）

**[CRC-07] `buildClarifyPromptContext` + 私有 reader + `computeRemaining` 是生产死代码，仍被 86 处测试锁定** — 级别 P2｜类型 test-gap/maintenance｜证据 `grep "buildClarifyPromptContext("` 仅命中其自身定义（`clarify.ts:643`），生产唯一调用方是 `clarifyRounds.buildPromptContext`（`scheduler.ts:2225/2241`）；测试引用 86 处｜影响：320+ 行死代码（`buildClarifyPromptContext` + `db_selectAnsweredSessionsForRerun` + `computeRemaining`）持续维护成本，且**有漂移风险**——若有人改统一 `buildPromptContext` 的 round-label 格式（`### Round N`），死代码里的同款逻辑（`clarify.ts:701` vs `clarifyRounds.ts:380`）不会同步，但测试还绿，给人「两条路都活着」的错觉。已被 dedup-audit #10 覆盖（`legacy-clarify-prompt-context`，标 RFC）。｜建议：删死代码 + 迁移测试到 `buildPromptContext`（统一入口）。

**[CRC-08] `computeRemaining` / `loadNodeTitlesByTask` / `loadTaskNamesByTaskId` / `parseQuestionScopesJson` 在 clarify.ts 与 clarifyRounds.ts 各一份且已轻微漂移** — 级别 P2｜类型 coupling/impl-bug｜证据 两份 `computeRemaining`（`clarify.ts:759` / `clarifyRounds.ts:405`）、两份 `loadNodeTitlesByTask`（`clarify.ts:855` / `clarifyRounds.ts:682`）、两份 `parseQuestionScopesJson`（`crossClarify.ts:1453` / `clarifyRounds.ts:652` 的 `parseRoundQuestionScopes`）｜影响：**已漂移**——`clarify.ts:871` 的 `loadNodeTitlesByTask` 只认 `agent-single|clarify` 两种 kind，而 `clarifyRounds.ts:698-703` 那份认 `agent-single|clarify|clarify-cross-agent` 三种。这意味着 self-clarify 旧 inbox（走 `clarify.ts` 那份）渲染 cross 节点标题时会 fallback 到 nodeId，而统一 inbox 不会。dedup-audit 把 `parse-question-scopes-json`(4) / `compute-remaining-loop-counter`(2) 列为低优；node-title loader 的漂移它未单列。｜建议：连同 CRC-07 删死代码时，`computeRemaining` / title loader 收敛到 `clarifyRounds.ts`（或 shared）单一实现。

**[CRC-09] `submitClarifyAnswers` 跨 4 张表的多步写在 bun:sqlite 下无事务保护（torn-read 已显式接受，但 torn-write 未覆盖）** — 级别 P2｜类型 impl-bug｜证据 `clarify.ts:461-528` 注释明写「db.transaction does NOT help: bun:sqlite's transaction is synchronous, COMMITs at first await — verified」，于是手工排序 mint→flip session→flip clarify_rounds→flip node_run；其中 flip session（`:485`）与 flip clarify_rounds（`:508`）之间隔着 `buildFrozenAttributionSet`（`:503` 一次 await DB 读）｜影响：作者已用「先铸重跑、后翻状态」消解了 torn-**read**（frontier 误判完成）。但若进程在 `clarifySessions` 已 answered、`clarifyRounds` 未 answered 之间崩溃，两表对同一逻辑事件状态不一致：统一表（REST/inbox 权威）仍显示 awaiting_human，legacy 表（submit 入口权威）显示 answered → 用户在 inbox 看到「待回答」，点进去 submit 又 409 already-answered。同类已被 scheduler-audit S-10 覆盖（装饰性事务），此处是**S-10 在 clarify 多表场景的新实例**。｜建议：CRC-01 收敛 mapper 后，把多表写包进 `dbTxSync`（同步事务，bun:sqlite 真原子），消除 torn-write 窗口。

**[CRC-10] cross-clarify「session→answered 必须先于 questioner 重跑铸行」的窗口被有意接受，留下一个浪费重跑** — 级别 P3｜类型 impl-bug｜证据 `crossClarify.ts:412-425` 长注释：与 `submitClarifyAnswers` 不同，cross 的 session flip **不能**推迟到重跑铸行之后（多源 readiness 检查要先看到本 session 已 resolved），所以接受「并发 runScope tick 落在 flip 与 questioner 重跑铸行之间 → 短暂误判 questioner 完成」的窗口，靠 RFC-074 provenance 自纠（下游跑过的输出变 stale 后重派）｜影响：作者论证「净效果只是浪费一次重跑，永不产生错误终态」，可接受。但这是 self 与 cross 两条路**写顺序不变量相反**的设计分叉（self：mint-first；cross：flip-first），属于 CRC-04「两套并行实现」的又一处证据，未来统一时是隐藏陷阱。｜建议：作为 CRC-01/CRC-04 收口时的已知约束记入设计文档，不要在收敛 mapper 时盲目对齐写顺序。

**[CRC-11] review 多文档 approve 的「全部已决」校验在归档循环之后才查、但写在归档之前——单点 OK，多文档存在半归档风险面** — 级别 P3｜类型 impl-bug｜证据 `review.ts:1496-1501` 先校验 `allDocumentsDecided` 抛错（在任何 mutation 前，OK），但 `:1508-1534` 的 per-doc 归档循环逐条 update+delete comments，无事务｜影响：多文档 round 若在归档第 3 个文档时崩溃，前 2 个文档已 decision=approved 且 comments 已删，后 N 个仍 pending，node_run 未翻 done → 重入 `submitReviewDecision` 时 `dvRows`（只查 pending）只剩后 N 个，前 2 个的决策丢失且无法恢复。窗口窄但与 S-10 同根。｜建议：归档循环 + 端口写 + 状态翻转包进 `dbTxSync`。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[CRC-X1] 新增第三种「人工把关」交互形态（如条件评审 / agent 主动结束 / 多人投票决策）会逼你碰 6+ 文件、加第 17 个布尔门** — 级别 P1｜类型 extensibility
- **未来场景**：半年后要加「评审可被 agent 条件触发」或「clarify 答案需 N 人投票通过」。
- **根因**：交互形态没有抽象。每种形态都要：①新 node kind + schema；②新 service 文件（全生命周期）；③新 WS 事件族（CRC-03）；④scheduler 里新 `isXxxRerun` 布尔门 + context 分支（CRC-04）；⑤runner 里新 context 参数（`runner.ts:135-177` 已有 reviewContext/clarifyContext/crossClarifyContext 三个并列可选参数）；⑥`renderUserPrompt` 新拼接分支；⑦dual-write（CRC-01）。
- **现在要碰的点**：`schemas/workflow.ts` + `services/<new>.ts` + `clarifyRounds.ts`(或新表) + `scheduler.ts:2090-2340` + `runner.ts` + `shared/clarify.ts` + 前端 inbox/handler。
- **目标形态**：定义 `HumanGateInteraction` 接口（`dispatch(node,run) → park | shortcircuit`、`submit(decision) → reruns[]`、`buildContext(consumerRun) → PromptFragment`、`wsEvents`），self/cross/review 各实现一份，scheduler 只认接口；prompt 用「fragment 列表」拼装而非 N 个具名可选参数。

**[CRC-X2] runner 的 prompt context 是 N 个具名可选参数（reviewContext/clarifyContext/crossClarifyContext/clarifyMode/hasClarifyChannel/followup...），加一种就加一个参数 + 一处拼接** — 级别 P1｜类型 extensibility/coupling｜证据 `runner.ts:135-177` 7 个并列交互相关参数，`scheduler.ts:2363-2377` 用 7 个 `...(x !== undefined ? {x} : {})` 条件展开传入｜影响：context 不是统一抽象，是「每种交互一个洞」。`renderUserPrompt`（在 shared/runner 内）按这些参数逐个 if 拼 prompt 段。新增交互 = 新参数 + 新拼接 if + 新测试覆盖所有组合。｜目标形态：`promptFragments: PromptFragment[]`（每个 fragment 自带 `section: string` 与渲染顺序权重），runner 只做 `fragments.sort().map(render).join()`，交互形态自描述其 fragment。

**[CRC-X3] clarify 历史「老化」靠 `consumed_by_*_run_id` 三套独立 stamp 列 + 三个 markX 分支，新增消费者要再加一列一分支** — 级别 P2｜类型 extensibility｜证据 `clarifyRounds.ts:97-182` `markClarifyRoundsConsumedBy` 有 6 条 UPDATE（self / cross-designer / cross-questioner 各 2 张表），用 `consumedByConsumerRunId` 与 `consumedByQuestionerRunId` **两个不同列**区分消费者角色；`schema.ts` cross 表也镜像这两列｜影响：RFC-070 用「跑完 done-with-output 即 stamp」漂亮地干掉了 clarifyIteration 计数器对比类 bug，但代价是「消费者角色」被硬编码成列名。若 cross-clarify 引入第三种消费者（如「审计 agent 也读这批 Q&A」），要加第三个 `consumed_by_auditor_run_id` 列 + 第三个 mark 分支 + 第三个 `IS NULL` 读谓词。｜目标形态：`clarify_round_consumptions(round_id, consumer_run_id, consumer_role)` 关联表，老化判定 = 「不存在匹配本 (round, role) 的 consumption 行」，消费者角色变数据而非列。

**[CRC-X4] cross-clarify 多源 designer 聚合的「就绪判定」是按 workflow 拓扑 + per-node 最新 session 串行扫描，多源/嵌套 loop 下复杂度与正确性都脆弱** — 级别 P2｜类型 extensibility/perf｜证据 `crossClarify.ts:673-737` `evaluateDesignerRerunReadiness` 对每个指向 designer 的 sibling cross-clarify 节点跑一次 `select...limit(1)`（N+1 查询），且就绪规则（every sibling latest in {answered,abandoned}）+ 「designerRunTriggeredAt 已置则跳过」的去重逻辑全是命令式｜影响：这是整个子系统**最难推理**的一段——多源、directive=stop/continue/all-questioner-scope、abandoned、designer_run_triggered_at 去重、RFC-059 scope 过滤交织。加「designer 需等待 M/N 源就绪而非全部」这种需求时，要重写这段命令式聚合。N 个 sibling 时 N+1 查询。｜目标形态：把就绪判定抽成纯函数 `evaluateReadiness(sources: SessionSnapshot[], rule: ReadinessRule)`（一次批量查 + 纯计算），rule 可插拔（all / quorum / any）。

**[CRC-X5] review 多文档 vs 单文档、inline markdown vs path<md> 在 `dispatchReviewNode` / `submitReviewDecision` 里靠 `itemIndex !== null` + `itemPath === null` 多处 if 分叉，加第三种 review 输入形态会四象限爆炸** — 级别 P2｜类型 extensibility｜证据 `review.ts:600-660`（dispatch 多文档分支）、`:1364-1442`（approveMultiDoc）、`:1385` `itemsInline = dvs.every(d => itemPath===null)`、`:438` `itemsInline = isMultiDoc && isInlineMarkdownListReviewInput`｜影响：review 输入维度已是 2×2（单/多文档 × inline/path），每个决策点都要 4 象限判断。RFC-079/081 已让这段相当绕。新增「list<json> 结构化 review」会变 2×3。｜目标形态：`ReviewInputShape` 策略对象（`split() / archiveItem() / emitAccepted()`），dispatch/decision 调策略方法，形态新增 = 新策略实现，不改主流程。

**[CRC-X6] 协作草稿（RFC-099 D14）只覆盖 clarify 反问，review comment 没有 last-write-wins 草稿同步层** — 级别 P3｜类型 extensibility｜证据 草稿设施仅在 `clarifyRounds.ts:745-810` `saveClarifyDraft` + `clarify.draft.updated` 事件；review comment 是直接 `addReviewComment` 落库（`review.ts:1177`），无草稿、无「X 正在编辑」实时同步｜影响：多人协作时 clarify 表单有逐题 LWW + 实时光标提示，review 标注没有——两个本应对称的「多人把关」表面体验不一致。未来要给 review 加协作草稿得另起一套（草稿设施没做成可复用原语）。｜目标形态：把草稿/归属/LWW 抽成 `CollaborativeDraft<TValue>` 通用层（按 (entityId, fieldId) 存），clarify answer 与 review comment 都挂上去。

---

## 5. 耦合 / 分层违规

**[CRC-12] 服务层多处直接 `JSON.parse(task.workflowSnapshot)` 重建 WorkflowDefinition 并自行扫 nodes** — 级别 P2｜类型 coupling｜证据 `clarify.ts:867,1192`、`clarifyRounds.ts:694`、`crossClarify.ts:1498`、`review.ts:874,1029,1652,2213`、`routes/clarify.ts:147`｜影响：snapshot→definition 的解析 + 容错（corrupt JSON 降级）逻辑散落 ≥10 处，每处自己 try/catch、自己定义「认哪些 node kind」（CRC-08 的漂移正源于此）。没有一个 `loadDefinitionForTask(db, taskId): WorkflowDefinition | null` 单点。｜建议：抽单点 loader + 单点 node-kind 白名单。

**[CRC-13] `crossClarify.ts` 反向 import `services/clarify.ts` 的 `sealAnswersServerSide`，clarify ←→ crossClarify ←→ clarifyRounds 三角互依** — 级别 P3｜类型 coupling｜证据 `crossClarify.ts:84 import { sealAnswersServerSide } from '@/services/clarify'`；`clarify.ts:70 import { buildFrozenAttributionSet } from '@/services/clarifyRounds'`；`crossClarify.ts:90` 同样 import clarifyRounds｜影响：三个服务文件循环耦合，`sealAnswersServerSide`（纯函数、防客户端伪造 label）本该在 shared。binary-build 模块初始化环风险（见 MEMORY `reference_binary_build_module_cycle`）。｜建议：`sealAnswersServerSide` 移 `shared/clarify.ts`（它已是纯函数，无 DB 依赖）。

**[CRC-14] routes/clarify.ts 用 `nodeKindFromSnapshot` 在路由层判 self/cross 再分流到两个不同 service 函数** — 级别 P2｜类型 coupling｜证据 `routes/clarify.ts:146-158,243-276`：路由先 `JSON.parse(snapshot)` 找 node.kind === 'clarify-cross-agent' 才调 `submitCrossClarifyAnswers`，否则 `submitClarifyAnswers`｜影响：「这是哪种 clarify」的分发逻辑泄漏到 HTTP 层，且与 scheduler 的 `clarifyMode` 判定（`scheduler.ts:1705`）是两套独立判断（一个看 node.kind，一个看 edge 拓扑），可能不一致。两个 submit 函数签名/返回形状不同（cross 多 `outcome`、`questionScopes`），路由各拼一份 best-effort resume（dedup-audit 也提了 resume 重复）。｜建议：统一 `submitClarifyRound(nodeRunId, decision)` 单入口，内部按 `clarify_rounds.kind` 分流，路由不解析 snapshot。

---

## 6. 测试 / 可观测性缺口

**[CRC-15] 死代码被 86 处测试锁定，给「双路都活」假象 + 阻碍删除** — 级别 P2｜类型 test-gap｜见 CRC-07。测试锁的是已不在生产路径的 `buildClarifyPromptContext`，一旦统一入口 `buildPromptContext` 改格式，这些测试仍绿但锁的是死逻辑。｜建议：删代码前把这些测试改指向 `buildPromptContext`。

**[CRC-16] cross-clarify 多源就绪 / abandoned 升级 / designer_run_triggered_at 去重缺端到端可观测性** — 级别 P2｜类型 observability｜证据 `evaluateDesignerRerunReadiness` 的 pending/sources 分类只在返回值里，无结构化日志；CR-1 abandoned 升级写 `lifecycle_alerts`（`lifecycleInvariants.ts:550`）但「为什么这个源没进 External Feedback」（被 scope 过滤 / designerRunTriggeredAt 已置 / directive=stop）三种跳过原因（`crossClarify.ts:713,730,1141`）静默｜影响：多源 designer 没按预期重跑时，运维只能读代码反推是哪条跳过分支命中。｜建议：每个跳过点记一条 debug 事件（source nodeId + 跳过原因枚举）。

**[CRC-17] torn-write 窗口（CRC-09/CRC-11）无回归测试** — 级别 P3｜类型 test-gap｜证据 `clarify.ts:375-397` 长注释论证了 torn-read 安全（且有测试锁），但 torn-write（两表/多文档半提交后崩溃）无对应测试｜影响：CRC-01 收敛 mapper + 包事务后，需要一条「mapper 内任一步抛错 → 三表无半态」的测试守护。｜建议：随 CRC-01 落地补 fault-injection 测试。

---

## 7. 目标形态（Target architecture）

理想的「人工把关 / 回流」子系统应围绕**单一交互抽象 + 单一事实源 + 单一 prompt 拼装**：

1. **单事实源**：`clarify_rounds` 真正成为权威，legacy `clarify_sessions` / `cross_clarify_sessions` 删除（RFC-058 T17 完成）；所有写经 `clarifyRounds.ts` 的 mapper（CRC-01），mapper 内包 `dbTxSync` 同步事务（CRC-09/11）。消费老化用关联表而非角色列（CRC-X3）。

2. **交互抽象**：定义 `HumanGateInteraction`（dispatch / submit / buildContext / wsEvents）接口，self-clarify、cross-clarify、review、未来形态各实现一份（CRC-X1）。scheduler 不再认具体 kind，只遍历接口。

3. **统一 prompt 拼装**：runner 接 `PromptFragment[]`（每个 fragment 自带 section + 顺序权重），取代 reviewContext/clarifyContext/crossClarifyContext 等 N 个具名可选参（CRC-X2）。

4. **调度决策数据化**：`resolveInteractionContext` 单函数 + 一张 `(consumerKind, rerun_cause) → 行为` 真值表，替掉 scheduler 里 16 个互相牵制的布尔门（CRC-04）。RFC-100 强制反问、RFC-026 inline、directive 传递都成为表里的行。

5. **统一 WS + 协作层**：`clarify.round.*` 单事件族 + kind 字段（CRC-03）；草稿/归属/LWW 抽成 `CollaborativeDraft<T>` 通用层，clarify answer 与 review comment 共用（CRC-X6）。

6. **结构化调度契约**：`node_runs` 加 `supersede_kind` / `rolled_back` 列，错误信息回归人读（CRC-05）。

迁移路径：CRC-01（mapper 收口 + 删 legacy 表）→ CRC-07/08（删死代码、去重）→ CRC-04/X1/X2（抽交互接口 + fragment）。前两步是低风险纯收敛，能立刻消除漂移类 bug；后两步是真正的架构重构，应各立 RFC。

---

## 8. Top 风险与建议优先级

| 序 | ID | 标题 | 级别 | 类型 | 既有审计 |
|----|----|----|----|----|----|
| 1 | CRC-01 | clarify 状态 3 表 8 处手工双写，单一事实源未落地 | P1 | design/coupling | dedup #8（低估规模） |
| 2 | CRC-04 | prompt context 是 scheduler 16-布尔门隐式状态机 | P1 | design/coupling | scheduler S-25（延伸） |
| 3 | CRC-X1 | 新交互形态逼碰 6+ 文件 + 加第 17 门 | P1 | extensibility | 新 |
| 4 | CRC-X2 | runner prompt context 是 N 个具名可选参，加一种加一洞 | P1 | extensibility/coupling | 新 |
| 5 | CRC-09 | submitClarifyAnswers 4 表多步写无事务（torn-write 窗口） | P2 | impl-bug | scheduler S-10（新实例） |
| 6 | CRC-02 | cross-clarify 截断警告恒 null，删表后丢失 | P2 | design/impl-bug | dedup #8 |
| 7 | CRC-08 | computeRemaining/title-loader/scope-parse 重复且 node-kind 已漂移 | P2 | coupling/impl-bug | dedup（部分，title-loader 漂移新增） |
| 8 | CRC-03 | self/cross 两套并行 WS 事件族，统一只做一半 | P2 | design/extensibility | 新 |
| 9 | CRC-X4 | cross 多源就绪聚合 N+1 + 命令式难推理 | P2 | extensibility/perf | 新 |
| 10 | CRC-12 | ≥10 处直接 parse workflowSnapshot 重建 definition | P2 | coupling | 新 |
| 11 | CRC-14 | 路由层判 self/cross 分流，分发逻辑泄漏 HTTP | P2 | coupling | dedup（resume 部分） |
| 12 | CRC-X3 | clarify 老化靠角色列名硬编码，加消费者加列 | P2 | extensibility | 新 |
| 13 | CRC-X5 | review 单/多文档 × inline/path 四象限 if 分叉 | P2 | extensibility | 新 |
| 14 | CRC-05 | review supersede 契约编码进 error_message 字符串 | P2 | design | scheduler S-9 邻域 |
| 15 | CRC-07 | buildClarifyPromptContext 等生产死代码 | P2 | test-gap | dedup #10 |
| 16 | CRC-06 | cross reject 持久化跨 loop_iter 与 Q&A 隔离不对称 | P2 | design | 新 |
