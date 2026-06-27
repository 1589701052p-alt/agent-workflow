# RFC-116：runtime smoke 网络/端点受阻分类（`network-blocked`）

状态：In Progress

## 背景

「设置 → 运行时」对 claude-code 运行时点「测试」持续显示 **「缺少鉴权」（`auth-missing`）**，但现场诊断证明：

- 订阅凭据**有效**（max 订阅、`valid 118min`、含 `user:inference` scope、`refreshToken` 齐全）；
- 凭据桥接**成功**（抓到 daemon 本次 smoke 临时目录，`<tmp>/.claude/.credentials.json` = 472 字节，与 keychain 一致）；
- 用同一份凭据 + 隔离 `CLAUDE_CONFIG_DIR` 手动跑 claude **conform**（exit 0、回显 nonce）。

**真正根因**：daemon 进程从普通 shell（`bun dev` 链）启动，环境里**没有 `HTTP_PROXY` / `HTTPS_PROXY`**；`spawn.ts` 透传 `...process.env` 给 claude 子进程后，claude **直连 `api.anthropic.com` 被 `403 Request not allowed` 挡**（地域/网络层）。claude 把它报成 `Failed to authenticate. API Error: 403 Request not allowed`，而 `runtimeSmoke.ts` 的 `AUTH_SIGNATURES` 正则命中其中的 `authentication` 字样 → 归类为 `auth-missing`。

A/B 实证（唯一变量 = 代理）：

| | env | 结果 |
|---|---|---|
| A | 干净 env，无 PROXY（≈ daemon） | exit 1 · `API Error: 403 Request not allowed` |
| B | 干净 env + `HTTP(S)_PROXY=http://127.0.0.1:1087` | exit 0 · 回显 nonce · conform |

**误导成本**：用户被「缺少鉴权」引导去重新登录 / 配 API key，而真正该做的是修 daemon 的**网络可达性（配代理）**。`runtime-smoke.test.ts:148-154` 的注释其实早已意识到 "proxy-blocked... when the daemon simply lacked the proxy to reach the API"，但未把它从 `auth-missing` 里单独分出来。

## 目标

1. 新增 smoke outcome **`network-blocked`**：二进制能启动、能说协议（甚至捕获到 session id），但**到模型端点的网络请求被拒/不可达**——`403 Request not allowed`（地域限制）、连接被拒/超时/DNS 失败、缺代理。
2. 分类时 **network 信号优先于 auth 信号**，使 403 / 连接类失败不再误报为缺少鉴权。
3. `detail` 与前端 chip / i18n 给出**可操作指引**：检查 daemon 能否访问 `api.anthropic.com`（国内通常需设 `HTTP(S)_PROXY` 后重启 daemon）。

## 非目标

- **不**自动给 daemon 注入代理、不改 `spawn.ts` 的 env 装配（属运维职责，可后续 RFC）。
- **不**改 RFC-111 的订阅凭据桥接机制（D16，验证正常工作）。
- **不**改 opencode 运行时行为；分类正则对两种协议通用即可（opencode 错误走 stderr，已被扫描）。

## 用户故事

- 作为运维 / 平台使用者，当 claude 运行时测试失败，我能从状态 chip + detail 一眼看出是「网络/端点不可达（配代理）」而非「鉴权问题」，不再去错误地重登或配 key。

## 验收标准

1. claude smoke：stdout 含 `403 Request not allowed`（或 `fetch failed` / `ECONNREFUSED` 等连接类）→ `outcome = network-blocked`（**非** `auth-missing`）。
2. claude smoke：stdout 含**真鉴权**错误（`Invalid API key` / `Not logged in` / `please run … login`）→ 仍 `auth-missing`。
3. 既有 `conforms` / `spawn-failed` / `stream-nonconforming` / `model-call-failed` 分类不回归。
4. 前端 `RuntimeList` 与 `RuntimeFormDialog` 能渲染 `network-blocked` chip（warn / 黄，可恢复）+ zh/en i18n。
5. `detail` 含网络/代理指引文案。
6. 门禁全绿（`bun run typecheck && bun run test && bun run format:check`）+ Codex 设计/实现双 gate findings 全 fold。
