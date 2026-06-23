# DB schema / 事务 / 守护进程 / 基础设施 — 架构审计 (2026-06-23)

子系统 key：`13-db-config-infra`
代码基线：`c876530`（2026-06-23 working tree）

## 0. 健康度一句话

基础设施层「单文件单进程」的朴素假设落地得很干净（原子配置写、WAL backup、graceful shutdown、单实例锁都对），但有两个系统性架构债：**事务原语（`dbTxSync`）只覆盖了 5 处「装饰性事务」遗址，调度/runner/task 这条真正高频的多写热路径全程零事务**；以及 **schema.ts 已膨胀到 1547 行 / 27 表、迁移只进不退、每张表的 `schema_version` 列从未被写过——演进策略已到天花板**。两者都不是 bug，是「再加一个 RFC 就更难收口」的扩展性瓶颈。

## 1. 当前架构与职责

单 Bun 进程守护：`cli/start.ts` 串起 lock → config → opencode probe → `openDb`(WAL+migrate) → token/secretBox → `Bun.serve`(HTTP+WS) → 8 个后台 ticker → graceful shutdown。DB 是 drizzle + bun:sqlite 单文件（`db/client.ts`），schema 单文件 1547 行（`db/schema.ts`），迁移由 drizzle-kit 生成、daemon 启动时自动 apply（`db/client.ts:39-41`）。事务唯一合法面是 `db/txSync.ts`（RFC-093）。WS 是进程内 pub/sub（`ws/broadcaster.ts`）+ Bun adapter（`ws/server.ts`）。配置是 `~/.agent-workflow/config.json`，原子 tempfile+rename 写（`config/index.ts`），schema 在 `packages/shared/src/schemas/config.ts`。

关键文件：`db/schema.ts`、`db/client.ts`、`db/txSync.ts`、`config/index.ts`、`packages/shared/src/schemas/config.ts`、`main.ts`、`cli/start.ts`、`server.ts`、`ws/{broadcaster,server}.ts`、`services/{shutdown,gc,eventsArchive,limits,backup,systemResources}.ts`、`util/paths.ts`。

## 2. 设计问题（Design）

**[INFRA-01] `dbTxSync` 只修了「坏掉的事务」，没建立「该用事务的地方都用事务」的纪律** — 级别 P1｜类型 design/coupling｜证据 `db/txSync.ts`、`services/scheduler.ts`（21 处 `.update/.insert/.delete`，`dbTxSync` 命中 0）、`services/runner.ts`（0）、`services/task.ts`（0）；S-10 守卫 `tests/scheduler-audit-s10-async-transaction-decorative.test.ts:138 EXPECTED_ASYNC_TX_SITES={}`｜影响：RFC-093 的叙事是「S-10 五处装饰性事务 = 全部需要原子性的地方」，但那只是「曾经写错的 5 处」。真正高频多写的热路径（node_run 铸行 + status 转移 + output 写 + 快照写，散布在 scheduler/runner/task）从来没有事务包裹——崩溃落在中间就是半态。S-16（13 处裸 insert）、S-11（先销毁后恢复）、R2（approve 半提交）全是同一根因「多步写无原子边界」的不同切面，而守卫测试只盯 `.transaction(async` 这一种**写法**，对「根本没事务」零防护。这是把「禁止一种错误写法」误当成「保证了原子性」。｜建议：把 S-16 的 nodeRunMint 单工厂（已存在 `services/nodeRunMint.ts`）+ status 转移（`services/lifecycle.ts`）的「铸行+建 outputs+建 events 锚」收进 `dbTxSync`；新增一条源码层断言「scheduler/runner 里成对的 insert+update 必须在同一 dbTxSync」难以机械化，至少在 design 里把「哪些写序列是原子单元」列成清单，避免下一个 RFC 又各写一份。

**[INFRA-02] WS `publish()` 在事务 COMMIT 之前触发——回滚后订阅方已收到未提交状态的帧** — 级别 P2｜类型 design｜证据 `services/memory.ts:314,382,389`（`publish` 在 `dbTxSync` 体内、后面还有 `tx.update`/抛错路径）；RFC-093 design.md:56「publish 留在事务体内…比现状更安全」｜影响：`dbTxSync` 的 COMMIT 只在 `db.transaction` 包装返回时发生，而 `publish`（→`broadcast`→同步遍历 listener）发生在体内。promoteCandidate 的 reject 分支（:314）publish 后还要 select；approve 分支（:382）publish 后还有 select；若未来在 publish 之后追加一条会抛错的写，事务回滚但帧已发出。现状之所以「碰巧安全」，是因为 ws/server.ts 的订阅方在 send 前先跑 `async canViewMemory`（微任务，落在 COMMIT 之后）——这是隐式依赖订阅方异步、不是事务原语的保证。RFC-093 把这点写成「更安全」，是对边界条件的乐观陈述。｜建议：把 publish 收集成 `tx` 体外的「after-commit hooks」——dbTxSync 返回后再 flush（参考 `services/lifecycle.ts` 若已有 post-commit 模式，复用之）；至少把 publish 移到每个分支的最后一条语句之后、return 之前，并在 dbTxSync 注释里写明「体内 publish = 在 COMMIT 前可见，禁止其后再有写」。

**[INFRA-03] schema 演进只进不退，且 27 张表的 `schema_version` 列是死重** — 级别 P2｜类型 design/extensibility｜证据 `db/schema.ts` 全表都有 `schemaVersion: integer('schema_version').notNull().default(1)`（agents:72、skills:253、tasks:439…共 ~14 张表带列），全 src 无任何 `.set({ schemaVersion })` / 自增点（grep 确认）；迁移 48 个 `.sql`、无 down 迁移、`db/migrations/meta/` 只有 forward snapshot｜影响：design.md:133/523 当初设想 per-row schema_version 用于「旧行渐进迁移」，但实际从未启用——每次字段演进都靠「新增 nullable 列 + NULL=legacy 语义」（schema.ts 里 ~30 处「NULL on pre-RFC-xxx rows」注释印证）。这意味着：(a) per-table schema_version 是占位死列，误导读者以为有行级版本协议；(b) 真正的演进契约是「nullable + NULL 兜底」的口头约定，散落在 30 处注释里，没有单一事实源；(c) 无 down 迁移 → 升级即不可逆，回滚 daemon 版本会撞到「新列已存在但旧代码不认识」（SQLite 容忍多余列，但若新迁移加了 CHECK/NOT NULL 就炸）。｜建议：要么真正启用 per-row schema_version（写一个 lazy-upgrade 读路径），要么把这些列标注为 reserved/废弃并停止给新表加；把「nullable+NULL=legacy」升格为显式的 migration policy 文档（design 里一节），让下一个 RFC 不必逐个发明兜底语义。

**[INFRA-04] `config.json` 只有 forward-merge、`$schema_version` 永久冻在 1、无迁移路径** — 级别 P2｜类型 design｜证据 `config/index.ts:39-48`（mergeDefaults 后直接 ConfigSchema.parse）；`packages/shared/src/schemas/config.ts:7 CONFIG_SCHEMA_VERSION=1` + `:33 $schema_version: z.literal(1)`；design.md:523 曾规划 v1|v2|v3｜影响：config 演进靠「新字段全 optional + DEFAULT_CONFIG 兜底」，这对加字段够用，但 `$schema_version` 用 `z.literal(1)` 锁死——一旦真需要破坏性 config 变更（重命名字段、改类型），没有 migrate 钩子，旧 config.json 会直接 `validation failed` 让 daemon 拒绝启动（loadConfig:44 throw）。当前所有字段恰好都 optional，所以问题被掩盖；这是「设计预留了版本号但没建版本迁移机制」的悬空契约。｜建议：在 loadConfig 里加一个 `if (raw.$schema_version < CURRENT) migrateConfig(raw)` 分支（哪怕 v1→v1 是 no-op），把 literal 改成 `z.number()` + 显式 range 校验，给未来的破坏性变更留路。

**[INFRA-05] 8 个后台 ticker 各手写一份「self-throttling setInterval」骨架** — 级别 P3｜类型 extensibility/coupling｜证据 `let running = false` 五处：`gc.ts:119`、`eventsArchive.ts:213`、`limits.ts:104`、`stuckTaskDetector.ts`、`lifecycleInvariants.ts`；外加 `repoBatchImport`/`memoryDistillScheduler`/`fusion` 各自的 loop｜影响：已被 dedup-audit-2026-06-13.md #37 `self-throttling-background-ticker`（5 份 → `util/ticker.ts`）覆盖。架构视角补充：除了重复，这 8 个 ticker **没有统一的 lifecycle 注册表**——`cli/start.ts:334-341` 手工 `.stop()` 八次，加第 9 个 ticker 必须记得在 start.ts 三处（创建、shutdown stop、import）都改。｜建议：抽 `util/ticker.ts` 的同时建一个 `TickerRegistry`，start.ts 只 `registry.startAll()` / `registry.stopAll()`，新 ticker 注册即自动纳入 shutdown。

## 3. 实现问题 / Bug（Impl）

**[INFRA-06] `backup`/`migrate` CLI 在 daemon 运行时开第二条连接并重跑迁移** — 级别 P2｜类型 impl-bug/coupling｜证据 `cli/backup.ts:13` 与 `cli/migrate.ts:12` 都 `openDb({path: Paths.db, migrationsFolder})`（未 `skipMigrations`）→ `client.ts:39 migrate(db,...)`｜影响：`agent-workflow backup` 设计成「随时可跑」，但它会对 live db 文件开第二个 WAL 连接并执行 `migrate()`。若此刻 daemon 正在 apply 一个新迁移（升级窗口），两个进程同时写 `__drizzle_migrations` + DDL，SQLite DDL 不能并发 → 第二个连接撞 `database is locked`（busy_timeout 5s 后 throw）或更糟的半 apply。VACUUM INTO 本身安全，但「顺带重跑迁移」是不必要的副作用。｜建议：backup/migrate CLI 用 `skipMigrations: true` 打开（backup 只读、migrate 应该是显式独占操作并先检测 daemon 是否在跑 lock）。

**[INFRA-07] graceful shutdown 用非 CAS 的 `db.select where status='running'` 轮询，与 stuck/limit ticker 抢同一批行** — 级别 P3｜类型 impl-bug｜证据 `services/shutdown.ts:27,33`（裸 select）+ `:41 trySetTaskStatus`（CAS，正确）｜影响：shutdown 在 budget 内每 100ms 全表扫 `status='running'`（无 limit、无索引提示——其实 `idx_tasks_status` 覆盖），与 limitsTicker(1Hz) / stuckDetector 并发读同一集合。CAS flip 那步是对的（已按 S-14 用 trySetTaskStatus），只是轮询 select 在大表上每 100ms 全量拉行 + 物化所有列（`select()` 无投影）。低频且只在关机时，影响小。｜建议：`select({id})` 窄投影 + `count(*)` 判退出，避免每轮物化全行。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 重点

**[INFRA-CP1] 加任何一张新表 = 改 schema.ts(1547 行单文件) + 生成迁移 + 手写 shared zod + 决定 NULL 兜底语义，四处无强制同步** — 级别 P1｜类型 extensibility｜未来场景：半年后加「task 标签 / 审批流 / 第二种 fusion」任意一个新实体。根因：`db/schema.ts` 顶注（:1-6）口头要求「改 schema → drizzle generate → 更新 shared zod」，但没有任何机制保证三者一致；schema 列定义与 `packages/shared/src/schemas/*` 的 zod、与「NULL=legacy」语义（30 处注释）是三份手抄。现在加表要碰：schema.ts、`drizzle-kit generate`、shared zod、可能的 CHECK（只能手写进 .sql）、迁移里的 backfill。目标形态：(a) schema.ts 按域拆分（agents/tasks/clarify/memory/auth 各一文件，barrel 导出），单文件不再 1547 行；(b) 从 drizzle schema 派生 zod（`drizzle-zod`）消除手抄 zod 这一份；(c) 把「列 + 兜底语义」收进列级注释规范或 codegen，让 legacy 兜底不再是 ad-hoc 注释。

**[INFRA-CP2] 加任何需要 CHECK 约束 / 数据回填的迁移都得手写 raw SQL，绕开 drizzle 的可回滚/可校验保证** — 级别 P1｜类型 extensibility｜未来场景：给新枚举列加 CHECK、给跨表不变量加约束、回填历史行（如 RFC-066 的 task_repos 单行回填）。根因：drizzle-kit 只生成 DDL，所有 CHECK（migration 0023/0031 等）和 backfill（0018/0021/0034/0046）都是人工 append 进 .sql；schema.ts 注释多次写「CHECK 在 migration 0023 enforce…我们这里保持 plain text 以免 drizzle over-narrow」（memories:1304、clarifyRounds:1025）——即**DB 真相（CHECK）与 TS 真相（enum）分裂**，drizzle 完全不知道 CHECK 存在。加新约束时：手写 .sql、记得同步 schema 注释、记得 shared zod 也加同样校验（第三份）。无 down 迁移意味着写错的 CHECK 无法回滚。目标形态：迁移分两层——drizzle 管纯 DDL，约束/回填走一个登记在案的「data migration」模块（带前后断言 + 幂等），并在 CI 里跑「schema enum ↔ migration CHECK ↔ shared zod 三方一致」的契约测试（现在完全没有）。

**[INFRA-CP3] 加新 WS 频道 = 在 broadcaster.ts 加 TypedBroadcaster + 在 server.ts 加 path 正则 + ConnectionData union + handleOpen case + 每帧 ACL 过滤逻辑，五处散改** — 级别 P1｜类型 extensibility/coupling｜未来场景：加「fusion 频道 / 审批收件箱实时频道 / 用户在线状态」。根因：WS 没有「频道」抽象，每个频道是 broadcaster.ts(一个全局 `new TypedBroadcaster`) + server.ts(WS_PATH_RE 正则 + ConnectionData.channel union 成员 + handleOpen 的一个 case + 一套 per-frame `cachedIsXVisible` ACL) 的硬编码组合。现有 6 个频道的 ACL 过滤逻辑（task/workflow/memory 各一套 async fire-and-forget + 缓存）是各写一份（dedup #49 `node-status-broadcast-frame` 已点名 4 份）。加第 7 个频道要碰 broadcaster.ts + server.ts 的 5 个点，且很容易漏掉 ACL（server.ts:326 注释自承「未知 shape 默认不发」是因为这套机制易漏）。目标形态：定义 `Channel<Msg>{ pathPattern, parseParams, authorize(actor, params), filterFrame(actor, msg) }` 接口，broadcaster + server 各自遍历一个 channel 注册表；新频道 = 实现一个接口对象并注册，ACL 过滤成为接口的必填方法（编译期强制不漏）。

**[INFRA-CP4] WS 是「全局广播 + 每连接 fire-and-forget 异步过滤」，无顺序/背压保证，扩到多连接或跨进程即崩** — 级别 P2｜类型 extensibility/perf｜未来场景：多用户并发 + 单任务上百 node_run 事件高频流；或将来真要起第二个 daemon 进程。根因：`broadcaster.broadcast` 同步遍历所有 subscriber（:33-46），每个 subscriber 对 task/memory/workflow 帧做 `cachedIsTaskVisible(...).then(send)`（server.ts:333,373,434）——这是 fire-and-forget，多个帧的 ACL 解析以微任务乱序完成，**帧到达客户端的顺序不保证 = 状态机 UI 可能先收到 done 再收到 running**。且无背压：慢消费者的 `ws.send` 失败只 warn 丢弃（safeSend:564）。注释（broadcaster.ts:4「single daemon → no cross-process bus needed」）把「单进程」当永久前提。目标形态：per-connection 串行发送队列（保序）；ACL 结果在 upgrade 时一次性解析 + 订阅时按频道粒度授权（task 频道已经这么做了，:203-216），让热路径的 per-frame DB 查询消失；若哪天要多进程，broadcaster 接口留好「换成 Redis/pg LISTEN」的替换点。

**[INFRA-CP5] 单文件 SQLite + 进程内广播 + 单实例锁是「单机单进程」硬假设，水平扩展无路径** — 级别 P2｜类型 extensibility/design｜未来场景：团队部署需要多副本 / HA。根因：架构在多处把「单进程」焊死——`util/lock.ts` flock 单实例（start.ts:46）、broadcaster 进程内 Map、limits/gc/stuck ticker 假定只有自己在跑（无分布式租约）。这对当前「本地编排工具」定位是**正确的取舍**（不算 bug），但 RFC-099 已经引入了多用户/ACL，product 方向若走向「团队服务器」就会撞墙：两个 daemon 同时跑 limits ticker 会重复 cancel、broadcaster 不跨进程、SQLite 单写者成瓶颈。目标形态：现在不必实现，但应在 design 里明确「单进程是边界」并把三个隐式假设（锁、广播、ticker 领导权）标注为「水平扩展时需替换的接缝」，避免后续 RFC 在更多地方焊死单进程假设。

## 5. 耦合 / 分层违规

**[INFRA-08] service 层直接 import 并调用 WS broadcaster（事务体内广播）** — 级别 P2｜类型 coupling｜证据 `services/memory.ts:38 import {memoryBroadcaster}` 并在 dbTxSync 内 `publish`；同模式遍布 services｜影响：service 与「向谁广播」强耦合，且广播发生在事务体内（见 INFRA-02）。理想分层：service 只返回「发生了什么变更」的事件值，由调用方（route/scheduler）在 commit 后决定广播。现在 service 既写库又广播，测试要 mock broadcaster，且无法在不发帧的情况下复用 service 逻辑。｜建议：service 返回 domain event，route 层 publish；或 dbTxSync 提供 after-commit hook（见 INFRA-02）。

**[INFRA-09] `cli/start.ts` 是 158 行的「上帝装配函数」，新增任何后台能力都要侵入它** — 级别 P3｜类型 coupling｜证据 `cli/start.ts:35-401`（lock/config/probe/db/reap/skill-reconcile/skill-version-reconcile/fusion-seed/token/secretbox/serve/8 tickers/shutdown 全在一个 async fn）｜影响：start 命令把「daemon 组合根」和「启动顺序编排」混在一处；加一个 boot-time reconcile（已有 5d/5e 两个 RFC 各塞一段）或一个 ticker 都要在这里手改，且顺序依赖隐式（migrate 必须在 reap 前、reconcile 在 serve 前）。｜建议：拆出 `bootstrap(db)`（reap+reconcile+seed 的有序步骤列表）和 `startBackgroundJobs(db,config)`（ticker 注册表），start.ts 退化为 6 行装配。

## 6. 测试 / 可观测性缺口

**[INFRA-10] S-10 守卫测试给人「事务安全已解决」的假安全感，但只测一种错误写法** — 级别 P2｜类型 test-gap｜证据 `tests/scheduler-audit-s10-async-transaction-decorative.test.ts:138,155`（断言 src 内 `.transaction(async` 零命中）｜影响：守卫只防「写了 async 事务」，对「该用事务却完全没用」（INFRA-01 的 scheduler/runner 21+ 处裸写）零覆盖。绿测试 + 「S-10 已修」的叙事让人误以为多写原子性有保障。｜建议：补一个「热路径多写原子性」的针对性测试——对 nodeRunMint / status 转移注入「第一步成功、第二步抛错」，断言第一步回滚；以此驱动把这些序列纳入 dbTxSync。

**[INFRA-11] 三方 schema 真相（drizzle 列 / migration CHECK / shared zod）无一致性测试** — 级别 P2｜类型 test-gap｜证据 schema.ts 的 enum 列、`db/migrations/0023/0031` 的 CHECK、`packages/shared/src/schemas/*` 的 zod enum 各自维护，无 cross-check（grep 无此测试）｜影响：三者漂移不会被任何测试抓住，正是 dedup-audit「公共原语被绕过各写一份」在 schema 维度的体现。｜建议：加契约测试，从 migration 里抽 CHECK 的取值集 ↔ schema enum ↔ zod enum 三方比对。

**[INFRA-12] 无 daemon 级运行指标（ticker 时长/失败计数、WS 连接数、DB busy/锁等待）** — 级别 P3｜类型 observability｜证据 ticker 失败只 `log.error`（gc.ts:125 等），无计数器；WS 连接数只有 `subscriberCount` 测试 helper（broadcaster.ts:49）；DB 无 busy_timeout 命中计数｜影响：「scheduler stalled」「socket hang up」这类生产问题缺乏可观测抓手，只能靠 log 翻找。｜建议：daemon 暴露 `/api/health` 扩展或内部计数器（ticker 上次成功时间、WS 活跃连接、DB 锁等待次数），喂给 doctor / status。

## 7. 目标形态（Target architecture）

1. **事务原语升级为「原子单元登记 + after-commit hook」**：`dbTxSync` 增加 `(tx, onCommit)` 签名，service 把 publish/副作用注册到 onCommit，dbTxSync 在 COMMIT 后 flush。scheduler/runner 的多写序列（铸行+outputs+events、status 转移+快照）统一收进 dbTxSync。守卫测试从「禁 async 写法」升级为「热路径多写必须原子」的行为测试。
2. **schema 模块化 + 单一真相派生**：schema.ts 按域拆分（barrel 导出，单文件 < 400 行）；zod 用 `drizzle-zod` 从 drizzle 派生，消灭手抄；per-table `schema_version` 死列要么真正启用 lazy-upgrade、要么标注废弃。
3. **迁移分层**：DDL（drizzle 生成）与 data/constraint migration（带前后断言、幂等、登记）分开；CI 跑三方 enum 一致性契约测试；config 加 `migrateConfig` 钩子并把 `$schema_version` 解锁为可演进。
4. **WS 频道注册表**：`Channel<Msg>` 接口统一 path/auth/filterFrame，broadcaster+server 遍历注册表；per-connection 串行发送保序；ACL 在订阅时授权而非每帧查库；为多进程预留替换接缝（不实现）。
5. **daemon 组合根拆分**：`bootstrap()`（有序 reconcile/seed）+ `TickerRegistry`（startAll/stopAll），start.ts 退化为薄装配；backup/migrate CLI 用 skipMigrations 只读打开 + lock 检测。
6. **基础可观测性**：ticker 健康、WS 连接、DB 锁等待计数器并入 status/doctor。

## 8. Top 风险与建议优先级

| 排序 | ID | 级别 | 类型 | 一句话 | 建议动作 |
| --- | --- | --- | --- | --- | --- |
| 1 | INFRA-01 | P1 | design/coupling | 事务原语只修了坏写法，调度/runner/task 热路径全程零事务 | RFC：热路径多写纳入 dbTxSync + 行为守卫 |
| 2 | INFRA-CP2 | P1 | extensibility | CHECK/回填迁移全手写 raw SQL，DB 约束与 TS enum 分裂、无 down | 迁移分层 + 三方一致性契约测试 |
| 3 | INFRA-CP1 | P1 | extensibility | 加表要四处手抄同步（schema/迁移/zod/NULL 语义）无强制 | schema 拆分 + drizzle-zod 派生 |
| 4 | INFRA-CP3 | P1 | extensibility/coupling | 加 WS 频道要散改 5 处且易漏 ACL | Channel 注册表接口，ACL 编译期强制 |
| 5 | INFRA-02 | P2 | design | publish 在 COMMIT 前触发，回滚后已发帧 | after-commit hook |
| 6 | INFRA-06 | P2 | impl-bug | backup/migrate CLI 开第二连接并重跑迁移，升级窗口撞锁 | skipMigrations 只读 + lock 检测 |
| 7 | INFRA-03 | P2 | design/extensibility | 27 表 schema_version 死列 + 迁移只进不退 | 启用或废弃；明确 migration policy |
| 8 | INFRA-CP4 | P2 | extensibility/perf | WS 全局广播+fire-and-forget 过滤，无保序无背压 | per-connection 串行队列 + 订阅时授权 |
| 9 | INFRA-10/11 | P2 | test-gap | S-10 守卫假安全感 + 三方 enum 无一致性测试 | 补原子性行为测试 + enum 契约测试 |
| 10 | INFRA-04 | P2 | design | config `$schema_version` 锁死无迁移钩子 | 加 migrateConfig + 解锁 literal |
| 11 | INFRA-05/09 | P3 | extensibility/coupling | 8 ticker 各手写骨架 + start.ts 上帝装配 | TickerRegistry + bootstrap 拆分 |
| 12 | INFRA-CP5 | P2 | extensibility/design | 单机单进程焊死，无水平扩展路径 | design 标注接缝，停止焊死假设 |

### 与既有审计的关系

- INFRA-01 在 scheduler-audit **S-10** 之上延伸：S-10 修了「装饰性事务」5 处，本报告指出真正的多写热路径（S-16 的 13 处裸 insert、S-11、R2 同根）仍零事务，守卫测试只防写法不防缺失。
- INFRA-05（ticker 重复）/ INFRA-CP3 的帧重复，**已被 dedup-audit-2026-06-13.md #37 / #49 覆盖**；本报告补的是「除重复外还缺统一注册表/频道抽象」的架构维度。
- INFRA-CP1/CP2/CP3/CP4/CP5、INFRA-02/03/04/06/10/11 为本次新增的架构/扩展性洞察，既有三份审计未涉及。
