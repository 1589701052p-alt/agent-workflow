# RFC-111 — 任务分解与 PR 拆分

配套 `proposal.md` / `design.md`。强序 4 PR（A→B→C→D），每 PR 独立测试绿、独立可上。

---

## PR-A — 运行时抽象抽取（行为不变）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T1** | 新建 `services/runtime/types.ts`：`RuntimeKind` / `RuntimeDriver` / `NormalizedEvent` / `NormalizedTokenDelta` / `SpawnPlan` / `BuildSpawnContext` / `RuntimeProbe` / `RuntimeModel`。 | — |
| **T2** | `services/runtime/index.ts` 工厂 `getRuntimeDriver(kind)`；`resolveRuntime(agentRuntime, defaultRuntime)` 纯函数（三层回退 + 未知值兜底 opencode）。**runtime 冻结**（D15/Codex P1-2）：`mintNodeRun` 铸行时写 `node_runs.runtime=resolveRuntime(...)`；resume/clarify-rerun 读冻结值（不重解析）、非法值 fail-closed。 | T1 |
| **T3** | 抽取 opencode：`runtime/opencode/{driver,events,probe,models}.ts`。`buildSpawn` = 现 `buildCommand`+env 组装+`buildInlineConfig`+`prepareSkills`（逐字搬运）；`events.ts` parseEvent 归一化（含 RFC-103 嵌套 cache）；probe/models = 现 `util/opencode*.ts` 薄封装（保留旧导出兼容）。 | T1 |
| **T4** | `runner.ts` `runNode` 委派化：解析 driver → `buildSpawn` → 泛化 spawn（含 stdin 模式）→ 泵走 `driver.parseEvent` → 收尾/exit/kill/reap/信封/落库 **不变** → `driver.captureSession?`。`accumulateTokens` 改消费 `NormalizedTokenDelta`。泛化 `opts.opencodeCmd`→`opts.runtimeCmd`（测试注入）。 | T2,T3 |
| **T5** | 测试：全量后端回归绿；`runtime-opencode-golden.test.ts`（argv/env 逐字相等硬锁）；token 归一化等价；`resolveRuntime` 单测。 | T4 |

**验收**：后端 3900+ 全绿、零退化；黄金断言锁住 opencode 启动逐字不变。**此 PR 不暴露任何 claude 能力**。

---

## PR-B — claude-code driver 核心 + 配置/探测/模型/UI/DB

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T6** | `runtime/claudeCode/events.ts`：stream-json → NormalizedEvent（`session_id`/`message.usage`/`result.usage`/kind）。**先实测 V1** 钉字段名。 | PR-A |
| **T7** | `runtime/claudeCode/driver.ts` `buildSpawn`：argv（`-p --output-format stream-json --verbose` + 权限形态[V6/V9 root preflight] + `--model` + `--append-system-prompt-file`[D6]）；prompt 走 stdin[D12，超 10MB preflight 报错 V9]；env（`PWD` + `CLAUDE_CONFIG_DIR` + git + 鉴权透传[§4.1 不二元、来源以 probe 为准]）。skills/mcp/subagents 占位（PR-C 接全）。 | T6 |
| **T8** | `runtime/claudeCode/probe.ts`：`claude --version` 解析 + `MIN_CLAUDE_CODE_VERSION`[V7]；`models.ts` 静态精选列表（别名 + 当前全 ID）。 | T1 |
| **T9** | config schema 加 `defaultRuntime`/`claudeCodePath`/`defaultClaudeModel`/`claudeCodeEnabled`(暴露 flag D17)；DB migration 加 **`agents.runtime` + `node_runs.runtime`**（冻结列 D15，单次手写 SQL + journal idx 顺延〔避让 RFC-108 0052〕+ upgrade-rolling 同步）；schema.ts 两列。 | T1 |
| **T10** | `routes/runtime.ts` 泛化：`/api/runtime/claude` probe；`/api/runtime/models?runtime=`；shared runtime 类型加 claude 形状。 | T8,T9 |
| **T11** | daemon 启动软探测 claude（仅当需要）；`runNode` spawn 前硬门（claude 不兼容→node failed，清晰报错）。 | T8 |
| **T12** | `mock-claude` harness（emit stream-json on stdout，注入原文/分片/session id）；mock-opencode 不动。 | T6 |
| **T13** | 前端（**flag 默认关、不暴露用户路径，D17/Codex P2-3**；PR-D 收尾翻开）：AgentForm 运行时 `<Select>`（切模型命名空间 + 隐 variant/temp）；Settings 加 claude `<RuntimeStatusCard>`（显 probe `apiKeySource` 真实来源）+ `defaultRuntime` + `defaultClaudeModel`；`ModelSelect` 加 `runtime` prop；i18n 中英。 | T10 |
| **T14** | 测试：claude events/buildspawn/probe 单测；mock-claude e2e（纯 claude + 混用 Code→Audit→Fix）；前端选择器/状态卡/ModelSelect；DB migration 解析 NULL→opencode。 | T6–T13 |

**验收**：mock-claude 下 claude 节点产端口、混用工作流跑通；纯 opencode 路径零影响；前端平价。

---

## PR-C — 全注入平价（skills / mcp / subagents / readonly / 续跑）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T15** | `runtime/claudeCode/config.ts` `prepareClaudeAttemptDir(task,node,retryIndex)`（D16/Codex P1-1+P2-1）：**每 attempt 持久目录**（跨 clarify 轮复用、随 worktree GC 清，**非每运行即删**，保 `--resume` 命中）；**仅白名单桥接订阅凭据**（Linux `.credentials.json` 软链 / macOS keychain 免桥）、**不**镜像 settings/agents/plugins/hooks/`~/.claude.json`；平台自带最小 `--settings` + `--strict-mcp-config`；写 managed(拷贝)/external(软链) skills 到 `skills/`；目录 0700[**实测 V2**]。 | PR-B |
| **T16** | MCP：`toClaudeMcpConfig(dbMcps)` 形状转换 + `--mcp-config '<json>'`（超限回退临时文件路径[V5]）+ 视情况 `--strict-mcp-config`。 | PR-B |
| **T17** | 子代理：`toClaudeAgents(closureMembers)` → `--agents '<json>'`（超限回退文件[V5]）。 | PR-B |
| **T18** | readonly（**best-effort、非沙箱**，D7/Codex P2-4）：agent.readonly→`--disallowed-tools`（`Write Edit MultiEdit NotebookEdit` 等，[**实测 V4** 钉全集]）；写信号量路径不变（断言）；文档注明 Bash/MCP 写不拦。 | PR-B |
| **T19** | clarify inline 续跑：claude `--resume <sessionId>`；session id 落 `opencode_session_id`（通用 D11）；**按冻结 `node_runs.runtime`（D15）选** `--session`/`--resume`；依赖 T15 每 attempt 持久目录（会话文件不被删，Codex P1-1）。 | PR-B,T15 |
| **T20** | 测试：skills 注入 + worktree 干净断言 + repo skill 自发现；mcp 转换 + argv；subagents JSON；readonly argv + 写信号量；续跑 argv 契约。 | T15–T19 |

**验收**：四注入面各有针对性测试；worktree git status 干净；续跑契约锁定。

---

## PR-D — 会话 transcript 捕获（JSONL）

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T21** | `runtime/claudeCode/sessionCapture.ts`（官方布局，Codex P1-3）：定位主 `<configDir>/projects/<slug>/<id>.jsonl` + 子代理 `<configDir>/projects/<slug>/<id>/subagents/*.jsonl`[**实测 V3**，双候选目录兜底]；逐行转码 → `node_run_events`（kind 归一化/payload 原行/parentSessionId 由文件归属）；喂 `parseSessionTree`。**真实 claude fixture** 核验（非 mock-only）。 | PR-B |
| **T22** | 接 `driver.captureSession`：runner 后置调度按 runtime 分派（opencode=SQLite walk 既有、claude=JSONL）；失败写 `subagent_capture_failed` 不抛。 | T21 |
| **T23** | 测试：JSONL fixture（主+子代理）→ node_run_events → parseSessionTree → SessionTab 树；捕获失败降级标记 + 编排继续。 | T21,T22 |

**验收**：claude 节点 SessionTab 子代理树与 opencode 平价；失败优雅降级。

---

## 全局验收清单

- [ ] PR-A 后端全量回归零退化 + 黄金断言（opencode 逐字不变，含 spawn 选项）+ **黑盒行为回归**（kill/ spawn 身份 / capture / resume / 落库，Codex P2-2）。
- [ ] `resolveRuntime` 三层回退纯函数测试；**`node_runs.runtime` 冻结**（跑后改 agent runtime 再 resume 不错配；未知值 fail-closed，D15）。
- [ ] mock-claude e2e：纯 claude / 混用 Code→Audit→Fix。
- [ ] 全注入平价（skills/mcp/subagents/readonly **best-effort**）各测 + worktree 干净。
- [ ] clarify inline `--resume` 续跑契约 + **每 attempt 持久配置目录使会话文件可命中**（Codex P1-1）+ 真实续跑 e2e。
- [ ] JSONL transcript 捕获（主 + `subagents/` **真实布局** + 真 fixture）→ SessionTab 平价 + 失败降级。
- [ ] 鉴权来源**真实呈现**（probe `apiKeySource`，非推断，Codex P1-4）+ 凭据**白名单**桥接（macOS keychain 免桥 / Linux `.credentials.json`，不镜像 settings/agents/plugins/hooks，Codex P2-1）。
- [ ] 健康度门：缺 claude 不影响 opencode 工作流；claude agent 节点 spawn 前清晰失败；**root/sandbox + stdin 10MB preflight（V9）**。
- [ ] 前端 Agent 运行时选择器 + 双状态卡 + ModelSelect runtime 感知 + i18n 对称（公共组件优先）；**用户可见 claude 选择器 flag 门控到 PR-D 收尾才翻开（D17）**。
- [ ] 门禁全绿：typecheck×3 + 后端 bun test + 前端 vitest + format + binary smoke。
- [ ] Codex 设计 gate（§10 已 fold 8 findings）+ 实现 gate（每 PR）fold。
- [ ] design §6 V1–V9 实测结论回填；STATE.md 完工行 + plan.md 索引状态→Done。

## 待验证项汇总（实现期对照实装 claude，结论回填 design §6）

**✅ 已实测闭合（design §6.1，2026-06-26）**：V1 stream-json 字段名(snake_case) · V2 凭据桥接（写 `.credentials.json`，macOS keychain 取/Linux 复用，单文件足）· V3 transcript 随 `CLAUDE_CONFIG_DIR` 重定位 + 子代理 `subagents/agent-*.jsonl`+`.meta.json` 布局 · V8 is_error→exit · **P1-1 持久目录 `--resume` 续跑**。
**⏳ 留实现期补测**：V4 readonly 工具名全集 · V5 内联 JSON E2BIG 回退 · V6 非交互权限形态 · V7 MIN 版本 · V9 headless 上限（stdin 10MB / `--dangerously-skip-permissions` 拒 root preflight）· V1 残留 `--verbose` 强制性 · env-token（`CLAUDE_CODE_OAUTH_TOKEN`）免落盘路径。
