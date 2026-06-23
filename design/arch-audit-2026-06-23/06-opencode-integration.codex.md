# Codex 核验：opencode 进程集成 / 捕获层 (06-opencode-integration)

> 对应报告：`design/arch-audit-2026-06-23/06-opencode-integration.md` ｜ 独立 Codex/GPT-5 只读核验

## CONFIRMED（核实属实，必要时纠正严重级）

- **OCI-06 属实，P1 合理**：fixture 的真实 token 形状是 `tokens.cache.{write,read}`，且自报 `total=7523`（`packages/backend/tests/fixtures/opencode-recordings/1.15.5-with-envelope.ndjson:4`）；当前 `accumulateTokens` 只读 `cache_creation/cacheCreation` 与 `cache_read/cacheRead`，不读 `cache.read/write` 和 `reasoning`（`packages/backend/src/services/runner.ts:1787-1795`）。结果会写入 `node_runs.tok_*`（`packages/backend/src/services/runner.ts:1286-1290`），并被限额 tick 使用（`packages/backend/src/services/limits.ts:75-80`），所以不是单纯 UI 误差。

- **OCI-13 属实，P1 合理**：recording 测试只断言 `input/total > 0` 和内部自洽求和，没有对照 opencode 自报 `tokens.total`（`packages/backend/tests/opencode-recording-parser.test.ts:170-183`）。live integration 也只要求 input/output 非零，不要求 cache 命中或 total 一致（`packages/backend/tests/integration-opencode/opencode-live.integration.test.ts:257-276`）。PR 级真实 opencode workflow 只有 path filter（`.github/workflows/integration-opencode.yml:37-44`）。

- **OCI-05 属实，P2 合理**：普通 task/clarify/review/fusion 路径都解析 settings `opencodePath`（`packages/backend/src/routes/tasks.ts:72-81`、`packages/backend/src/routes/clarify.ts:42-53`、`packages/backend/src/routes/reviews.ts:132-143`、`packages/backend/src/routes/fusions.ts:32-42`），但 distiller 只读 `AGENT_WORKFLOW_OPENCODE_BIN ?? 'opencode'`（`packages/backend/src/services/memoryDistiller.ts:937-950`），生产调度没有传 opencodePath-aware spawn（`packages/backend/src/services/memoryDistillScheduler.ts:287-294`）。

- **OCI-08 属实，P2 合理**：本仓固定解析 `{xdgData}/opencode/opencode.db`（`packages/backend/src/services/sessionCapture.ts:85-89`），三个捕获路径复用它（`packages/backend/src/services/distillSessionCapture.ts:20`、`packages/backend/src/services/subagentLiveCapture.ts:29-33`）。opencode 1.17 源码确实支持 `OPENCODE_DB` 和 channel 后缀 DB（`/Users/wangbinquan/Documents/code/opencode/packages/core/src/database/database.ts:43-54`，channel 默认 local：`/Users/wangbinquan/Documents/code/opencode/packages/core/src/installation/version.ts:6-7`）。

- **OCI-09 属实，P2 合理**：runner 已有 detached、进程组 kill、SIGTERM→SIGKILL、reap deadline、stream pump（`packages/backend/src/services/runner.ts:765-777`、`packages/backend/src/services/runner.ts:981-1027`、`packages/backend/src/services/runner.ts:1638-1669`）；distiller 是普通 `Bun.spawn`，超时只 `child.kill('SIGTERM')`，并在 `child.exited` 后才读取 stdout/stderr（`packages/backend/src/services/memoryDistiller.ts:960-983`）。

- **OCI-01/02/03/04/11/12/14/15 基本属实，但严重级应偏架构债而非立即故障**：协议解析集中在 runner（`packages/backend/src/services/runner.ts:1734-1829`），distiller 自有解析（`packages/backend/src/services/memoryDistiller.ts:745-831`），spawn/build cmd/env 分叉（`packages/backend/src/services/runner.ts:1601-1615`、`packages/backend/src/services/memoryDistiller.ts:937-960`），版本探针仅 semver 下界且无 shape 校验（`packages/backend/src/util/opencode.ts:22-77`）。这些支撑报告的“适配层缺失”判断，但 OCI-01 标 P1 略重，更像 P2 架构风险，真正 P1 是 token 解析与测试漏网。

- **OCI-10 属实但只是 P3 coupling，不宜称 impl-bug**：四份 `resolveOpencodeCmd` 确有轻微分叉（`packages/backend/src/routes/tasks.ts:72-81`、`packages/backend/src/routes/clarify.ts:42-53`、`packages/backend/src/routes/reviews.ts:132-143`、`packages/backend/src/routes/fusions.ts:32-42`）；当前行为基本同归 fallback，风险主要是后续漂移。

## REFUTED / 伪问题（给反证 file:line）

- **OCI-07 结论不成立**：报告用 published plugin 类型说明 `Config` 只有 `plugin`（`/Users/wangbinquan/Documents/code/opencode/packages/plugin/src/index.ts:70-72`），但运行时实际传给 server plugin config hook 的是 opencode 内部 merged config `cfg`，它保留派生态 `plugin_origins`（`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/config.ts:111-115`、`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/config.ts:342-347`），并在 plugin runtime 直接使用 `cfg.plugin_origins` 载入外部插件（`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/plugin/index.ts:177-184`），随后把同一个 `cfg` 传给 hook（`/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/plugin/index.ts:240-244`）。因此 `aw-inventory-dump.mjs` 读取 `cfg.plugin_origins`（`packages/backend/src/opencode-plugin/aw-inventory-dump.mjs:188-195`）在当前 1.17.8 源码下不是已坏兼容点。

## MISSED（报告漏掉的：标题 — 级别 — file:line — 影响）

- **完整 user prompt 走 argv，长 prompt 会 E2BIG 启动失败 — High — `packages/backend/src/services/runner.ts:633-690` / `packages/backend/src/services/runner.ts:1601-1607` / `packages/backend/src/services/memoryDistiller.ts:615-707` / `packages/backend/src/services/memoryDistiller.ts:941-949` — 影响：runner 和 distiller 都把完整 prompt 作为 `opencode run <prompt>` 的 argv 参数。prompt 会拼接输入端口、协议块、review/clarify/memory 上下文，设计本身也承认 prompt_text 和大文本场景（`design/design.md:223`、`design/design.md:324`）。一旦超过 OS argv/env 上限，进程在协议层之前就失败，且统一适配层若不改传输方式仍解决不了。更优先的修法是确认 opencode 是否支持 stdin/file prompt；若不支持，应给本仓加 prompt size guard 和明确错误。**

- **OPENCODE_CONFIG_CONTENT “最高优先级”不完全成立 — Medium — `design/design.md:1588` / `/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/config.ts:467-474` / `/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/config/config.ts:523-532` — 影响：本仓设计把 inline agent 注入视为胜过同名 agent 的关键不变量，但 opencode 1.17 在加载 `OPENCODE_CONFIG_CONTENT` 之后还会合并 macOS managed preferences。常规用户不受影响，但企业/MDM 环境下同名 agent/config 仍可能覆盖平台注入。报告讨论 env merge 优先级时漏掉了这个例外；适配层应把它作为启动期诊断或文档化限制，而不是继续声称绝对最高。**

## 建议批判（对目标形态 / 重构建议的评价与更优解）

报告的目标形态总体方向正确：`opencodeProtocol` 收口事件解析、token、session id、DB 路径；`opencodeProcess` 收口 spawn/env/kill/pump；capture core 继续下沉公共 transcode/insert/dedup。这个不会天然破坏 RFC-097 状态机 CAS，只要状态写仍停留在 `setNodeRunStatus/transitionNodeRunStatus` 外层编排中，而不是塞进 process adapter。

需要收敛两点，避免过度设计：

- 不要先做“按版本分派”的大框架。更优先的是少量明确契约：当前 pinned/latest recording fixture、`step_finish tokens.total` 一致断言、DB path resolver、session id extractor、spawn kill 行为。等出现真实版本分叉再引入 version strategy。
- `CaptureSource` 的 HTTP/远程抽象目前偏未来态。先抽 `resolveOpencodeDbPath` + `captureInto` 足够；HTTP source 可等 opencode 暴露稳定事件接口再 RFC，否则容易把 SQLite walk 的细节过早泛化。
- `opencodeProcess` 必须同时解决“prompt 传输”问题，否则只是把 argv 上限 bug 集中到一个文件。
- 对 env merge 优先级要保守表述：inline config 对普通目录扫描更高优先级，但 managed preferences 是上游例外；不能把它写成不可破坏的不变量。

## 总评（sound / mostly-sound / flawed + 一句理由）

**mostly-sound**：核心风险（token 解析错误、测试漏网、distiller/runner spawn 分叉、DB 路径硬编码）证据充分；但 OCI-07 被当前 opencode 运行时源码反证，且报告漏掉了 argv 传大 prompt 这个更直接的进程集成风险。
