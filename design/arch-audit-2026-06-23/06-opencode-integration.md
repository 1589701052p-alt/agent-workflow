# opencode 进程集成 / 捕获层 — 架构审计 (2026-06-23)

> 子系统 key=06-opencode-integration。范围：opencode 启动与 env 注入、CLI 协议、
> 捕获层统一（session/subagent live capture）、对 opencode 版本的脆弱性、
> stub-vs-real 端到端缺口。证据均为 `file:line`（相对仓库根），并对部分断言做了
> 本机 opencode 源码（`/Users/wangbinquan/Documents/code/opencode`，**实际版本
> 1.17.8**）交叉印证。

## 0. 健康度一句话

捕获层的「读 SQLite + BFS」核心抽象（RFC-077）质量很高且对真实 schema 鲁棒，但
**启动/协议层对 opencode 输出格式的绑定是脆弱、单点、且已经漂移出一个 fixture
可证的 token 计量 bug**——同一套「驱动 opencode 子进程」的逻辑被 3 处独立 spawn
点各写一份（runner / distiller / models-probe），扩展任何「换协议字段、加 CLI 开关、
支持新 opencode 版本」都要散弹式改多文件，且没有任何 PR-级真 opencode 关口能挡住漂移。

## 1. 当前架构与职责

opencode 集成分三段：**启动层**（`runner.ts` 单节点 spawn + env 注入；
`memoryDistiller.ts:defaultDistillerSpawn` 蒸馏器 spawn；`util/opencode.ts` 版本探针；
`util/opencode-models.ts` 模型列表）；**注入层**（`buildInlineConfig` 拼
`OPENCODE_CONFIG_CONTENT`，`opencode-plugin/` 把 inventory dump 插件物化进 per-run 目录）；
**捕获层**（stdout `--format json` 实时泵 → `node_run_events`；`opencodeSessionWalk.ts`
统一 BFS 核心，被 `sessionCapture.ts`〔RFC-027 worker 收尾〕/`subagentLiveCapture.ts`
〔RFC-048 边跑边捕〕/`distillSessionCapture.ts`〔RFC-043 蒸馏收尾〕复用；
`sessionView.ts` 把事件拼回 `SessionTree`）。

关键文件：
- `packages/backend/src/services/runner.ts`（1836 行，单节点全生命周期 + 协议解析）
- `packages/backend/src/util/opencode.ts` / `util/opencode-models.ts`（探针/模型）
- `packages/backend/src/opencode-plugin/{index,transcoder}.ts` + `aw-inventory-dump.mjs`（RFC-029 清单）
- `packages/backend/src/services/opencodeSessionWalk.ts`（RFC-077 统一 BFS）
- `sessionCapture.ts` / `subagentLiveCapture.ts` / `distillSessionCapture.ts` / `sessionView.ts`
- `services/memoryDistiller.ts:defaultDistillerSpawn`（第二个 opencode spawn 点）

opencode 与框架间**没有任何统一的「launch/parse 适配层」**——协议知识（事件 type、
token 路径、envelope、sessionID、CLI 开关、env 名、DB 路径）以散点常量/内联字符串
分布在上述文件里。

## 2. 设计问题（Design）

**[OCI-01] 没有 OpencodeProcess 适配层：协议知识散落多文件、无版本边界** — 级别 P1｜类型 design ｜
证据：spawn 点 `runner.ts:765`、`memoryDistiller.ts:960`、`opencode-models.ts:46`、`opencode.ts:50` 四处独立；
协议解析 `extractTextFromEvent`/`inferEventKind`/`accumulateTokens` 仅在 `runner.ts:1734/1748/1778`，distiller 自己另解析 stdout（`memoryDistiller.ts:746/793`）；CLI 拼装 `buildCommand`（`runner.ts:1601`）与 distiller cmd（`memoryDistiller.ts:941`）各写一份 ｜
影响：opencode 是「权威 runtime」（CLAUDE.md 强制源码自取），但框架对它的每个绑定面（事件 shape / token 路径 / DB 路径 / env 名 / CLI flag）都没有单一收口点；版本漂移时改一个面要碰 4-6 个文件，且容易漏掉 distiller 这一支（见 OCI-05/06/08）｜
建议：抽一个 `services/opencodeProcess.ts`（或 `util/opencodeProtocol.ts`），把「拼 cmd + 拼 env + 解析事件流（text/kind/tokens/sessionID）」收成单一模块，runner 与 distiller 都走它；版本相关常量集中在这里，便于将来按 `probeOpencode().version` 做 shape 分派。

**[OCI-02] 协议解析是「猜形状」而非「按版本契约」，鼓励无声漂移** — 级别 P2｜类型 design ｜
证据：`accumulateTokens` 在 5 处候选对象 × snake/camel 双写里探测（`runner.ts:1778-1829`）；`extractTextFromEvent` 容忍 2 种 shape（`runner.ts:1734-1745`）｜
影响：「尽量兼容所有历史 shape」表面稳健，实则掩盖了「真实 shape 根本没被命中」的 bug——OCI-06 即此设计的直接后果（cache 字段名换了，探测器全 miss 仍静默返回 0）。容错越宽，越没有信号告诉你「我其实没解析到」｜
建议：解析器对「step_finish 出现但 token 字段一个都没匹配上」发 warn/计数；recording 测试断言应锁定**真实字段**（见 OCI-06 建议），把「猜」收敛成「按当前 pinned 版本的契约」。

**[OCI-03] MIN_OPENCODE_VERSION=1.14.0 但全部协议断言基于 1.15.x，且无上界/无运行时 shape 校验** — 级别 P2｜类型 design ｜
证据：`util/opencode.ts:22` `MIN=1.14.0`，注释明说「无上界」；CI 实际 pin `OPENCODE_VERSION: '1.15.5'`（`.github/workflows/ci.yml:19`）；本机/线上可装的真 opencode 已是 **1.17.8**（`/Users/wangbinquan/Documents/code/opencode/packages/opencode/package.json` version 1.17.8）｜
影响：探针只比版本号大小，不校验「这个版本的事件 shape / DB 路径 / 插件 hook 签名是否仍是我假设的样子」。1.14↔1.17 之间 opencode 已重写存储层（见 OCI-08）、改了 plugin config hook 签名（见 OCI-07）。版本门是「够新就放行」，却没人验证「够新 ≠ 兼容」｜
建议：探针在 daemon 启动时跑一次「真 opencode 冒烟」（dump 一个最小 session 的 step_finish/text 事件 + 探 DB 文件），把 shape 假设变成启动期断言而非运行期静默失败。

**[OCI-04] distiller 与 runner 是两条独立的「驱动 opencode」实现，已实质分叉** — 级别 P2｜类型 design / coupling ｜
证据：runner 用 `opts.opencodeCmd ?? ['opencode']`（来自 settings `opencodePath`，`runner.ts:1602`），distiller 用 `process.env.AGENT_WORKFLOW_OPENCODE_BIN ?? 'opencode'`（`memoryDistiller.ts:940`）——**两套二进制解析来源**；runner 有 `--thinking`（`runner.ts:1606`），distiller 没有；runner 有 detached+setsid+SIGTERM→SIGKILL 升级+reap deadline（`runner.ts:765/1638/1657`），distiller 只有一发 `child.kill('SIGTERM')`（`memoryDistiller.ts:971`）｜
影响：见 OCI-05（配置不一致 = 用户设了 opencodePath 但蒸馏不认）、OCI-09（distiller 无 kill 升级 = 蒸馏子进程可被孙进程吊住）。这是 dedup-audit「公共原语被绕过各写一份」结论在本子系统的实例，但比纯重复更糟——两份已经行为分叉。｜
建议：见 OCI-01；distiller 复用统一 spawn 模块后这些分叉自动消失。

## 3. 实现问题 / Bug（Impl）

**[OCI-06] cache token 静默丢失 + token.total 与 opencode 自报值不符（fixture 可证）** — 级别 P1｜类型 impl-bug ｜
证据：真实录制 fixture（opencode 1.15.5）的 step_finish token shape 为
`"tokens":{"total":7523,"input":465,"output":18,"reasoning":0,"cache":{"write":0,"read":7040}}`
（`packages/backend/tests/fixtures/opencode-recordings/1.15.5-with-envelope.ndjson`）；1.17.8 源码同形（`/Users/wangbinquan/Documents/code/opencode/packages/core/src/session/event.ts:197-205` 与 `v1/session.ts:240-249`：`tokens.cache.{read,write}`）。但 `accumulateTokens` 读 `tokens.cache_creation ?? cacheCreation` 与 `tokens.cache_read ?? cacheRead`（`runner.ts:1789-1790`），**都不匹配 `cache.read`/`cache.write`** → cacheRead/cacheCreate 恒 0；`reasoning` 字段**完全没读**。framework 的 `total = input+output+0+0 = 483`，opencode 自报 7523——差 ~15× ｜
影响：(a) 每个 task 的 token 计量缺失绝大部分（cache_read 通常是大头）；(b) `max_total_tokens` 限额（design.md:185/759 「`sum(tok_total) > max_total_tokens` 自动 cancel」）按错误的小值判定 → 限额形同虚设，是**资源失控/安全相关**；(c) UI/审计 token 数误导。parser-guard 测试漏网：只断言 `input>0`/`total>0`/`total===input+output+cacheCreate+cacheRead`（`tests/opencode-recording-parser.test.ts:175-183`），因两个 cache 项都为 0，等式自洽，**测试绿但数据错**，且没断言 framework total 与 opencode 自报 `tokens.total` 一致 ｜
建议：`accumulateTokens` 增加 `tokens.cache?.read`/`tokens.cache?.write` 与 `tokens.reasoning` 的读取；parser-guard 加一条「framework total 必须等于 fixture 内 opencode 自报 `tokens.total`」的断言（这条若早存在，此 bug 当场红）。

**[OCI-05] settings `opencodePath` 对蒸馏路径无效（双二进制解析来源）** — 级别 P2｜类型 impl-bug ｜
证据：所有任务/clarify/review/fusion 路径用 `resolveOpencodeCmd(configPath)` 读 settings `opencodePath`（`routes/tasks.ts:72`、`routes/clarify.ts:42`、`routes/reviews.ts:132`、`routes/fusions.ts:32`），threaded 进 runner；但 `defaultDistillerSpawn` 只读 `process.env.AGENT_WORKFLOW_OPENCODE_BIN`（`memoryDistiller.ts:940`），`runDistill` 的生产调用方（`memoryDistillScheduler.ts:287`，最终 `cli/start.ts`）不传 opencodePath-aware 的 `spawnFn` ｜
影响：用户在 Settings 配了非 PATH 的 opencode 绝对路径，任务能用、记忆蒸馏却仍找 PATH 上的 `opencode`——要么找不到（蒸馏静默失败重试），要么用错版本。配置语义不一致且无提示 ｜
建议：蒸馏 spawn 也读 `config.opencodePath`（统一到 OCI-01 模块），`AGENT_WORKFLOW_OPENCODE_BIN` 仅作 fallback。

**[OCI-07] inventory 插件读 `cfg.plugin_origins`，1.17.8 plugin config hook 已无此字段** — 级别 P2｜类型 impl-bug ｜
证据：dump 插件 config hook 读 `cfg.plugin_origins`（`opencode-plugin/aw-inventory-dump.mjs:193`）；1.17.8 plugin `Hooks.config` 签名为 `config?: (input: Config) => Promise<void>`，`Config` 只有 `plugin?: Array<...>`（`/Users/wangbinquan/Documents/code/opencode/packages/plugin/src/index.ts:70-73,225`），无 `plugin_origins` ｜
影响：对 ≥1.17 的 opencode，inventory 快照的 `plugins[]` 恒空（agents/skills/mcps 仍正常，因走 `client.app.agents()` 等仍存在的 SDK，`sdk.gen.ts:858`）。RFC-029 清单芯片缺插件项，但非数据丢失，UI 退化而已 ｜
建议：config hook 同时尝试 `cfg.plugin`（1.17 形）与 `cfg.plugin_origins`（旧形）；twin parity 测试覆盖两种 shape。

**[OCI-08] opencode DB 路径硬编码 `opencode.db`，未处理 channel 后缀 / `OPENCODE_DB` flag** — 级别 P2｜类型 impl-bug ｜
证据：`resolveOpencodeDbPath` 永远拼 `{xdgData}/opencode/opencode.db`（`sessionCapture.ts:85-89`）；1.17.8 实际路径逻辑：stable channel（latest/beta/prod）→ `opencode.db`，否则 → `opencode-<channel>.db`，且 `OPENCODE_DB` flag（绝对路径或文件名）优先（`/Users/wangbinquan/Documents/code/opencode/packages/core/src/database/database.ts:43-54`；`InstallationChannel` 默认 `"local"`，`installation/version.ts:7`）｜
影响：用户跑非稳定 channel 的 opencode（dev/nightly = `opencode-local.db` 等）或设了 `OPENCODE_DB` 时，全部三个捕获器找不到 DB → `opencode-db-not-found` marker，**subagent transcript 与蒸馏 transcript 静默丢失**（非 fatal 但用户看不到子代理输出）。本机当前是 stable，路径恰好对上，掩盖了这条 ｜
建议：DB 路径解析读 `OPENCODE_DB` env，并在 stable 文件不存在时回退探测 `opencode-*.db`（取最新 mtime），或直接探针时把 opencode 自报 DB 路径记下来。

**[OCI-09] distiller spawn 缺 kill 升级/进程组管理，孙进程可吊住蒸馏** — 级别 P2｜类型 impl-bug ｜
证据：`defaultDistillerSpawn` 用普通 `Bun.spawn`（无 `detached`）+ 单发 `child.kill('SIGTERM')`（`memoryDistiller.ts:960-975`），且 stdout/stderr 用 `new Response(child.stdout).text()` 在 `child.exited` **之后**才读（`memoryDistiller.ts:978-983`）——若子进程写满 pipe 缓冲且不退出，会和「等 exited 再读」互锁 ｜
影响：蒸馏子进程若 fork 了 MCP/docker 孙进程持有 pipe，SIGTERM 不传组、孙进程不被杀，蒸馏 tick 可被吊住直到超时（且超时只杀父）。runner 已用 RFC-098 的 setsid+组杀+reap deadline 解决同类问题（`runner.ts:1638/1657/796`），distiller 没享受到 ｜
建议：distiller 走 OCI-01 统一 spawn（带组杀 + 边跑边读 pump），删掉「先 exited 再 text()」的潜在死锁。

**[OCI-10] `resolveOpencodeCmd` 复制 4 份且已分叉成两个变体** — 级别 P3｜类型 impl-bug / coupling ｜
证据：4 处同名私有函数，`routes/clarify.ts:42` 与 `routes/reviews.ts:132` 有 `if (configPath === '') return undefined` 守卫，`routes/tasks.ts:72` 与 `routes/fusions.ts:32` 没有（验证：4 份 diff 见审计过程）｜
影响：`configPath === ''` 时，clarify/review 直接返回 undefined（走 PATH 默认），tasks/fusions 会 `loadConfig('')` 进 try/catch 再 fallback——结果同（都 undefined）但路径不同；将来若 `loadConfig('')` 改成抛非捕获异常或有副作用，tasks/fusions 先炸。这是 dedup-audit-2026-06-13 同类「绕过公共原语各写一份」的实例（**部分被该报告覆盖**），但此处已分叉值得单列 ｜
建议：提到 `routes/_shared` 或 `util/config.ts` 单一 `resolveOpencodeCmd`，4 处调用。

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节重点

**[OCI-CP1] 半年后「支持 opencode 新版本 / 适配上游协议变更」会逼人散弹改 4-6 文件**
- 触发场景：opencode 1.18 又改了 token 字段名 / 事件 type / step 语义（1.14→1.17 已发生多次）。
- 根因：没有 OpencodeProcess 适配层（OCI-01）；协议知识散在 runner 的 `extractTextFromEvent`/`inferEventKind`/`accumulateTokens`、distiller 的内联 stdout 解析、capture 的 DB 路径、插件 hook——**没有一个文件叫「opencode 协议定义」**。
- 现在加功能要碰：`runner.ts`（3 个解析器 + buildCommand + env）、`memoryDistiller.ts`（自己一套解析 + cmd + env）、`sessionCapture.ts`（DB 路径）、`opencode-plugin/aw-inventory-dump.mjs` + `transcoder.ts`（twin 两份）、fixture + parser-guard。
- 目标形态：`util/opencodeProtocol.ts` 单一收口 {事件 shape 解析、token 提取、sessionID 提取、DB 路径解析}，可按 `probeOpencode().version` 分派；runner/distiller/capture 只调它。版本升级 = 改一个文件 + 加一组 fixture。

**[OCI-CP2] 加「第 4 个 opencode 调用者」（如 lint-agent / 探索性 agent）必然再复制一份 spawn**
- 触发场景：未来要在框架里跑一个非 node-run 的 opencode（例如一次性「问 agent 一个问题」、或 RFC-101 已经新增了 fusion 用 runner）。
- 根因：runner 的 spawn 与 distiller 的 spawn 是两套独立实现，已分叉（OCI-04/05/09）。没有「给我一个配好 env+kill+pump 的 opencode 子进程」的原语。
- 现在加功能要碰：从 runner 或 distiller copy 一份 spawn + env 拼装 + kill 逻辑（并很可能漏掉 setsid/reap/opencodePath，重蹈 OCI-09）。
- 目标形态：`spawnOpencode({ cmd, cwd, env, signal, timeoutMs, onLine })` 原语，内含组杀+reap+背压 pump；所有调用者共享。

**[OCI-CP3] 捕获层只覆盖「opencode 自报 SQLite」，加「实时 HTTP 订阅 / 远程 opencode」要重写整条捕获链**
- 触发场景：opencode 暴露了 HTTP 事件端口（其内部本就有 server），或要驱动远程机器上的 opencode。
- 根因：捕获语义硬绑在「子进程退出后读本机 XDG SQLite + BFS parent_id」（`opencodeSessionWalk.ts` 全是 `bun:sqlite` 直查）。subagent 可见性完全依赖「能读到对方进程的 SQLite 文件」。
- 现在加功能要碰：`sessionCapture.ts` / `subagentLiveCapture.ts` / `distillSessionCapture.ts` 全部、`opencodeSessionWalk.ts` 的 SQL，以及 runner 里 live poller 编排。
- 目标形态：把「捕获源」抽象成 `CaptureSource` 接口（sqlite-walk 是其一实现），transcode→insert→dedup 在源之上；新源（HTTP/远程）只实现 source。

**[OCI-CP4] inventory 插件「JS twin + TS twin」双写，加任何清单字段都要改两处并靠 grep 测试兜**
- 触发场景：清单要多采一个字段（如 agent 的 temperature、skill 的 version）。
- 根因：`transcoder.ts`（TS，给单测）与 `aw-inventory-dump.mjs`（手写 JS，给 opencode 子进程，零 import）是同一逻辑的两份拷贝，靠 `inventory-dump-twin-parity.test.ts` grep 锁对齐（`transcoder.ts:5`/`aw-inventory-dump.mjs:13`）。
- 现在加功能要碰：两个文件 + parity 测试，且 JS 版不能用任何非 builtin import（约束传染）。
- 目标形态：把纯转换逻辑写成一个**无依赖单文件**，build 时同时产出 .mjs（或让插件 `import()` 框架的编译产物）；消灭手写 twin。注意这受「插件必须零 import」的 opencode 约束限制，是真实张力，需 RFC 评估。

**[OCI-CP5] envelope/协议块绑死「stdout text 事件里夹 XML」，换结构化输出通道要动 runner 全身**
- 触发场景：opencode 将来支持结构化输出（tool-result / 专门的 output 事件），不再需要把 `<workflow-output>` 塞进自由文本。
- 根因：协议「最后一段 `<workflow-output>` text 取胜」从 stdout text 累加（`runner.ts:835/871-884/1073`）一路绑到 envelope 解析、clarify 分支、port 校验、followup 重试（RFC-042/049/100）——是 runner 内一条 ~150 行的命运链。
- 现在加功能要碰：runner 第 6/9 段全部、`services/envelope.ts`、protocol 渲染、followup 决策。
- 目标形态：把「从事件流提取 agent 最终输出」与「解析输出语义」分成两层，前者由 OCI-CP1 的协议层提供「最终文本/结构化结果」，后者只吃归一化结果。

## 5. 耦合 / 分层违规

**[OCI-11] runner 是「上帝函数」：spawn/env/inject/render/解析/捕获/lifecycle/广播全挤在一个 1836 行文件** — 级别 P2｜类型 coupling ｜
证据：`runNode` 单函数从 `runner.ts:376` 到 1335 共 ~960 行，内联了技能注入、inventory 物化、memory inject、prompt 渲染、spawn、cancel/timeout/kill、双 pump、live poller 编排、envelope 解析、port 校验、子会话捕获、inventory 回读、最终状态写 + 广播 ｜
影响：任何与 opencode 协议无关的改动（如新增一种 envelope kind）也要在这条巨链里穿针；测试只能靠 mock-opencode 黑盒驱动整条链，难以单测「只是协议解析」这一面 ｜
建议：抽出 §4/§6/§9 三段为独立可单测函数（spawn-and-pump / parse-final-output / capture-children），runNode 退化为编排。

**[OCI-12] 捕获器复用了 walk 核心，但 transcode/insert/dedup/marker 仍各写一份且 distiller 注释自认「90% copy」** — 级别 P3｜类型 coupling ｜
证据：RFC-077 已把 BFS 收口到 `opencodeSessionWalk.ts`（好）；但 `distillSessionCapture.ts:5-9` 显式注释「故意保留为 captureChildSessions 的近 90% 拷贝」，三处的 transcode→map row→insert→markCaptureFailed 仍是平行结构（`sessionCapture.ts:234-249` vs `distillSessionCapture.ts:87-100`）｜
影响：marker kind、dedup 语义、insert 形状各自演化，未来加「捕获失败重试」「按 part 增量」要改三处。**部分被 dedup-audit-2026-06-13 覆盖**（其结论正是此类）｜
建议：在 walk 之上再抽一层 `captureSessionsInto({ table, rowShape, dedup, markerKind })`，三个 owner 只配置差异点。

## 6. 测试 / 可观测性缺口

**[OCI-13] 无 PR-级真 opencode 关口，且 token 断言自洽到漏掉真 bug** — 级别 P1｜类型 test-gap ｜
证据：真 opencode 集成只在 nightly + 路径过滤 PR 跑（`.github/workflows/integration-opencode.yml`，path filter 仅 runner/envelope/protocol/plugin）；recording parser-guard 的 token 断言自洽（OCI-06，`tests/opencode-recording-parser.test.ts:175-183`）｜
影响：cache token bug（OCI-06）有真 fixture 在仓里却没被任何测试抓到；版本漂移（OCI-07/08）只在「碰巧改了被 path filter 命中的文件」的 PR 才有机会暴露。STATE.md 自述 RFC-101 等 v1 功能「真实 opencode 端到端未跑」｜
建议：parser-guard 加「framework total === fixture 内 opencode 自报 tokens.total」与「cacheRead 必须 > 0（该 fixture 7040）」两条硬断言；考虑把最小 recording-replay 纳入每 PR gate（不花钱，纯回放）。

**[OCI-14] token 解析「全 miss」无任何信号** — 级别 P2｜类型 observability ｜
证据：`accumulateTokens` 探测失败直接 `return`，无日志（`runner.ts:1786`）；step_finish 事件存在但 token 全 0 不会 warn ｜
影响：OCI-06 这类「字段名漂移」在生产端完全静默，运维看到 token=0/偏小也无从判断是「真没用 token」还是「解析 miss」｜
建议：当 inferEventKind==='step_finish' 但 pickTokens 返回 null（或 total 解析为 0）时发 debug/warn 计数；version probe 时把一次真 step_finish 的 token 命中率打到启动日志。

**[OCI-15] distiller stdout 解析无 recording 关口** — 级别 P3｜类型 test-gap ｜
证据：distiller 自有 stdout 解析（`memoryDistiller.ts:746/793/1122`）不复用 runner 解析器，也不在 recording parser-guard 覆盖范围内 ｜
影响：opencode 协议漂移对蒸馏的影响完全无测试网（蒸馏静默失败只表现为记忆不更新）｜
建议：OCI-01 收口后蒸馏自动进 parser-guard；在此之前至少加一条蒸馏 stdout fixture 回放。

## 7. 目标形态（Target architecture）

这个子系统理想是「框架 ↔ opencode 之间只有一道收窄的适配层」：

1. **`util/opencodeProtocol.ts`（协议契约层）**：集中 {事件 type 枚举、`extractFinalText`、`extractTokens`（认 `cache.read/write`+`reasoning`）、`extractSessionId`、`resolveDbPath`（认 channel + `OPENCODE_DB`）、`resolveBinary`（认 settings opencodePath）}。所有常量带「适用版本」注释，必要时按 `probeOpencode().version` 分派。版本升级 = 改这一文件 + 加 fixture。
2. **`services/opencodeProcess.ts`（启动原语）**：`spawnOpencode({cmd,cwd,env,signal,timeoutMs,onLine})`，内含 setsid 组杀 + reap deadline + 背压 pump（runner 现有 RFC-098 逻辑下沉）。runner / distiller / fusion / 未来调用者共享，行为不再分叉。
3. **`services/sessionCaptureCore.ts`（捕获原语）**：walk（已有）之上抽 `captureInto({source, table, rowShape, dedup, markerKind})`；`CaptureSource` 接口让 sqlite-walk 只是一种实现，为将来 HTTP/远程留口。
4. **runner 瘦身**：`runNode` 退化为「准备注入 → spawnOpencode → 协议层解析最终结果 → 捕获 → 写状态」的编排，每段可独立单测。
5. **测试网**：recording-replay 进每 PR gate，断言锁真实字段（含 token.total 一致、cache_read 非零）；daemon 启动期跑一次真 opencode 最小冒烟，把 shape 假设变成显式断言。

这样「换 opencode 版本 / 加调用者 / 换捕获源 / 换输出通道」四类未来需求各自只动一层，不再散弹。

## 8. Top 风险与建议优先级

| 优先级 | ID | 标题 | 类型 | 一句话建议 |
|---|---|---|---|---|
| P1 | OCI-06 | cache/reasoning token 静默丢失，total 与 opencode 自报差 ~15×，限额失效 | impl-bug | accumulateTokens 读 `cache.read/write`+`reasoning`；parser-guard 断言 total 一致 |
| P1 | OCI-13 | token 断言自洽 + 无 PR 级真 opencode 关口，漏掉 OCI-06 | test-gap | parser-guard 加硬断言；recording-replay 进每 PR gate |
| P1 | OCI-01 | 无 OpencodeProcess 适配层，协议知识散落 4-6 文件 | design | 抽 opencodeProtocol + opencodeProcess 单一收口 |
| P2 | OCI-08 | DB 路径硬编码 opencode.db，未处理 channel/OPENCODE_DB | impl-bug | 解析读 OPENCODE_DB + channel 后缀回退 |
| P2 | OCI-05 | settings opencodePath 对蒸馏无效（双二进制来源） | impl-bug | 蒸馏 spawn 也读 config.opencodePath |
| P2 | OCI-09 | distiller spawn 无组杀/reap，孙进程可吊死 + 读序死锁 | impl-bug | 复用统一 spawn 原语 |
| P2 | OCI-07 | inventory 插件读 plugin_origins，1.17 已无此字段 | impl-bug | config hook 兼容 cfg.plugin 新形 |
| P2 | OCI-11 | runner runNode ~960 行上帝函数 | coupling | 抽 spawn-pump / parse / capture 三段 |
| P3 | OCI-10 | resolveOpencodeCmd 复制 4 份且分叉两变体 | impl-bug | 提到共享 util 单一实现 |

### 待核验（无法仅凭只读源码 100% 确认）
- OCI-06 的生产实际影响幅度（cache_read 占比）取决于 provider/缓存命中率；fixture 证明字段被丢，量级需真跑确认。
- OCI-08 中非 stable channel 用户占比未知；本机当前是 stable，路径恰好命中，掩盖了该分支。
- OCI-07 对 1.15.5（CI pin）是否也已无 plugin_origins 未逐版本核（本机 1.17.8 确认无）；建议在 twin parity 测试里加版本矩阵核验。
