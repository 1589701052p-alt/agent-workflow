# Codex 核验：DB schema / 事务 / 守护进程 (13-db-config-infra)

> 对应报告：`design/arch-audit-2026-06-23/13-db-config-infra.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **INFRA-01 属实，P1 合理**：`dbTxSync` 只是同步事务原语，注释还写明“ONLY sanctioned way”，但 `scheduler.ts` / `runner.ts` / `task.ts` 仍有大量多步裸写，如 `task` 创建先写 `tasks` 再写 `task_repos`，失败时只手工删 `tasks`：`packages/backend/src/services/task.ts:671`、`packages/backend/src/services/task.ts:719`、`packages/backend/src/services/task.ts:767`。runner 最终状态也先 CAS 改状态，再补写 JSON 字段：`packages/backend/src/services/runner.ts:1276`、`packages/backend/src/services/runner.ts:1308`。
- **INFRA-02 方向属实，但当前更像 P3 设计风险，不是已证实 bug**：`publish` 确实在 `dbTxSync` 体内，且 commit 发生在回调返回之后：`packages/backend/src/db/txSync.ts:31`；memory promote/patch 的 publish 后仍有读或日志：`packages/backend/src/services/memory.ts:314`、`packages/backend/src/services/memory.ts:382`、`packages/backend/src/services/memory.ts:513`。但当前路径未看到 publish 后还有会主动抛业务错误的写。
- **INFRA-04 属实，P2 合理**：config 只 merge defaults 后 parse，无版本迁移钩子：`packages/backend/src/config/index.ts:39`；schema 锁死 `z.literal(CONFIG_SCHEMA_VERSION)`：`packages/shared/src/schemas/config.ts:32`。
- **INFRA-05 / INFRA-09 属实但 P3**：后台 ticker 骨架重复，`start.ts` 手工创建/停止 8 个 ticker：`packages/backend/src/cli/start.ts:238`、`packages/backend/src/cli/start.ts:334`；多个 service 自带 `let running = false`。
- **INFRA-06 部分属实**：`backup` 确实 `openDb`，因此会自动 migrate：`packages/backend/src/cli/backup.ts:13`、`packages/backend/src/db/client.ts:39`。`migrate` 也会开库并 apply migration：`packages/backend/src/cli/migrate.ts:12`。
- **INFRA-07 属实但低风险 P3**：shutdown 每 100ms `select()` 全行轮询 running tasks，最后 CAS flip：`packages/backend/src/services/shutdown.ts:27`、`packages/backend/src/services/shutdown.ts:41`。
- **CP1/CP2 基本属实**：`schema.ts` 1547 行、34 张表，不是报告说的 27 张：`packages/backend/src/db/schema.ts`；迁移 48 个 SQL，仅 forward journal：`packages/backend/db/migrations/meta/_journal.json:4`。CHECK/回填确有手写 SQL，如 memories CHECK：`packages/backend/db/migrations/0023_rfc041_memories.sql:31`，fusion 重建 CHECK：`packages/backend/db/migrations/0048_rfc101_fusion.sql:45`。
- **CP3/CP4 属实但应定位为扩展性债**：WS channel 需要改 path regex、union、switch、broadcaster：`packages/backend/src/ws/server.ts:54`、`packages/backend/src/ws/server.ts:119`、`packages/backend/src/ws/server.ts:300`、`packages/backend/src/ws/broadcaster.ts:82`；per-frame ACL 是 fire-and-forget：`packages/backend/src/ws/server.ts:333`、`packages/backend/src/ws/server.ts:373`、`packages/backend/src/ws/server.ts:434`。

## REFUTED / 伪问题（给反证 file:line）

- **“flock 单实例锁”表述错误**：实现不是 POSIX flock，而是 PID 文件 `O_CREAT | O_EXCL`：`packages/backend/src/util/lock.ts:1`、`packages/backend/src/util/lock.ts:53`。仍是单实例锁，但失效模式不同。
- **“27 张表都有 schema_version”错误**：当前是 34 张 `sqliteTable`，只有部分表有 `schemaVersion`：`packages/backend/src/db/schema.ts:22`、`packages/backend/src/db/schema.ts:1527`；`schema_version` 定义命中约 12 处，不是全表。
- **“migrate CLI 应 skipMigrations”建议不成立**：`migrate` 子命令的语义就是手动 apply pending migrations，注释写得很清楚：`packages/backend/src/cli/migrate.ts:1`、`packages/backend/src/cli/migrate.ts:10`。正确问题是缺独占/lock 检测，不是 skip migration。
- **CP5 不是当前产品 bug**：设计明确单 daemon、本地单进程定位：`design/design.md:53`、`CLAUDE.md:144`。可要求文档标边界，但不能按“水平扩展无路径”上升为当前 P2 缺陷。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **user CLI 也会在 daemon 运行时开第二连接并自动迁移 — P2 — `packages/backend/src/cli/user.ts:67`、`packages/backend/src/cli/user.ts:78` —** 报告只点了 backup/migrate，漏了 `agent-workflow user ...`；它同样调用 `openDb` 触发迁移，升级窗口可能与 daemon 抢 DDL。
- **任务 launch 的补偿删除不完整 — P1 — `packages/backend/src/services/task.ts:671`、`packages/backend/src/services/task.ts:719`、`packages/backend/src/services/task.ts:755`、`packages/backend/src/services/task.ts:767` —** `tasks`、`task_repos`、collab rows 不在同一事务；`recordLaunchContext` 失败只删 `tasks`，依赖 FK cascade 才能清理 repo rows，若前面/后面加副作用会继续扩大半创建风险。
- **lock 不是 kernel flock，PID 复用会造成误判 — P3 — `packages/backend/src/util/lock.ts:2`、`packages/backend/src/util/lock.ts:58`、`packages/backend/src/util/lock.ts:60` —** stale lock 只按 PID 是否存活判断，PID 被无关进程复用时会拒绝启动，需要人工删锁。
- **config “atomic rename”缺 durability fsync — P3 — `packages/backend/src/config/index.ts:73`、`packages/backend/src/config/index.ts:77`、`packages/backend/src/config/index.ts:78` —** rename 原子性不等于断电持久性；崩溃/断电后仍可能丢最近一次配置写入。

## 建议批判（对目标形态 / 重构建议的评价与更优解）

- **after-commit hook 值得做，但不要把所有 service 事件都推到 route 层**：route 层无法覆盖 scheduler/ticker/runner。更优是 `dbTxSync(db, (tx, onCommit) => ...)`，保留 service 内 domain event 生成，但副作用统一 after commit flush。
- **schema 拆分可做，drizzle-zod 不宜一次性替换**：shared zod 目前承载 API 语义，不只是 DB shape。建议先做 enum/CHECK/zod 契约测试，再逐域派生，避免破坏兼容层。
- **迁移分层建议正确，但要保持 drizzle forward-only 现实**：不要追求完整 down migration；更实际的是幂等 data migration + 前后断言 + rolling-upgrade 测试。
- **TickerRegistry 合理，别把 start.ts 拆成过多框架**：这里是组合根，保留显式顺序有价值；可以先抽 `startBackgroundJobs()` 和 `bootstrapSteps[]`。
- **WS Channel 注册表合理，但多进程总线不应提前实现**：当前设计明确单进程。只需抽接口、保序队列和强制 ACL filter，不必引入 Redis/外部 bus。
- **必须保护既有不变量**：任务状态仍要通过 RFC-097 CAS helper；prompt/ACL 隔离不要把 per-frame filter 简化成无鉴权广播；runner 的 opencode env 优先级必须保留 `...process.env` 后覆写 `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT`：`packages/backend/src/services/runner.ts:730`。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：主要风险方向成立，但若干事实过期或夸大，尤其是表数量/schema_version、flock 表述、以及 migrate CLI 的修复建议。
