# RFC-029 — opencode 运行时清单快照（in-process plugin dump）

> 状态：Draft
>
> 编号：RFC-029
>
> 依赖：
> - **RFC-022（dependsOn inline JSON 注入路径已稳定）** — 硬依赖，runner 注 dump plugin 走同一条 inline.plugin 字段
> - **RFC-027（Node Session View）— UI 部分硬依赖**：本 RFC 的运行时清单要渲染在 Session 页签顶部（attempts 切换器之下、对话流之上），需要 RFC-027 的 SessionTab 落地后挂载点才存在
>
> 与 RFC-028（Agent MCP 依赖）解耦但语义互补：RFC-028 决定"声明了什么 MCP",本 RFC 决定"运行时实际加载到了什么"。
>
> 不依赖也不冲突：RFC-026（clarify inline session）。

## 1. 背景

框架的核心抽象是"驱动多个 opencode CLI 进程作为协作 agent"——而**每个 opencode 进程实际加载到的 agent / skill / mcp / plugin 集合**目前在我们这边是黑盒：

- 我们用 `OPENCODE_CONFIG_CONTENT`（inline JSON）+ `OPENCODE_CONFIG_DIR`（私有 skill dir）+ cwd（worktree）三件套去拼装注入,但 opencode 自身又会合并 `~/.opencode/`、repo `.opencode/`、`~/.claude/`、`~/.cursor/` 等多个来源（`packages/opencode/src/config/config.ts:641`),最终生效集合**只能 opencode 自己知道**。
- 调试时常见的"我注的 agent 没被识别 / repo 里的同名 agent 覆盖了 / 某 skill 路径写错 / MCP OAuth 没起来"这一类问题,目前只能靠看 stderr 或拼 raw events 反推,信号噪声比极差。
- RFC-028 引入 MCP 之后,"runner 注的 MCP 到底连上没"会成为高频排障路径——`mcp.status` 里 `connected / needs_auth / failed` 是关键诊断信号,不抓就只能猜。

opencode 进程内部其实**早就把这些信息整理好了**:
- `client.app.agents()` (`packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts:148`) → resolved `Agent.Info[]`
- `client.app.skills()` (同上 `:158`) → resolved `Skill.Info[]`
- `client.mcp.status()` (`groups/mcp.ts:42-55`) → `Record<name, MCP.Status>` 含连接状态
- plugin 的 `config(cfg)` 钩子 (`packages/plugin/src/index.ts:224`) 收到 `Config`,含派生字段 `plugin_origins: ConfigPlugin.Origin[]` (`config/config.ts:299`)

问题只是:**外部进程拿不到 in-process server**——`opencode run` 子命令不开 TCP 端口,fetch 走 `Server.Default().app.fetch(request)` 走内存(`cli/cmd/run.ts:835-844`)。

## 2. 目标

让 runner 在每个 node_run 结束（或更早,见 §4 时机分支）后,**拿到一份该 opencode 子进程实际加载到的 agent / skill / mcp / plugin 清单**,落进 `node_runs.inventory_snapshot_json` 列,并在 NodeDetailDrawer 的 Stats 页签暴露给用户阅读。

### 2.1 必须达到

1. **一个 dump-only plugin**:框架自带一个极简的 opencode plugin(`packages/backend/src/opencode-plugin/inventory-dump.ts`,bun build 时单文件打到 binary 旁,运行时复制到 `OPENCODE_CONFIG_DIR/plugins/aw-inventory-dump.mjs`),由 inline config 的 `plugin: ["file:///abs/path"]` 字段注入到目标进程。
2. **per-run 快照**:每次 `opencode run` 启动后,该 plugin 在 boot 时(或首条 chat.message 时,见 design.md §3.2)调用 `client.app.agents() / client.app.skills() / client.mcp.status()` + 缓存 `config.plugin_origins`,把结果 JSON 写到 `$OPENCODE_AW_INVENTORY_OUT`(framework runner 提前为该进程分配的私有路径,默认 `~/.agent-workflow/runs/{task}/{node}/inventory.json`)。
3. **runner 收档**:runner 在 child.exited 之后(优先)或读到文件即可(streaming 不必需),`Bun.file().json()` 读起 inventory,落到 `node_runs.inventory_snapshot_json TEXT` 列。
4. **UI 暴露**:NodeDetailDrawer **Session 页签顶部**(RFC-027 落地的 SessionTab,attempts 切换器之下、`<ConversationFlow />` 之上)新增折叠区"Runtime Inventory",分四节(agents / skills / mcps / plugins)分别可展开。表格化:agent 列 `name / mode / model / source(repo/global/inline)`;skill 列 `name / source / path`;mcp 列 `name / status / type(local/remote) / hint`;plugin 列 `specifier / source`。位置选择理由:运行时清单本质是"这次跑装载了什么资产",和它产生的对话流是同一次执行的两面;放在对话流上面让用户翻 session 之前先看清运行环境,排障时一眼就能确认 "agent X 收到的 model 对不对 / mcp 连上了没"。
5. **失败兜底**:dump plugin 写文件失败 / opencode HTTP API 报错 / dump-plugin 加载失败 → 全部**不阻塞主流程**,runner 读不到 inventory.json 时记一行 warn + 在 `inventory_snapshot_json` 落 `{ "captured": false, "reason": "..." }`,UI 显示"清单未捕获"占位。
6. **零侵入 opencode 源码**:plugin 仅使用 `@opencode-ai/plugin` 已公开的 PluginInput / Hooks 类型与 SDK 客户端,不 patch opencode binary。

### 2.2 非目标

- 不实现 streaming inventory(运行中实时更新)。v1 只在 boot 一次性 dump;run 期间动态新增的 MCP 连接状态变化不重新写。
- 不做 cross-task inventory diff、历史对比、清单变化告警。
- 不做 agent / skill / mcp 的二次操作入口(disable / reload / re-auth)。这些已经由 opencode CLI 子命令(`opencode mcp auth` 等)覆盖;UI 只读。
- 不替代 RFC-027 的 session 事件视图;两者并存:RFC-027 显示"这次跑出来的对话",RFC-029 显示"这次跑用了什么资产"。
- 不为单元 / e2e 测试模式跑真实 opencode。mock-opencode 通过新加性 env `MOCK_OPENCODE_WRITE_INVENTORY_TO=/path/to/file.json` 来模拟 plugin 写 inventory 的副作用,真实 plugin 仅集成测试与本机手动验证;详见 design.md §6。
- 不支持 `OPENCODE_PURE`(`--pure`)模式下捕获 plugin 列表。pure 模式下 opencode 跳过所有外部 plugin,我们的 dump plugin 也不会被加载,inventory 文件不会产生;runner 把 `captured: false, reason: 'opencode-pure-mode'` 落库。

## 3. 用户故事

- **作为框架使用者**,我刚改了 agent.md 里的 `mcp: [memcache]` 引用,跑完发现 agent 没用上对应工具——打开 Stats → Runtime Inventory → MCP,看到 `memcache: needs_auth, hint: token not stored`,立刻知道要先在主机上跑 `opencode mcp auth memcache` 而不是怀疑 inline JSON 注入错了。
- **作为 RFC-028 owner**,我担心 inline `mcp.<name>` 注入和 repo `.opencode/config.json` 中已有 MCP 同名冲突——跑一次 task,看 Stats → Inventory 里的 MCP source 字段(repo / inline / global)即可现场验证 deep-merge 行为符合预期。
- **作为审阅者**,有人报告"为什么这次 agent 用错了 model",我打开 Stats → Inventory → Agent,看到该 agent 的 `model: anthropic/claude-haiku-4-5` 而不是 `claude-opus-4-7`,马上能定位到 frontmatter 里 `model:` 字段被 inline 覆盖。
- **作为 skill 作者**,我把 skill 移到 `~/.agent-workflow/skills/foo/files/` 后跑 task,看 Inventory → Skill,确认 `foo` 出现且 `source: managed`、`path` 指向 runDir 下的 copy,不是 repo `.opencode/skills/foo` 那份。

## 4. 验收标准

### 4.1 UI 行为

| 编号 | 验收项 |
|------|--------|
| AC-1 | NodeDetailDrawer **Session 页签顶部**(attempts 切换器之下、`<ConversationFlow />` 之上)出现 `Runtime Inventory` 折叠区(默认折叠),展开后分四个子区段:Agents / Skills / MCPs / Plugins。位置必须在 attempts switcher 之下,以便切 attempt 时 inventory 与对话流同步重渲染。 |
| AC-2 | Agents 子区段表格:列 `name / mode / model / readonly / source`,行按 name 升序。`source` 取自 `Agent.Info.source.type`(opencode 自身字段),映射为 `inline / global / project` 中英 i18n。 |
| AC-3 | Skills 子区段表格:列 `name / source / path / description (truncated)`,source 同样映射中英。 |
| AC-4 | MCPs 子区段表格:列 `name / status / type / hint`,status 包括 `connected / needs_auth / needs_client_registration / disabled / failed / not_initialized`,各自带视觉色(绿 / 琥珀 / 红 / 灰)+ i18n 文案。 |
| AC-5 | Plugins 子区段表格:列 `specifier / source`(source 取 `ConfigPlugin.Origin.source`,映射 `inline / global / project / internal`)。 |
| AC-6 | 当 `inventory_snapshot_json.captured === false` 时,Runtime Inventory 区段只显示一行占位 `"Runtime inventory was not captured: <reason>"`,reason 用 i18n key 翻译。 |
| AC-7 | Runtime Inventory **只出现在 Session 页签**;不出现在 Events / Output / Stats 页签。Session 页签的 attempts 切换器、对话流、subagent 嵌套折叠(RFC-027 行为)与本区段视觉上互不遮挡:Inventory 折叠时只占一行,展开时占用对话流上方有限纵向空间。 |
| AC-8 | 非 agent kind 的 node_run(input / output / wrapper / review / clarify)Session 页签**不渲染** Runtime Inventory 区段(对它们而言无意义,且 RFC-027 已规定这些 kind 的 Session 页签走 `sessionNotApplicable` 占位)。 |
| AC-9 | 切换 attempt(RFC-011 / RFC-027 共用的 attempts switcher)时,Runtime Inventory 区段按所选 attempt 的 nodeRunId 重新拉数据;折叠 / 展开状态在 attempt 切换间**保持**(用 useState 而非 useEffect 重置)。 |

### 4.2 数据 / 后端

| 编号 | 验收项 |
|------|--------|
| AC-D1 | `node_runs` 表新增列 `inventory_snapshot_json TEXT`(nullable,默认 NULL),老行兼容 NULL。 |
| AC-D2 | runner 在每个 agent kind 子进程启动前,把 inventory dump plugin 文件复制(或硬链)到 `OPENCODE_CONFIG_DIR/plugins/aw-inventory-dump.mjs`,并在 inline JSON 的 `plugin` 字段追加 `"file:///<abs>/aw-inventory-dump.mjs"`。同时为该子进程设置 env `OPENCODE_AW_INVENTORY_OUT=/<runDir>/inventory.json`。 |
| AC-D3 | child.exited 之后 runner 尝试 `Bun.file('<runDir>/inventory.json').json()`;成功 → 存到 `node_runs.inventory_snapshot_json`;失败 → 落 `{"captured":false,"reason":"<short-code>"}`。原因码至少 6 个:`file-missing` / `parse-failed` / `opencode-pure-mode` / `plugin-load-failed` / `dump-plugin-internal-error` / `non-agent-kind`(后者直接 skip,不存 NULL 让 UI 区分"没必要 capture" vs "失败")。 |
| AC-D4 | 新增 GET `/api/tasks/:taskId/node-runs/:nodeRunId/inventory`,返回 `InventorySnapshot`(zod 严格校验);前端 Stats 页签的 inventory 区段消费此端点而非把 raw JSON 塞进 node_runs 列表 response(避免 task 详情 payload 膨胀)。 |
| AC-D5 | WS `/ws/tasks/:taskId` 复用现有 `node.run.updated` 事件让 inventory 端点缓存失效;无新增频道。 |
| AC-D6 | dump plugin 必须以单文件 `.mjs` 形式打包,**绝不依赖 node_modules**(framework runner 不保证 cwd 有 node_modules,且 opencode 子进程是独立的 Bun 进程)。`@opencode-ai/plugin` 提供的类型只用作 dev-time 类型注解,运行时 plugin 内部完全用裸 SDK 客户端 + 标准 fs/process API。 |

### 4.3 测试覆盖

详见 `design.md §6`。最小集合:

- shared 纯函数 `normalizeInventory(raw)` 与 `inventoryReasonCode(err)`:14+ case,覆盖 captured/uncaptured 双路径 + 所有 6 个原因码 + 异常输入。
- backend `services/inventory.ts` 单测:write / read / parse failure 兜底 / non-agent kind skip / plugin 文件不存在时 inline JSON 不被污染。
- backend runner 集成:启动一个 mock-opencode 子进程,该 stub 模拟 plugin 写 inventory.json,然后 runner 读起入库;另一个 case 模拟 stub 不写文件 → 落 `file-missing`。
- backend route 测试:GET inventory 端点 4 态(200 / 404 / 410 non-agent / 200 uncaptured)。
- frontend Stats Inventory section 测试:四类资产表渲染 + 折叠展开 + 占位 + 非 agent kind 不渲染 + i18n 中英 + status 色彩 class。
- 源代码层 grep 锁:
  - runner 必 import `inventoryPlugin.path()` 入口,grep 锁文件名,refactor 拿掉立刻爆。
  - dump plugin 必含 `client.app.agents()` / `client.mcp.status()` 调用字面量;source-level test grep 锁。
- e2e:一个真实的 `opencode run`(本地集成 e2e,non-CI;CI 用 mock-opencode 模拟 plugin 行为),验证 happy path。

### 4.4 不应出现的回归

- node_runs 现有列(stdout / stderr / status / *Snapshot / opencode_session_id 等)行为不变。
- Stats 页签 token / 耗时 / dependsOn 树位置与样式**不动**(本 RFC 不在 Stats 加东西)。
- Session 页签 attempts 切换器位置与行为不变(RFC-011 / RFC-027 既有);Inventory 区段默认折叠,折叠态只占一行,不抢视觉焦点。
- inline JSON 注入语义不变:dump plugin 走 `plugin: [...]` 字段,与 agent / skill / mcp 字段相互独立。RFC-022 / RFC-028 注入 agent / mcp 闭包逻辑不动。
- RFC-027 session view / RFC-026 clarify inline session 行为不变;dump plugin 不订阅事件总线,不参与 session 流程。
- `--pure` / `OPENCODE_PURE` 模式下 opencode 行为不变(我们的 plugin 不被加载,但 opencode 自身不因此报错)。

## 5. 与 Session 页签其它内容的边界

Runtime Inventory 区段**共用** Session 页签,**位于其顶部**(attempts switcher 之下、ConversationFlow 之上)。三块内容的职责切分:

| 维度 | attempts 切换器(RFC-011 + RFC-027 共有顶部) | Runtime Inventory(本 RFC,Session 顶部第二块) | ConversationFlow(RFC-027,Session 主体) |
|------|----------------------------------------------|---------------------------------------------|------------------------------------------|
| 回答的问题 | "看哪一次执行" | "这次跑装载了什么资产" | "这次跑对话流如何" |
| 数据来源 | `node_runs` 表按 retry_index 分组 | dump plugin 在 boot 时调 in-process SDK | runner stdout NDJSON + 后置读 opencode SQLite |
| 视觉占比 | 一行 chip | 折叠态 1 行 / 展开态 ~150 px(4 张表合计) | 余下全部纵向空间(可滚动) |
| 切 attempt 触发的行为 | 切换 nodeRunId | 重拉 inventory(同一 attempt 内 inventory 不变,但跨 attempt 不同 retry 可能装载不同资产) | 重渲染整棵会话树 |

与 **Events 页签** 的边界:Events 页签是 raw debug 视图,展示扁平 NDJSON 事件列表;**不**重复渲染 Inventory 也**不**渲染 ConversationFlow。本 RFC 不动 Events 页签。

三者解耦、互不替代。

## 6. 风险与回退

- **opencode plugin API 变动**:`@opencode-ai/plugin` 仍在迭代,`PluginInput.client` 的 SDK 方法名可能变(opencode 已有过 1.x → 1.15 间 SDK 重构史)。本 RFC 把"调哪些方法"集中在一个 ~50 行的 dump plugin 文件,版本不匹配时 dump 失败 → 兜底走 captured:false,主流程零影响;runner 端可见 warn 日志含 plugin 写出的失败原因。
- **plugin 文件路径 vs Bun binary 打包**:framework 是 `bun build` 单二进制(参考 design/design.md "Tech stack" 段),dump plugin 必须作为单二进制内嵌资源(Bun `import meta` + `embed` 或编译时 inline 成字符串常量),启动期 `Bun.write` 到 runDir。打包路径见 design.md §3.1。
- **plugin 启动失败被 opencode 静默 skip**:`packages/opencode/src/plugin/index.ts:170-209` 显示 plugin 加载失败仅 log.error + publishPluginError,不导致进程退出。框架的兜底是看 inventory.json 是否被写:没写就 captured:false,从而把 plugin 加载失败本身也降级成可观测的 "reason"。
- **完全回退**:删 inline plugin 注入这一行 + 删 db column 即可;UI Runtime Inventory 区段在 `inventory_snapshot_json` 列不存在或全 NULL 时本来就不渲染。零持久副作用。
