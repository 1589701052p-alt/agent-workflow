# RFC-112 — 任务分解与 PR 拆分

配套 `proposal.md` / `design.md`。强序 4 PR（A→B→C→D），每 PR 独立测试绿、独立可上。

---

## PR-A — 注册表数据层（表 + 种子 + CRUD + 守卫 + 解析推广，无 UI / 无冒烟）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T1** | migration `00NN_rfc112_runtimes.sql`（手写 + statement-breakpoint，**注释勿含该字面量**；CREATE TABLE `runtimes` + name 唯一索引 + **`node_runs.runtime_binary` 列**〔Codex P1 冻结快照〕）+ schema.ts `runtimes` 表 + node_runs.runtime_binary + journal idx 顺延（避让在途）+ upgrade-rolling 同步。 | — |
| **T2** | 启动 seed `seedBuiltinRuntimes(db)`（**Codex P2：hard-reset 非 adopt**——按 name upsert 强制 `{protocol, binary_path=NULL, builtin=1}` 规范形态，同名非内置行硬覆盖）：opencode / claude-code 两种子；接进 `cli/start.ts` seed。 | T1 |
| **T3** | `services/runtimeRegistry.ts`：CRUD + 守卫（内置只读 `assertNotBuiltinRuntime`→403、改 protocol 禁止、in-use 删除阻断〔只扫 agents.runtime + config.defaultRuntime，node_runs 快照免疫〕、name 唯一 + **name 规范 `^[a-z0-9][a-z0-9-]{0,30}$` 小写/保留内置名**〔Codex P3〕、binary_path 校验单可执行路径〔Codex P3〕）。本 PR 不接冒烟。 | T1 |
| **T4** | 解析推广：`resolveRuntimeByName`（名→{name,protocol,binaryPath}，未知 fail-safe opencode+warn）+ `resolveAgentRuntime` + `runtimeHead`（binaryPath ?? 协议默认）。**API 边界推广**（Codex P2 §4.1）：config `defaultRuntime` 放宽 `z.enum`→`z.string()`；agent 创建/更新校验 `runtime` 从枚举改为「∈ 已注册名 / 空」（引用存在校验）。 | T1,T3 |
| **T5** | 测试：CRUD + 内置守卫（删/改名/改协议 403）+ in-use 阻断 + name 唯一 + 种子幂等；resolveRuntimeByName/runtimeHead 单测；config defaultRuntime 放宽兼容。 | T1–T4 |

**验收**：注册表数据层 + 种子 + 解析推广齐活；agents.runtime / defaultRuntime 仍解析（内置名）零回归。**不暴露冒烟/UI**。

---

## PR-B — 深度冒烟探测器 + 路由

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T6** | `services/runtimeSmoke.ts` `smokeRuntime({protocol,binaryPath,config,timeoutMs})`：临时 cwd + 协议 spawn 构造器（head=[binaryPath]）+ 最小冒烟 agent + **nonce prompt**（最便宜模型）+ spawn（P1-2 try/catch）+ **生命周期收口**〔try/finally + stdin close + stdout/stderr drain + buffer 上限 + RFC-098 killTree + 临时目录/凭据 finally 清〕 + 逐行 parseEvent → **分类判定**（Codex P2）：`conforms = exit0 ∧ 协议事件序列 ∧ 捕 sessionId ∧ (sawNonce ∨ sawEnvelope)`；其余归 spawn-failed/auth-missing/model-call-failed/stream-nonconforming。**不探版本**。 | PR-A |
| **T7** | `createRuntime` 接冒烟（结果落 `last_probe_json`）；`probeOnly`（不落库）；**admin 可「仍保存为未验证」**（auth/model 类失败不阻止保存，标 unverified）（Codex P2）。 | T6 |
| **T8** | `routes/runtimes.ts`：GET 列表（全员）/ POST `/probe`（admin）/ POST（admin，冒烟+落库）/ PUT（admin，改 binary_path）/ DELETE（admin，内置/in-use 守卫）；**`/api/runtime/models?runtime=` 改名→protocol 解析**（Codex P2 §4.1）；api-contract 登记。 | T6,T7 |
| **T9** | 测试：smoke（mock head→conforms 真〔sessionId+事件+信封〕/ `/bin/echo`→假 / 不存在→spawn 失败假 / 超时→假）；路由 CRUD admin 门 + /probe + 契约。 | T6–T8 |

**验收**：给定二进制可被深度冒烟判符合并注册；admin-only 写门；mock 确定性。

---

## PR-C — runner / scheduler 接线（binaryPath head + 冻结运行时名）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T10** | `resolveFrozenRuntime` 推广（Codex P1 冻结快照）：`node_runs.runtime`=**冻结 protocol**（RFC-111 不变）+ `node_runs.runtime_binary`=**binary 快照**；resume 自洽（getRuntimeDriver(protocol) + head=runtime_binary ?? 协议默认，**不查注册表**）。runNode opts `runtime`→`runtimeProtocol` + 新 `runtimeBinary?`（生产 head 覆盖，区分 RFC-111 测试用 `runtimeCmd`）。 | PR-A |
| **T11** | runNode spawn：`getRuntimeDriver(runtimeProtocol)` + head=`runtimeBinary ?? runtimeCmd ?? 协议默认`。**内置（binaryPath=NULL）→ runtimeBinary=undefined → RFC-111 默认路径逐字不变**（黄金断言）。 | T10 |
| **T12** | scheduler 3 派发点（主 2380 / fanout 3685 / aggregator 3943）：`resolveFrozenRuntime` 返 (name,protocol,binary)，透传 runtimeProtocol + runtimeBinary。 | T10,T11 |
| **T13** | 测试：内置 opencode/claude spawn head 黄金断言（=RFC-111 逐字）；自定义 binaryPath→head=[binaryPath]；冻结运行时名 + resume 读冻结；scheduler 派发各点。 | T10–T12 |

**验收**：agent 选自定义运行时 → 用对应协议驱动 + 该二进制跑；内置零回归；冻结名跨 resume 稳定。

---

## PR-D — 前端列表 + agent 选择器（取代 RFC-111 堆叠卡）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T14** | `components/RuntimeList.tsx`：设置页运行时列表（行=名称+协议徽标+冒烟状态点+二进制+操作；内置只读、自定义增删改+测试）+ `RuntimeFormDialog`（Dialog+Form+协议 Select，保存前 `/probe` 预冒烟）。复用公共组件，零原生 chrome。 | PR-B |
| **T15** | settings.tsx RuntimeTab：两张堆叠 RuntimeStatusCard → `<RuntimeList>`；`defaultRuntime` Select 选项来自 `/api/runtimes`；保留 opencodePath/claudeCodePath 文本框（内置默认二进制）。RuntimeStatusCard 退役/收编。 | T14 |
| **T16** | AgentForm 运行时 Select：选项来自 `/api/runtimes`（替硬编码两值）；选中运行时 protocol 决定模型命名空间（claude→ModelSelect runtime=claude + 隐 variant/temp）。 | T14 |
| **T17** | i18n（runtimes 列表/表单/协议/冒烟状态/操作 中英对称）+ 前端测试（RuntimeList 内置只读/自定义/冒烟点 + 添加预冒烟 + AgentForm 列注册项 + defaultRuntime 来自列表）。 | T14–T16 |

**验收**：设置页运行时列表式（不再堆叠）；admin 增删改自定义 + 冒烟；agent 选全部注册项；i18n 对称。

---

## 全局验收清单

- [ ] PR-A：runtimes 表 + 种子 + CRUD/守卫 + 解析推广；内置名解析零回归。
- [ ] PR-B：深度冒烟（不探版本，mock 确定性）+ admin-only 路由 + 契约登记。
- [ ] PR-C：自定义 binaryPath head + 冻结运行时名；内置 spawn 黄金断言 = RFC-111 逐字。
- [ ] PR-D：设置页运行时列表 + 添加/编辑/删除/测试 + agent 选择器列注册项 + i18n 对称（公共组件优先）。
- [ ] 内置 opencode/claude 只读（删/改名/改协议 403）；删被引用运行时阻断；未知名 fail-safe opencode。
- [ ] 门禁全绿：typecheck×3 + 后端 bun test + 前端 vitest + format + binary smoke（migration 嵌入 + 无模块环）。
- [ ] Codex 设计 gate + 实现 gate（每 PR）fold。
- [ ] STATE.md 完工行 + plan.md 索引 Done。

## 与 RFC-111 / 在途的衔接

- 复用 RFC-111：`RuntimeDriver`/`getRuntimeDriver`/`buildOpencodeSpawn`/`buildClaudeSpawn`/`parseEvent`/`node_runs.runtime` 冻结/`runtimeCmd`（测试覆盖）/凭据桥接/JSONL 捕获——全不改，只让 head 可指自定义二进制。
- 多人共享树：migration 号 push 前查最新 journal 顺延；精确路径提交；不碰他人改动。
