# RFC-030 — MCP 接口探测与能力清单

| 字段 | 值 |
| --- | --- |
| 编号 | RFC-030 |
| 状态 | Draft |
| 作者 | binquanwang |
| 提交日期 | 2026-05-17 |
| 关联 | [RFC-028 agent MCP 依赖](../RFC-028-agent-mcp-dependencies/proposal.md), [RFC-029 opencode inventory snapshot](../RFC-029-opencode-inventory-snapshot/proposal.md) |

## 1. 背景

RFC-028 把 MCP server 提升为一等资源（DB + UI + agent picker + runner 注入），但**只**做了"配置层"——`/mcps` 列表只能看到 name / type / description / enabled，看不到这个 MCP 究竟暴露了哪些 tool、参数长什么样、当前是否真的连得通、握手要多久。RFC-028 §3 明确把 "运行时状态监控 / 健康检查" 列为非目标，留给后续 RFC。

实际使用中这缺口非常痛：

- **盲填**：新建 / 编辑 MCP 后用户不知道写的 `command` 或 `url` 到底能不能起进程、能不能握手成功。第一次发现失败要等到真正 launch task → opencode 子进程红了才反馈，链路太长。
- **不知道有什么工具**：同事新建了 `sentry-prod` MCP，要去 agent permission 列表里授权它的某个工具——但工具名只能去翻 MCP 仓库 README 或猜。RFC-028 README 里写了"工具名是 `{mcp}_{tool}`"，但 `{tool}` 是什么得自己去问 server。
- **schema 看不到**：tool 的 `inputSchema` 是 LLM 真正用来构造调用参数的契约。没有 UI 暴露，用户写 agent system prompt 时只能凭经验。
- **故障定位慢**：Remote MCP（url）挂了 / 凭据过期 / OAuth 不通 → 当前没有任何主动反馈，要等到 task 红。

opencode 自己有 `opencode mcp` CLI（`packages/opencode/src/cli/cmd/mcp.ts`）能 list / call，但那是 opencode 进程内自查；我们框架想要的是**配置态、跨进程、不依赖 opencode 已运行**的探测。

## 2. 目标

- 在 `/mcps` 列表与 `/mcps/$name` 详情页直接看到每个 MCP 的：**探测状态**、**探测延时**、**serverInfo 与协议版本**、**capabilities flags**、**tools 全清单（含 description + inputSchema）**、**resources（含 resourceTemplates）清单**、**prompts 清单**。
- 探测**完全按需触发**（"重新探测"按钮）；结果落 DB 持久化，下次进入页面直接读最近一次结果，不自动起子进程。
- 失败时分类清晰：transport 起不来 / 握手超时 / 鉴权失败 / 部分 list 失败 都用独立 error code，UI 可展开看到 stderr / HTTP 状态 / 原始 message。
- 探测路径**纯只读 / 无副作用**：不写 task worktree、不污染 opencode 任何状态、不与正在跑的 task 抢资源；探测连接握完手 + 拉完清单立刻断开。
- 与 RFC-029 inventory-snapshot **明确分工**：RFC-029 是"task 运行时 opencode 子进程内自报清单"，RFC-030 是"配置态 daemon 主动 probe MCP 单体"。两者数据形态有交集（tools 列表）但来源、触发方式、UI 位置完全不同。

## 3. 非目标

- **不**做周期性后台探测 / 定时刷新（本期"按需触发 + 结果持久化"已覆盖 90% 痛点；周期任务后续 RFC 再加）。
- **不**做探测历史时间线（每个 MCP 在 `mcp_probes` 表里只保留**最近一次**结果，UPSERT 覆盖）。日志想看历史去看 daemon 日志（每次 probe 留一行）。
- **不**做"调用 tool 试一下"（v1 只 list，不 call；call 涉及参数构造、副作用、权限，留作未来 MCP-Tool-Playground RFC）。
- **不**做 OAuth 浏览器跳转（与 RFC-028 一致，沿用 "headers 里塞 PAT / 主机上跑 `opencode mcp auth` 让 token 落地" 兜底）。
- **不**改 runner / scheduler 任何注入逻辑（探测路径与 task 运行路径 100% 独立，连共享 connection pool 都不做）。
- **不**做 connection pool / 长连接复用——每次探测起新连接、握手完拉完清单立刻 disconnect。开销由"按需触发"控制。
- **不**做 prompt 模板字段、resource 内容预览（v1 只展示 name / description / argument 元信息）。
- **不**改 `mcps` 表本身（只新增 `mcp_probes` 表，不破坏 RFC-028 已 Done 的字段语义）。

## 4. 用户故事

### US-1 — 新建 MCP 立即验通

> Alice 刚在 `/mcps/new` 填完 `postgres-prod`（local，`command=["uvx","postgres-mcp"]`，env 含 `PG_URL`），点 "Save & Probe"。后端先持久化 MCP，再立即起一次探测；2 秒后页面跳到 `/mcps/postgres-prod`，顶部状态 chip 是绿色 `ok`，延时 1832ms，下面列出 7 个 tool（`query` / `explain` / `schema` / ...），每个 tool 可展开看 `inputSchema`。

### US-2 — 列表一眼看健康度

> Bob 打开 `/mcps`，看到 5 个 MCP 都有 chip：4 个 `ok` + 1 个红色 `error: connect-failed`。点击 `error` 行的展开箭头，立刻看到 stderr 摘要 "`uvx: command not found`"——知道是新机器缺 `uv`。

### US-3 — 给 agent 配 permission 时查工具名

> Carol 在编辑 `code-audit` agent，要把 `sentry-prod_search_issues` 加到 permission allow。她在另一 tab 打开 `/mcps/sentry-prod`，Tools 折叠区直接列出 `search_issues` / `get_issue` / `create_issue`——回原 tab 把工具名复制粘贴进去。无需翻 sentry-mcp 仓库 README。

### US-4 — Remote MCP 鉴权失败

> Dave 的 `confluence-mcp`（remote）token 过期，点 "重新探测"，2 秒后 chip 变红 `error: auth-required`，展开看到 "HTTP 401 from `https://mcp.corp.internal/sse`"。他更新 headers 里的 Bearer，再点一次，绿。

### US-5 — 部分 list 失败也不挡核心信息

> 某 server 实现了 tools 但 `resources/list` 返回 `MethodNotFound`。探测后 chip 是 `ok`（核心 initialize + tools 都成）；展开看到 tools 7 个、resources/prompts 区有小灰字 "server 未实现 resources/list"。不算 error。

### US-6 — 探测 disabled 的 MCP 给出明确拒绝

> Erin 把 `legacy-mcp` 设了 `enabled=false`（保留配置不想删），点 "重新探测" → 接口直接返回 `mcp-disabled` 错误，UI 提示 "先在 Settings 把 MCP 启用才能探测"，不会真的去 spawn。

## 5. 验收标准

1. **新表 `mcp_probes`**：UNIQUE(mcpId)；持久化最近一次 probe 的全部字段（status / 延时 / serverInfo / capabilities / tools / resources / resourceTemplates / prompts / error）。新增 migration（编号续 RFC-029 之后）。
2. **新接口**：
   - `GET  /api/mcps/probes` —— 批量列出每个 mcp 最近一次 probe（用于列表页）。
   - `GET  /api/mcps/:name/probe` —— 单个 mcp 最近一次 probe（404 = 从未探测过）。
   - `POST /api/mcps/:name/probe` —— 触发新探测，**同步**返回结果并入库。超时上限沿用 mcp.config.timeoutMs，缺省 30s；硬上限 60s。
3. **disabled 守卫**：`enabled=false` 的 mcp 调 `POST /api/mcps/:name/probe` 返回 422 `mcp-disabled`，不 spawn 任何进程。
4. **错误码分类**（POST 路径，最终持久化到 `mcp_probes.error_code`）：
   - `connect-failed` —— stdio spawn 失败 / HTTP 拒绝连接 / DNS 失败
   - `handshake-failed` —— transport 起来了但 `initialize` 超时或返回 error
   - `auth-required` —— SDK 抛 `UnauthorizedError` 或 HTTP 401/403
   - `timeout` —— 整体超过 timeoutMs
   - `partial` —— initialize ok 但某个 list 子调用失败（仍记为 status=ok，error_code=partial，error_detail 含失败的 method）
   - `internal-error` —— 兜底
5. **并发守卫**：同一 mcp 同时只允许一个 POST probe 在跑；第二个请求拿到第一个的 in-flight Promise 复用结果（in-process Map<mcpName, Promise>）。
6. **探测纯净**：探测进程 cwd = daemon 进程 cwd（不接任何 task worktree）；env 严格按 mcp.config.env 注入（不继承 daemon 全量 env，避免 token 污染）；不向任何用户 worktree / repo 写文件。
7. **凭据 redaction**：`error_detail_json` 里若包含 stderr / HTTP body，必须过 `redactSensitiveString`（RFC-024 已有）后再入库；接口响应同样 redact。**env / headers 本身在 GET 探测接口里不回传**（只在 /api/mcps/:name 路径下回传，且只对认证用户）。
8. **前端 `/mcps` 列表**：
   - 新增 "状态" / "延时" / "工具数" 三列。
   - 每行可展开（箭头 ▶）：展开区显示 tools 名字列表（chips）+ "重新探测" 按钮 + "查看完整接口" → 跳详情页。
   - 状态 chip 四态：`unknown`（灰，无 probe 行）/ `probing`（蓝，POST in-flight）/ `ok`（绿）/ `error`（红）。
9. **前端 `/mcps/$name` 详情**：表单下方加 "Interface Inventory" 区，顶部 chip + 最近探测时间 + 延时 + "重新探测" 按钮；下方三个折叠段 Tools / Resources / Prompts。每个 tool 可二级展开看 `inputSchema`（JSON 渲染，单色高亮）+ description。
10. **i18n**：zh-CN / en-US 同步落 key；新文案不留硬编码。
11. **测试**（详见 design §7）：
    - 单测：schema、error code 映射、redact、in-flight 复用、partial 处理。
    - 集成测：mock MCP server（stdio + http）跑完整 probe → 入库 → GET 拿到。
    - e2e：UI 列表 chip → 展开 → 详情页看 tools schema 的完整路径。
12. **CI 三件套**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions（含 build + Playwright）全绿。

## 6. 风险与回退

- **新增 SDK 依赖**：`@modelcontextprotocol/sdk` 进 packages/backend。opencode 已用同款依赖且稳定；版本对齐 opencode 当前 lock 即可。回退：依赖锁版本，若上游破坏改动，固定到已验证的 minor。
- **探测可能 hang**：尤其 local stdio 起的 server 自己卡在 stdin。用硬超时（每次 probe 全程 60s 上限 + transport 内部 30s 握手超时）；超时立刻 SIGTERM stdio child + close transport，垃圾子进程不漏。
- **本地探测起子进程影响 daemon 性能**：按需触发已经约束了频率；并发守卫保证同一 mcp 不重复起。每次 probe 子进程在 listTools 完后立刻 disconnect，秒级生命周期。
- **凭据日志泄漏**：env / headers 不入 probe 表；stderr / HTTP body 入库前 redact。daemon 日志层面沿用 RFC-024 已有 redact。
- **OAuth 探测**：remote mcp 若用 `oauth` 字段，第一次 probe 必然 `auth-required`（daemon 进程没浏览器）。文案提示用户去 `~/.opencode/auth` 让 opencode 主机端先 login，再来 probe。这是 known limitation，不阻断本 RFC 落地。
- **回退路径**：本 RFC 落地后若发现 probe 把 daemon 卡死，可在 Settings 加 `mcp.probe.enabled = false` 关掉（本 v1 不实现，但 design 预留挂载点）。极端情况 drop 整张 `mcp_probes` 表即可回退到 RFC-028 状态，不影响任何 task 运行。

## 7. 备选方案（已否决）

- **A. 后台周期性探测**：daemon 起来后每 N 分钟轮询所有 enabled mcp。否决：v1 没有强需求，且每个 stdio probe 都要起子进程，频率失控易扰民。"按需 + 持久化" 已经能让用户随时看到上一次的结果。
- **B. 让 opencode 子进程做 probe**：跑一次 `opencode mcp list --config <inline>` 之类。否决：opencode CLI 没有这种 dump-only 子命令；硬绕的话要起一个 dummy session、跑 hello 任务、再退出，巨慢且与正常 task 互相干扰。RFC-029 走 opencode plugin 是因为要看 opencode 视角的合并结果；本 RFC 要看的是"MCP 本体"，直接走 SDK 更准更快。
- **C. 复用 RFC-029 inventory 数据**：RFC-029 已经在 task 跑完后 dump 了 `client.mcp.status()`，理论上能拿到部分 MCP 信息。否决：(1) 必须先有一次 task run 才能有数据，不能在新建 MCP 时立刻验通；(2) RFC-029 dump 的是 opencode 视角（每个进程独立、合并配置后），不区分 MCP 单体；(3) tools schema 颗粒度不一定都拿；(4) 用户故事 US-1 / US-2 / US-4 全都覆盖不到。两者并存、互补。
- **D. 让前端直接探测**：浏览器调 MCP server。否决：浏览器不能 spawn stdio；CORS / 同源问题；凭据落前端不安全。
- **E. 只 list tools，不要 resources / prompts**：减实现量。否决：成本只多一次 SDK 调用，但用户故事 US-3 风格的"查阅"诉求对三类信息都有价值；统一一次性拉完节省后续往返。
