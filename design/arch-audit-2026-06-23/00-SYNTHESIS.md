# 全仓架构综合与重构路线图 (2026-06-23)

> 首席架构师跨子系统综合。输入：17 份子系统审计（`01`~`17`，含 4 份前端）+ 3 份既有审计（`scheduler-audit-2026-06-10` / `dedup-audit-2026-06-13` / `ux-audit`）。
> 视角：架构层 + 扩展性（不是 bug 清单）。所有证据 file:line 相对仓库根。
> 各子系统报告索引见**附录**。

---

## 1. 总评（一段）

这是一个**功能正确性已被反复加固到很高水准、但结构演进策略普遍触顶**的成熟项目：每个子系统都经过 2-3 轮 RFC 对抗评审，把最危险的「静默错误」类 bug（任务显示成功却消费空输入/旧输出/脏 worktree）逐条堵住——但堵的方式高度雷同：**抽出一个高质量纯函数当「大脑」，却把「躯干」（god-module / god-component / 多份手抄注册表）留在原地**。结果是全仓反复出现同一组系统性根因——「公共原语已存在却被绕过各写一份」（dedup-audit 的核心结论，本次 17 份报告全部独立复现）、「单一事实源声明了但只接线 1/N 维」（`node-kind-behavior` 5 维只用 1 维，`isValidFusionTransition` 转移表零调用，`schema_version` 列从不写）、「核心抽象（record-state→run→diff→fanout）没有被一等公民化，散落在 4962 行 scheduler 巨石 + 三套 wrapper 各写一份里」。**P0 数为 0**（正确性网已织密），但 P1 集中在两类：① 已漂移成真 bug 的「多份副本不一致」（retryNode 漏 commitPush 透传、cache token 静默丢失 15×、fanout 按 `\n` 裂分 `list<markdown>`、嵌套 `</port>` 静默截断、融合状态机无 CAS、多仓 worktree GC 恒失败泄漏、OIDC 开放重定向）；② 「加一个新 X（节点种类/资源类型/语言/output-kind/记忆源/WS 频道/实时资源）要碰 8-24 个文件」的扩展性坍塌。理想目标形态在每份报告里高度一致地指向同一个方向：**把散落的横切知识收敛成声明式注册表 + 让核心编排抽象成为可注入的接口**。

---

## 2. 系统性根因主题（带子系统映射 + 证据）

> 这 7 个主题在多个子系统独立复现，且与既有 scheduler-audit 的 R1-R7 根因强同构（标注对应关系）。排序按「跨子系统出现频次 × 危害」。

### T1. 公共原语已存在，却被绕过各写一份（并已漂移成 bug）
**对应 dedup-audit 核心结论 + scheduler-audit R2/R3/R5。出现在全部 17 个子系统。**
原语在仓里、质量也不差，但调用方为了「快一点」各抄一份，副本随时间漂移成真不一致：
- **freshest-run / node-run 排序**：`pickFreshestRun` 已是 authority，但 `resumeTask` 的 latestPerNode 漏 `parentNodeRunId===null` 过滤（`task.ts:1044-1052`，01-LIFE-05），fanout 子行可冒充节点最新行按子行 preSnapshot 回滚；dedup #1 `prior-done-generation` 三份各用不同 scope-key 已漂移。
- **opencode 事件/token 解析**：`accumulateTokens` 读 `cache_creation/cache_read`，真实 fixture 是 `cache.read/write`（`runner.ts:1789` vs `tests/fixtures/.../1.15.5-with-envelope.ndjson`，06-OCI-06）→ token 计量缺 ~15×、`max_total_tokens` 限额按错误小值失效；distiller 另写一套解析（06-OCI-04/05/09）。
- **list 分片 codec**：`splitListItems` 是单一事实源，fanout 在 `scheduler.ts:3120` 手写 `.split('\n')` 绕过它（05-PORT-07），对 `list<markdown>` 按行误裂（05-PORT-06）；review 注释自称用同一 splitter 实为谎言。
- **runTask kick 块**：startTask/resumeTask/retryNode 三处逐字抄 ~30 行 deps 透传，retryNode 已漏 `commitPush.*`（`task.ts:1362` vs `1096`，01-LIFE-06）→ 带 commit&push 的任务单节点重试静默丢配置。
- **内置 prompt 变量集**：校验器 14 项 vs 替换引擎 23 项两份手抄 Set（`workflow.validator.ts:46` vs `prompt.ts:238`，04-WFM-07）→ RFC-066 多仓 `{{__repos__}}` 误报阻止合法 launch（04-WFM-06）。
- **wrapper-kind 三连判**（13 站，dedup #4）、**SymbolKind/leaf/escapeRegExp**（5-6 份，08-STRUCT-09，dedup 未覆盖）、**describeError**（11 份前端副本同一错误码一半显翻译一半显裸码，17-FE17-D1/dedup #3）、**error-box/loading 内联**（39+59 处绕过 ErrorBanner/LoadingState，16-UI-B2/B3）、**git-spawn 样板 4 份**（07-GIT-10）、**capture 90% 抄**（06-OCI-12/11-MEM-EXT-05）、**两套 def 索引器**（08-STRUCT-02）、**mcpClosure≡pluginClosure**（12-RES-01/dedup #35）。

### T2. 单一事实源「声明了但只接线 1/N 维」——假集中陷阱
**新主题（scheduler-audit 未单列），出现在 02/04/05/11/13 + 前端 14。**
比 T1 更隐蔽：表/注册表确实建了，注释还宣称「加 X 编译失败」，但实际只有一维被运行时消费，其余维度是「文档不是行为」，给后人「填了就生效」的错觉：
- `NODE_KIND_BEHAVIORS` 5 维只 `retryCascade` 被消费，`limits/orphanReap/gc/shutdown` 是文档值「可以和现行 kind-blind 代码不一致而不报错」（源码注释亲述，已 grep 确认 `node-kind-behavior.ts:14-24`）；orphans.ts/limits.ts/gc.ts/shutdown.ts 仍 kind-blind 散查（02-SCHED-05、04-WFM-12、05-PORT-EXT-4、14-CANVAS-D2）。
- `isValidFusionTransition` + `FUSION_TRANSITIONS` 转移表存在却**零写路径调用**（grep 确认 `fusion.ts:80` 定义、`setFusionStatus:620` 是裸 `update...where(eq(id))` 无 CAS，11-MEM-01）——一台「假装在守卫」的死状态机，比没有更危险。
- 27 表的 `schema_version` 列从未被任何 `.set()` 写过（grep 确认，13-INFRA-03）；`workflows.schema_version` DB 列恒为 1、真实是 4 还被 API 暴露（04-WFM-02）。
- `expectedShardCount` 字段无人消费、笛卡尔守卫嵌套乘子是死防御（03-FANW-D5）。
- `ResourceList.tsx` 孤儿原语零 import（17-FE17-D4）；`detail-layout` 只 1 个消费者（dedup 附录 B）。

### T3. 核心编排抽象未被一等公民化——god-module / 巨石 / 双轨
**对应 scheduler-audit R3（首跑/恢复双轨）。出现在 02/06/09/13 + 前端 14。**
产品的核心抽象是「record-state → run-agents → diff/aggregate → fan-out」，但它从未被建模成一个可复用的引擎；相反，编排逻辑焊死在几个巨型单元里：
- `scheduler.ts` 4962 行 god-module，`runOneNode` ~1144 行把「按 kind 路由 + 取数 + 注入 + 重试 + 快照回滚 + 铸行 + 信号量 + commit&push」揉成一坨（02-SCHED-04）；kind 路由是手工 if-chain 无穷举护栏（与 `isDispatchable` 的 exhaustive switch 形成反差）。
- 三套 wrapper（git/loop/fanout）共享同一 `nodeIds[]` 容器抽象却**三套独立实现**（02-CHK-2、03-FANW-D1）；fanout 不复用 `runScope`，自写 `dispatchFanoutShard`+`dispatchFanoutAggregator` 把 agent 执行路径又抄一份、硬编码「只支持 agent-single inner」（03-FANW-X2）。
- `runner.ts` `runNode` ~960 行上帝函数（06-OCI-11）；clarify prompt 组装是 scheduler 里 16 个互相牵制的布尔门（09-CRC-04）；`prepareNodeRunInjection` 是跨子系统的「上帝合成点」（12-RES-11）。
- 前端对称复现：`WorkflowCanvas.tsx` 1828 行 + `NodeInspector.tsx` 1486 行双 god-component，`onNodeDragStop` 100 行困在 JSX 里不可单测（14-CANVAS-X2）。

### T4. 状态机/守卫是「事后扫描 + call-site 约定」，非「写入时结构保证」
**对应 scheduler-audit R4（并发守卫 call-site 约定）+ R6（事后校验替代写入防护）。出现在 01/02/11/13。**
- task 级状态机只做了 CAS（RFC-097）**没做转移表**——`allowedFrom` 在 ~20 个调用点手抄、已现漂移（cancel 在两处给不同合法源集，01-LIFE-01/02）；与 node_run 的 `nextNodeRunStatus` 单表 + `never` 穷举不对称（已 grep 确认 `lifecycle.ts:87` 是好模型）。
- 融合状态机连 CAS 都没有（T2 同条，11-MEM-01）；蒸馏/融合的孤儿恢复 `recoverRunning` 无锁刷回 pending（11-MEM-04）。
- 生命周期不变式全部事后扫描（24h grace），可前移的结构规则（T1/T2/U1 一致性）没做写入断言（01-LIFE-03）；修复引擎靠 `isTaskActive` call-site 约定防双调度器（01-LIFE-07，scheduler-audit S-23）。
- 真正高频的多写热路径（铸行+outputs+events、status 转移+快照）**全程零事务**，`dbTxSync` 只覆盖 5 处装饰性事务遗址；S-10 守卫只防「写了 async 事务」这一种错误写法，对「根本没用事务」零防护（13-INFRA-01/10，scheduler-audit R6）。WS publish 在 COMMIT 前触发（13-INFRA-02）。

### T5. 横切扩展点没有声明式注册表——加一个新 X 碰 N 个文件
**新主题（最高扩展性价值）。出现在几乎所有子系统，是扩展性瓶颈的统一形态。**
同一个「kind/type/语言/源」的事实被复制进 N 个并列 switch/枚举/表，加一个就要全扫一遍且无编译护栏：
- **新 NodeKind**：扫改 16-24 文件（`'agent-single'` 字面量出现在 24 个非测试文件），「NodeKind→端口」知识在前端画布/后端校验器/调度器各写一份且已漂移成 review 端口 bug（04-WFM-10、02-CHK-1、14-CANVAS-D1）。
- **新 output-kind**：碰 5 个并列注册表，drift guard 只锁 2 维（05-PORT-04/EXT-1）。
- **新语言**：碰 8 张 per-language 表 + 11 处 `lang==='x'` 硬分支，漏填静默降级（08-STRUCT-01/CHOKE-01）。
- **新资源类型**：碰 ≥8-9 处硬编码、fork 4 套模式（10-CHOKE-1、12-CP-1）。
- **新记忆源**：碰 ~13 处（11-MEM-EXT-01）。
- **新 sharding 策略 / 富 item shardSource**：重写三段式分片协议（03-FANW-X1/CHK-3）。
- **新 WS 频道 / 新实时资源**：散改 5-6 处且易漏 ACL（13-INFRA-CP3、15-FDL-09，fusion 已踩坑：零 WS 纯轮询）。
- **新人工把关交互**：碰 6+ 文件加第 17 个布尔门（09-CRC-X1）。
- **新表 / 新迁移约束**：schema.ts 1547 行 + 手抄 zod + 手写 CHECK，三方 enum 无一致性测试（13-INFRA-CP1/CP2）。
- **前端新资源页/新列表区块/新 picker/新输入类型**：fork 3-4 个脚手架文件（17-FE17-X1/X2/X3/X4）。
反例（应推广的好样板）：output-kind registry 的参数化 handler + 多重 boot-time drift guard（已 grep 确认 `registry.ts` 用 `PARAMETRIC_HANDLERS` × `REGISTERED_BASE_KINDS` 交叉校验，05 报告评为「全仓最佳可扩展抽象样板」）。

### T6. 「单 daemon 单进程」假设被到处焊死，跨任务/水平扩展无接缝
**新主题。出现在 02/10/11/13。**
- 全局信号量退化成 per-task（`scheduler.ts:397` 每 `runTaskInner` 新建一把，已 grep 确认）→ N 并发任务 = N×4 opencode 进程，违背 design.md:755「全局上限」、无兜底（02-SCHED-01）；`maxConcurrentNodes` 热更新承诺未实现、Semaphore 容量不可变（02-SCHED-02）。没有 daemon 级 scheduler-coordinator，唯一跨任务载体是 `activeTasks` Map。
- OIDC state/PKCE/discovery 全进程内 Map（10-CHOKE-6）；蒸馏/融合 loop 无租约绑死单实例（11-MEM-04）；WS 进程内广播 + ticker 无领导权选举（13-INFRA-CP4/CP5）。
- 这对当前「本地编排工具」定位**是正确取舍**，但 RFC-099 已引入多用户/ACL，产品若走向团队服务器会撞墙——危险在于这些假设是**隐式焊死**而非「显式标注的接缝」。

### T7. 知识载体腐化：design.md / i18n / 注释与实现漂移
**对应 scheduler-audit R7。出现在 03/04/05/06/07/11/16。**
权威文档承诺的能力实现里不存在，新 session 按仓规先读 design 会建立错误心智模型：
- design.md §5.1/§6.3 仍描述早被 RFC-060 删除的 `agent-multi`+`ShardingStrategy`+`GitHelper.split`（03-FANW-D3）；§7 承诺 CDATA/转义实际裸正则无转义层（05-PORT-01）。
- RFC-101 design.md:304 承诺融合临时仓 GC，实现里根本不存在（11-MEM-06，磁盘单调增长）。
- 孤儿前端 i18n 6 个分片策略 key 零组件消费（03-FANW-X5）；注释撒谎：UploadInputSchema 注释称写时执行实则从不（04-WFM-09）、shared inner 注释与代码不符（03-FANW-IMPL2）、session sweep `and(X,X)` + 注释不符（10-ACL-11）、`migrateDefinitionToLatest` round-trip 注释失实（04-WFM-08）。

---

## 3. 最优目标架构（north star）

理想形态围绕**三句话**：核心抽象一等公民化、横切扩展点声明式注册化、状态写入结构保证化。

### 3.1 分层
```
                ┌─ HTTP routes (薄) ── WS channel registry (声明式)
 应用边界 ──────┤
                └─ Zod schema (DB 派生) ── ACL descriptor 驱动 gate
                              │
 编排层 ────── DispatchLoop (纯) + SchedulerCoordinator (daemon 单例)
              ├─ NodeExecutor 注册表 (按 kind 注入)
              ├─ WrapperRunner 接口 (git/loop/fanout 共享骨架, 都递归进 runScope)
              └─ HumanGateInteraction 接口 (clarify/cross/review/未来)
                              │
 能力层 ────── 单一收口的原语 (每个有唯一 owner)
   ├─ OpencodeProcess (spawn+协议解析, 版本边界)
   ├─ WorktreeSet / worktreeLifecycle (create/snapshot/rollback/remove 唯一句柄)
   ├─ ReferableResource 注册表 (CRUD/闭包/注入/版本/ACL 表驱动)
   ├─ output-kind capability descriptor (纯数据 + 行为 handler 分层)
   ├─ LangProfile 注册表 (一门语言=一条记录)
   └─ MemorySourceProvider / MemoryScopeKind 注册表
                              │
 基座 ───────── CAS 状态机原语 (task/node/fusion/distill 同源 trySetStatus)
              + dbTxSync (热路径多写原子单元 + after-commit hook)
              + 声明式 ticker / channel registry
```

### 3.2 核心抽象（record-state → run → diff → fanout 一等公民化）
当前这条核心抽象被 fanout 在 scheduler 里二次发明、被融合用「伪装成任务」后门复用。目标：
- **抽 `runScope(scope, ctx)` 为唯一调度引擎**，git/loop/fanout/未来 wrapper 都「递归进 runScope」（loop/git 已是，fanout 改造为「拆 shards → 每 shard 一次 runScope」）。node_run 执行坐标从「裸 iteration 标量」升级为「scope 路径栈」（外层轮次 + shardKey），一举解锁 per-shard 链、shard 内 review/clarify、真正的嵌套（03-FANW-X2/X3、02-CHK-2）。
- **抽 `runAgentInEphemeralRepo({seedDir, workflow, inputs}) → {taskId, worktree, diff}`** 显式 primitive，自带「不进任务 list / 不喂蒸馏 / 临时仓自清理」契约；融合调它而非伪造任务（11-MEM-EXT-02）。这把「在临时仓跑 agent 产 diff」从后门变成有契约的复用——正是核心抽象本身。
- **`NodeExecutor satisfies Record<NodeKind, NodeExecutor>` 注册表**：runOneNode 退化成 `NODE_EXECUTORS[kind].dispatch(ctx)`，每 executor 声明全部横切维度（dispatch/isResumeAnchor/settlesWithoutRow/orphanReap/limits/gc/shutdown），orphans/limits/gc/shutdown/deriveFrontier 全查同一矩阵（02-SCHED-04/05、消解 T2/T5）。

### 3.3 状态机单一事实源
task 与 node_run **完全对称**：`shared/lifecycle.ts` 同时拥有 `nextTaskStatus` 与 `nextNodeRunStatus`（都是 `(from,event)→to` 纯函数 + `never` 穷举 + `allowedFromForEvent` 派生）；融合/蒸馏复用同一 `trySetStatus(table, id, from[], to, extra)` CAS 原语，`isValidFusionTransition` 成为转移表参数而非死代码。「进入某状态」恒有单一汇聚点（park/终态/revival 不论经 mint 还是 transition 都过同一钩子，01-LIFE-04）。可前移的结构不变式做写入时断言，事后扫描退化为脏数据兜底网（01-LIFE-03、消解 T4）。

### 3.4 扩展点声明式开放（每类「加一个 X」= 加一条记录）
- **output-kind**：纯数据 `kindCapabilities`（零依赖，含 dataBearing/reviewable/keyOf/splitItems）+ 行为 handler 分层，单一 boot guard 交叉校验**所有**维度（05-§7）。
- **资源类型**：`RESOURCE_DESCRIPTORS: Record<AclResourceType, {table, keyParam, load, refExtractor, toInlineEntry, supportsVersioning}>`，gate/列表过滤/详情 404/ACL 端点/save-ref-check/inline 注入全由描述符驱动；新资源 = 一条描述符 + 一对 permission（10-CHOKE-1、12-CP-1/CP-4）。
- **语言**：`LANG_PROFILES: Record<LangId, LangProfile>`，`langIdSchema` 从 keys 派生，一条断言锁「每 LangId 每表齐全」（08-§7）。
- **记忆源/scope**：`MemorySourceProvider` / `MemoryScopeKind` 注册表（11-EXT-01/03）。
- **WS 频道**：`Channel<Msg>{pathPattern, authorize, filterFrame}` 接口，ACL 过滤成必填方法（编译期强制不漏，13-INFRA-CP3、15-FDL-09）。
- **人工把关交互**：`HumanGateInteraction{dispatch, submit, buildContext, wsEvents}`，prompt 用 `PromptFragment[]` 拼装替代 N 个具名可选参（09-CRC-X1/X2）。
- **前端节点/输入/资源**：`nodeKindRegistry` / `INPUT_KIND_RENDERERS` / `ResourceKindDescriptor` + `makeResourceRoutes` 工厂（14-CANVAS-D1、17-FE17-X1/X4）。

### 3.5 前端 UI 设计系统（单列，应用 16/17 报告的收敛结论）
公共原语库质量很高，问题在**收敛靠「CSS class + 人工自觉」而非「React 组件 + grep 守卫」**，无强制力 → RFC-035 落地当天就被 account/users/OIDC 各写一份 chrome。目标：
- **每类 UI 形态恰有一个 React 组件作唯一入口**，class 退为内部实现。需新增：`<Tabs>`（13 处手写，ARIA 一半缺失）、`<Segmented>`（8 处）、`<Table>`（23 个裸 table、6 套 CSS）、`<Checkbox>`、`<DialogFooter>`、`<AsyncList>/<QueryView>`（query→三态，59 处 inline loading）、`<SectionList>`、`<ResourcePicker>`（4 胞胎 picker）。需最小扩展：`TextInput` 加 `password`（消灭 3 套 form chrome）、`ChipsInput` 加 `renderChipSuffix`（OutputsEditor 复用内核）。
- **强制力**：源码层 grep 守卫进 CI（白名单原语文件），拦「新原生 `<input>/<select>/<table>`、新 error-box、inline loading、`function describeError`、`t(key,{defaultValue})` 旁路 i18n」——让「绕过」= 测试失败而非靠 code review 自觉（16-UI-D3/X6、17-FE17-T1）。
- **数据层**：`useResourceChannel` 声明式 `{eventType→queryKey[]}` 注册表替代 6 份手写 sync hook；单一 query-key 工厂 + shell 单点订阅 + 全局 inbox channel，轮询降级为长间隔兜底（15-FDL-01/02/03/04）。

---

## 4. 重构路线图（排序表 + 每条详述 + 护栏次序）

> 原则（沿用 fortify-then-refactor，CLAUDE.md 强制）：**先落护栏（oracle/property/文本断言/契约测试）再动刀；纯收敛先于结构重构；漂移即 bug 的修复优先（既消 bug 又证明抽象必要性）**。effort：S<1 PR / M=1 RFC / L=多 PR RFC / XL=跨子系统大重构。

| rank | 标题 | effort | 解决根因 | 影响子系统 |
|---|---|---|---|---|
| 1 | P1 漂移 bug 急修批（含护栏） | M | T1 | 01/03/05/06/07/10/11 |
| 2 | 状态写入护栏批（热路径事务 + 三方 enum 契约 + CAS oracle） | M | T4 | 01/11/13 |
| 3 | 状态机单一事实源对称化（nextTaskStatus + trySetStatus 统一） | M | T4/T2 | 01/11/13 |
| 4 | NodeKind→端口/行为 单一描述符（前后端共享 deriveNodePorts + NodeExecutor 注册表） | L | T5/T2/T3 | 02/04/14/17 |
| 5 | output-kind capability 单表收敛 + 信封容器化 | M | T5/T2/T1/T7 | 05 |
| 6 | OpencodeProcess/Protocol 适配层 + recording-replay 进每 PR gate | M | T1/T3/T7 | 06/11 |
| 7 | WorktreeSet + worktreeLifecycle 单一 owner | L | T1/T3 | 07/02 |
| 8 | SchedulerCoordinator daemon 单例（全局 sem + 准入 + 热更新） | M | T6 | 02 |
| 9 | runScope 统一调度引擎（fanout 收敛 + iteration→scope 路径） | XL | T3/T5 | 02/03 |
| 10 | ReferableResource 注册表 + commitResourceVersion 抽象 | L | T5/T1 | 12/10 |
| 11 | resourceAcl 描述符 + 认证三洞修复（重定向/暴破/link死代码） | L | T5/T1 | 10 |
| 12 | clarify 单事实源 mapper + HumanGateInteraction + PromptFragment | XL | T1/T3/T5 | 09 |
| 13 | 融合去后门：runAgentInEphemeralRepo + 临时仓 GC + 任务面排除 | L | T3/T6/T2 | 11 |
| 14 | 前端 UI 收敛强制化（Tabs/Segmented/Table + grep 守卫进 CI） | L | T5/T1 | 16/17 |
| 15 | 前端数据层统一订阅（useResourceChannel + query-key 工厂 + inbox channel） | L | T5/T1/T6 | 15 |
| 16 | LangProfile 语言注册中心 + def 索引器收口 | L | T5/T1 | 08 |
| 17 | scheduler god-module 裂解（dispatchLoop 外移 + 解循环依赖） | XL | T3 | 02 |
| 18 | WS 频道注册表 + after-commit hook + ticker registry | L | T5/T6/T4 | 13 |
| 19 | 知识载体清账（design.md/i18n/注释与实现归一 + 文本守卫） | M | T7 | 03/04/05/06/11 |
| 20 | 嵌套/per-shard/多组合维度实现（依赖 rank 9 落地后） | XL | T3/T5 | 03 |

### 详述（关键条目 + 护栏次序）

**rank 1 — P1 漂移 bug 急修批**（M，先做，低风险高收益，逐条带红测）。这些是 T1 已咬人的实例，每条修复都是「先写复现红测、再修、文本断言锁意图」：
- 01-LIFE-05 resume latestPerNode 加 `parentNodeRunId===null` 过滤 + fanout 子行回滚红测；01-LIFE-06 retryNode 补 commitPush 透传 + deps 一致性单测。
- 06-OCI-06 `accumulateTokens` 读 `cache.read/write`+`reasoning`，parser-guard 加「framework total === fixture opencode 自报 total」「cacheRead>0」硬断言（这条若早存在当场红）。
- 05-PORT-06/07 fanout 改调 `splitListItems`/kind-aware 分割；05-PORT-02 信封改容器分隔（端口边界靠下一个 `<port name=` 起点而非 `</port>` 匹配）+ 完整内容相等回归（替换 `toContain`）。
- 07-GIT-04 GC join task_repos 逐子仓清理 + prune；07-GIT-05 多仓部分失败回收。
- 10-ACL-07 postLoginRedirect 同源白名单；10-ACL-09 登录失败计数退避；10-ACL-08 补 link/start 端点或删死分支。
- 11-MEM-06 终态删 `fusions/{id}` + 修 design.md:304；04-WFM-06 校验器 builtin 集从 `prompt.ts:BUILTIN_VARS` import 同源。

**rank 2 — 状态写入护栏批**（M，先于任何状态机重构）。把「该用事务的地方都用事务」立成纪律：热路径多写（铸行+outputs+events、status 转移+快照）注入「第一步成功第二步抛错」断言其回滚（13-INFRA-10），驱动纳入 dbTxSync；加 schema enum ↔ migration CHECK ↔ shared zod 三方一致性契约测试（13-INFRA-11）；补融合并发 approve / reconcile-cancel-race oracle（11-MEM-13，会直接逼出 CAS 修复）。**这批是 rank 3 的安全网。**

**rank 3 — 状态机单一事实源对称化**（M）。引入 `nextTaskStatus`/`allowedFromForTaskEvent`（对称 node_run 已有的好模型 `lifecycle.ts:87`），调用点传事件不传手抄数组；融合/蒸馏复用同一 `trySetStatus` CAS；mint 工厂对 born-park/failed 加 post-mint 钩子（单一汇聚点）。护栏：task 版 transition-table property test（01-LIFE-10）。

**rank 4 — NodeKind 单一描述符**（L，扩展性 #1 瓶颈）。先抽 `deriveNodePorts(node,def,agentByName)` 纯函数到 shared（消除画布/校验器/调度器三份漂移，scheduler-audit 既有待办「computeNodeOutputs 抽共享」），护栏：三方对同一 def 给出相同端口集的对比测试。再升级为 `NodeExecutor`/前端 `nodeKindRegistry` 注册表（satisfies 穷举）。这条同时给 rank 9（runScope 统一）和前端 rank 14 铺路。

**rank 6 — OpencodeProcess 适配层**（M，先于任何 opencode 版本升级）。抽 `util/opencodeProtocol.ts`（事件 shape/token/sessionID/DB 路径，认 channel+`OPENCODE_DB`）+ `opencodeProcess.ts`（spawn+组杀+reap+pump），runner/distiller/fusion 共享。护栏先行：recording-replay 进每 PR gate（不花钱纯回放），把 OCI-06 类漂移挡在门外。

**rank 9 + rank 20 — runScope 统一引擎 / 组合维度实现**（XL，最大结构重构，必须在 rank 4/7/8 之后）。fanout 改「拆 shards（可插拔 ShardingStrategy）→ 每 shard 一次 runScope」，iteration 升级为 scope 路径栈。**护栏次序极重要**：先以「既有 scheduler/clarify/review/loop/fanout 套件 + e2e 全绿」为等价锚（RFC-076 R2 同款），删除 validator 的「禁入嵌套/链」止血墙必须在实现支持之后、且每步零行为变更先抽纯函数再 wire。**在此之前 validator 禁入是正确且应保留的止血**——但要在 design/UI 诚实标注「v1 不支持嵌套」，停止宣传不存在的能力（rank 19）。

**rank 17 — scheduler god-module 裂解**（XL）。`runScope`+`deriveFrontier` 外移成 `dispatchLoop.ts`（对节点执行经 `NodeRunner` 接口注入），先解 `scheduler.ts↔task.ts` 循环依赖（binary-build module-cycle 风险，memory 记载）。依赖 rank 4（executor 注册表）+ rank 8（coordinator）先落。

---

## 5. 扩展性原则（硬规则清单）

以后加功能必须遵守，使未来扩展不再引发本次发现的坍塌。建议逐条配 CI 文本/契约守卫（CLAUDE.md「最低限度保留一条源代码层文本断言」）：

1. **新状态/新转移必须走转移表**：禁止任何 `db.update(X).set({status}).where(eq(id))` 不带 `status IN (allowedFrom)` 的状态写；task/node/fusion/distill 共用 `trySetStatus`，转移合法性来自 `nextXStatus(from,event)` 单表（`never` 穷举）。grep 守卫禁裸 status update。
2. **新 output-kind 只改 capability 注册表**：禁止在 scheduler/validator/uiCatalog/shardingRegistry 手写 kind 字面量分支；boot guard 必须交叉校验**所有**维度（不止 base-name/dataBearing）。
3. **新 NodeKind = 加一条 executor 记录**：端口推导唯一走 shared `deriveNodePorts`；`NodeExecutor satisfies Record<NodeKind,...>` 编译期逼填全维度；orphans/limits/gc/shutdown 查矩阵不得 kind-blind 散查。
4. **新资源类型复用 `RESOURCE_DESCRIPTORS`**：禁止 fork CRUD/闭包/反向扫描/inline 注入/ACL gate；新资源 = 描述符 + permission 对。前端同理走 `makeResourceRoutes(descriptor)`。
5. **新语言 = 加一条 `LangProfile`**：禁止新增第 9 张 per-language 表或 `lang==='x'` 硬分支；一条断言锁「每 LangId 每表齐全」。
6. **新「跑 opencode」调用者必须用 `spawnOpencode` 原语**：禁止再 copy spawn/env/kill；所有协议字段读 `opencodeProtocol`（带「适用版本」注释）。
7. **新 worktree 操作必须经 `WorktreeSet`/`worktreeLifecycle`**：create/snapshot/rollback/remove 唯一 owner；禁止散写 `git worktree add/remove`、禁止漏 `task_repos` 维度。
8. **新人工把关交互实现 `HumanGateInteraction` 接口**：禁止在 scheduler 加第 N 个 `isXxxRerun` 布尔门；prompt 走 `PromptFragment[]` 不加具名可选参；交互状态写经 clarify_rounds mapper（单事实源）。
9. **新记忆源/scope = 加一个 provider**：distiller/inject/detail/ACL 遍历注册表，禁止散加 switch 分支。
10. **新 WS 频道实现 `Channel` 接口**：`filterFrame` 是必填方法（ACL 编译期强制不漏）；前端 invalidation 走 `useResourceChannel` 注册表 + 单一 query-key 工厂。
11. **新前端 UI 走公共组件唯一入口**：禁止新原生 `<input>/<select>/<table>/<input type=checkbox>` 布尔开关、新 `error-box`、inline loading、本地 `describeError`、`t(key,{defaultValue})` 旁路 i18n——CI grep 守卫白名单原语文件。
12. **热路径多写必须原子**：成对 insert+update 进同一 `dbTxSync`；副作用（WS publish）注册到 after-commit hook，不在事务体内发帧。**禁止「声明转移表/注册表却不接线运行时」**——要么真接线，要么标 `Reserved/not-wired` 移出强制穷举类型（杜绝假集中陷阱 T2）。

---

## 6. 风险矩阵 / 不做的代价

| 主题 | 现在不做的代价 | 触发概率 | 建议 |
|---|---|---|---|
| **rank 1 漂移 bug** | token 限额按 ~1/15 失效→资源失控；`list<markdown>` fanout 静默错分片；嵌套 `</port>` 静默截断丢内容；OIDC 重定向→会话劫持；多仓 worktree 永久泄漏吃满盘；融合临时仓单调增长 | 高（多数已可复现/fixture 可证） | **立即做**，逐条红测 |
| **rank 2/3 状态写入 + 状态机** | 崩溃落在多写中间留半态（clarify/review/fusion 半提交）；task allowedFrom 漂移→静默非法转移或假拒绝；融合双 approve/reconcile-cancel 终态不确定 | 中（窄窗口，但 S-10/R2 已实证复发过） | 早做，是后续重构地基 |
| **rank 4/5 NodeKind/output-kind 注册表** | 每加一个组合原语节点扫改 16-24 文件、必有人漏改一处静默走错；review 端口 bug 类回归重演 | 高（产品迟早加 subworkflow/transform 节点） | 高 ROI，先抽纯函数 |
| **rank 9/20 runScope 统一 + 组合维度** | CLAUDE.md 产品承诺「wrappers nest arbitrarily」降级为「v1 几乎不能嵌套」；fanout 困在「单 agent 扇出」无法做 per-shard 审计→修复链（Code→Audit→Fix 的核心场景之一） | 中（取决于产品是否推嵌套/per-shard） | XL，必须 rank 4/7/8 后；在此之前 validator 禁入是正确止血 |
| **rank 8 SchedulerCoordinator** | N 并发任务 = N×4 opencode 进程（真实 LLM 成本+句柄+内存），无全局兜底；settings 改并发对在跑任务无效 | 中（多任务并发即触发） | 中等，与 rank 7 同期 |
| **rank 14/15 前端收敛强制力** | 即便补齐组件，无 grep 守卫下一个 RFC 照样各写一份（RFC-035 当天即被绕过实证）；同一错误码一半显翻译一半显裸码持续 | 高（每个新 RFC） | 守卫骨架先行，否则组件白做 |
| **T6 单进程焊死** | 产品走团队服务器时撞墙：双 daemon 重复 cancel、广播不跨进程、SQLite 单写瓶颈 | 低（取决于产品方向） | **现在只需 design 显式标注接缝、停止焊死新假设**，不必实现 |
| **rank 19 知识载体清账** | 新 session 按 design.md 照已删的 agent-multi 去扩展、撞墙才发现；融合 GC 承诺误导 | 高（仓规要求先读 design） | 纯文档/注释可直接提交（仓规例外），低成本 |

**不做的总代价**：项目会停留在「正确性高、但每次扩展都付出一次散弹改 + 一次漂移风险」的稳态——功能能加，但加得越来越慢、每加一个就埋一颗未来回归地雷，且核心卖点（嵌套 wrapper、per-shard 鲁棒审计、团队部署）受结构制约无法兑现。**好消息**：P0=0 说明地基（正确性网 + 纯函数大脑 + 部分单一事实源）已经够稳，重构是「在稳地基上换躯干」而非「拆地基」——风险可控，且 output-kind registry / node_run 状态机已提供仓内自证的好样板，重构方向不是发明而是**把好样板推广到其余子系统**。

---

## 附. 各子系统报告索引

| key | 报告 | P0/P1 | 一句话 |
|---|---|---|---|
| 01-task-lifecycle | `01-task-lifecycle.md` | 0/3 | node_run 状态机治理成熟，task 级有 CAS 无转移表、三入口抄 kick 块（retryNode 漏 commitPush）、不变式纯事后扫描 |
| 02-scheduler-dispatch | `02-scheduler-dispatch.md` | 0/1 | 派发大脑已抽纯函数，躯干仍是 4962 行 god-module + runOneNode 1144 行 + 三套 wrapper 各写一份 |
| 03-fanout-wrappers | `03-fanout-wrappers.md` | 0/4 | 单层稳健靠 validator 禁入锁死所有组合；`list<T>` 按 `\n` 硬编码、死 diffSplit 与新 registry 并存、design 漂移 |
| 04-workflow-model | `04-workflow-model.md` | 0/7 | 校验器 1645 行命令式巨链；NodeKind→端口三处各写一份已漂移；多仓 token 误报阻 launch |
| 05-port-output-kind | `05-port-output-kind.md` | 0/4 | 全仓最佳可扩展样板，但 PR-D 删 legacy 承诺未兑现、kind 横切切 5 表、信封裸正则嵌套截断 |
| 06-opencode-integration | `06-opencode-integration.md` | 0/4 | 捕获层 BFS 质量高，启动/协议层脆弱单点、cache token 漂移 15×、3-4 处 spawn 各写一份 |
| 07-git-worktree | `07-git-worktree.md` | 0/4 | git 原语干净，worktree 生命周期无单一 owner（创建 3 处/回滚 5 处/清理 1 处），多仓 GC 恒失败泄漏 |
| 08-structural-diff | `08-structural-diff.md` | 0/4 | 全仓质量最高之一，但加一门语言碰 8 表 + 11 硬分支、两套 def 索引器漂移 |
| 09-clarify-review-collab | `09-clarify-review-collab.md` | 0/5 | clarify 状态横跨 3 表 8 处双写、prompt 组装 16 布尔门，统一只统一了表与 REST |
| 10-resource-acl-auth | `10-resource-acl-auth.md` | 0/3 | ACL 单一事实源 + prompt 隔离双层锁，但五资源硬编码枚举 + 认证侧三洞（重定向/暴破/死代码） |
| 11-memory-fusion | `11-memory-fusion.md` | 0/2 | 记忆长链成熟，融合引擎后门复用 task：无 CAS 状态机 + 永不回收临时仓 + clarify 反喂蒸馏递归回路 |
| 12-agent-skill-mcp-plugin | `12-agent-skill-mcp-plugin.md` | 0/3 | 分层最干净 ACL 收口最好，但四资源无共同抽象，CRUD/闭包/版本 fork 3-5 份开始漂移 |
| 13-db-config-infra | `13-db-config-infra.md` | 0/5 | 单机单进程落地干净，但 dbTxSync 只覆盖装饰性遗址、热路径零事务、schema 1547 行迁移只进不退 |
| 14-frontend-canvas-editor | `14-frontend-canvas-editor.md` | 0/5 | 纯逻辑层优秀（18 预言+78 测试），WorkflowCanvas 1828 行/NodeInspector 1486 行双 god-component |
| 15-frontend-data-layer | `15-frontend-data-layer.md` | 0/5 | WS/fetch 原语干净，缺资源→channel→invalidation 统一层，实时性严重不对称（fusion 纯轮询） |
| 16-frontend-ui-system | `16-frontend-ui-system.md` | 0/5 | 原语库质量高，收敛靠 CSS class+人工自觉无强制力，新功能照样各写一份 chrome |
| 17-frontend-routes-features | `17-frontend-routes-features.md` | 0/5 | 表单/弹窗近满分，三态壳 + 资源 CRUD 脚手架仍手写绕过，11 份 describeError 副本不走 i18n |
| (既有) scheduler-audit | `../scheduler-audit-2026-06-10.md` | 2/9 | 7 根因 R1-R7，WP-1~10 路线；S-1/S-8/S-12/S-15/S-17/S-22/S-24/S-28 多已 RFC-092/095/097/098 闭环 |
| (既有) dedup-audit | `../dedup-audit-2026-06-13.md` | — | 68 项确认重复，核心结论「公共原语已存在却被绕过各写一份」，9 处已漂移成 bug |
| (既有) ux-audit | `../ux-audit.md` | — | RFC-035 前盘点，9 缺口多已被 RFC-035 修复（16/17 报告验证「修完又漂回来什么」） |
