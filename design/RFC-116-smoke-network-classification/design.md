# RFC-116 技术设计：runtime smoke 网络/端点受阻分类

## 1. 现状与根因

`services/runtimeSmoke.ts` 的 deep-smoke：跑一次最小真实调用，分类是否 conform。错误分类是**启发式正则扫文本**：

- `runtimeSmoke.ts:58-59` `AUTH_SIGNATURES = /not logged in|unauthorized|authentication|invalid api key|please run .*login|no api key|anthropic_api_key|log ?in to/i`
- `runtimeSmoke.ts:60-61` `MODEL_FAIL_SIGNATURES = /rate limit|overloaded|quota|model .*not found|insufficient|too many requests|503|529/i`
- `runtimeSmoke.ts:289-318` 分类：`haystack = stderr + stdout`（小写）；顺序 `conforms → timedOut(model-call-failed) → authHit(auth-missing) → modelHit(model-call-failed) → !sawEvent(stream-nonconforming) → else(stream-nonconforming)`。
- `runtimeSmoke.ts:286-289` 注释：claude 的 auth/API 错误在 **stdout** 的 `result` 事件，opencode 在 **stderr**——两条都扫。

**误分类链**：daemon 无 `HTTP(S)_PROXY` → claude 直连 `api.anthropic.com` → `403 Request not allowed` → claude `result.is_error=true`，文本 `Failed to authenticate. API Error: 403 Request not allowed` → `AUTH_SIGNATURES` 命中 `authentication` → `auth-missing`。

`403 Request not allowed` 是 Anthropic 边缘对**受限地域/网络**的响应，本质是「端点不可达」，**不是凭据问题**（凭据问题是 401 / `Not logged in` / `Invalid API key`）。

## 2. 接口契约变更

- `SmokeOutcome` 增成员 `'network-blocked'`（`runtimeSmoke.ts:24-30`）——**新增、不删旧**，是超集，旧缓存 `last_probe_json` 仍可渲染。
- 前端 `RuntimeList.tsx:33-39` 的 `SmokeResult.outcome` union 同步加 `'network-blocked'`。
- i18n `smoke` 块加键 `network-blocked`（类型 + zh/en 值）：`en-US.ts:647-653`、`zh-CN.ts:752-758`（类型）+ `zh-CN.ts:3101-3107`（值）。
- **无 DB migration**（outcome 只存在 `runtimes.last_probe_json` 文本里）。

## 3. 分类逻辑（核心）

新增正则（与 auth/model 并列），扫同一 `haystack`：

```ts
// 端点可达性失败：二进制起来了、能说协议，但到模型端点的网络请求被拒/不可达。
// 关键：claude 的地域限制文案是 "...authenticate. API Error: 403 Request not allowed"，
// 同时含 auth 词与网络词 —— 故 networkHit 必须在 authHit 之前判定（根因是网络，非凭据）。
const NETWORK_SIGNATURES =
  /403 request not allowed|not available in your (?:region|country|location)|fetch failed|network error|connection (?:error|refused|reset|timed ?out)|econnrefused|econnreset|econnaborted|enetunreach|ehostunreach|enetdown|enotfound|etimedout|eai_again|getaddrinfo|socket hang up|no route to host|network is unreachable|tunneling socket|unable to connect|could not connect|failed to connect/i
```

调整后的分类优先级（`runtimeSmoke.ts` else-if 链）：

```
conformed                       → conforms
timedOut                        → model-call-failed ("timed out")
networkHit                      → network-blocked        ← 新增，先于 auth
authHit                         → auth-missing
modelHit                        → model-call-failed
!sawEvent                       → stream-nonconforming
else                            → stream-nonconforming (nonce missing)
```

`detail`（network-blocked）：
> `binary reached but the model endpoint is unreachable (e.g. 403 Request not allowed / connection failed). Check the daemon's network/proxy (HTTP(S)_PROXY) so it can reach the model API, then re-probe.`

## 4. 正则边界 / 防误判表

| stdout/stderr 片段（小写后） | networkHit | authHit | 期望 outcome |
|---|---|---|---|
| `failed to authenticate. api error: 403 request not allowed` | ✓ | ✓ | **network-blocked**（network 先判）|
| `invalid api key · please run /login` | ✗ | ✓ | auth-missing |
| `not logged in` | ✗ | ✓ | auth-missing |
| `fetch failed` / `econnrefused` / `getaddrinfo enotfound api.anthropic.com` | ✓ | ✗ | network-blocked |
| `unauthorized` (401) | ✗ | ✓ | auth-missing |
| `rate limit exceeded` | ✗ | ✗ | model-call-failed |
| 正常回显 nonce | — | — | conforms（错误正则只在未 conform 时参考）|

设计要点（Codex impl-gate P2 收窄）：`NETWORK_SIGNATURES` **不含**裸 `403` / 裸 `region` / 裸 `blocked` / 裸 `proxy` / 裸 `request not allowed`——这些会出现在通用 auth/model 错误提示里，而 networkHit 先于 authHit，裸匹配会把凭据失败误导向网络。只匹配 `403 request not allowed` 完整地域文案 + **明确的连接错误**（\*nix errno / DNS / `fetch failed` / `tunneling socket`）；真鉴权文案（`not logged in` / `invalid api key` / `401 unauthorized`）不含任何网络词，仍稳落 `auth-missing`。

## 5. 消费点改动清单（全量）

| 层 | 文件 | 改动 |
|---|---|---|
| 后端 | `services/runtimeSmoke.ts` | `SmokeOutcome` 加成员；加 `NETWORK_SIGNATURES`；分类链插 `networkHit`（先于 auth）；network detail |
| 前端 | `components/RuntimeList.tsx` | `outcome` union 加成员；`smokeChipKind`：`network-blocked` → `warn`（与 auth-missing 同列，黄/可恢复）|
| i18n | `i18n/en-US.ts`、`i18n/zh-CN.ts` | `smoke` 类型 + 值加 `network-blocked`（en: `endpoint unreachable`；zh: `网络不可达`）|
| 测试 | `tests/runtime-smoke.test.ts` | 见 §6 |
| 测试 | `tests/runtime-list.test.tsx` | network-blocked chip 渲染 + kind |
| 注释勘误 | `runtimeSmoke.ts:205-211`（"(or proxy-blocked)" 那句）、`tests/runtime-smoke.test.ts:148-154` | 指向 network-blocked 新分类 |

`runner.ts` **不消费** `SmokeOutcome`（确认无引用），无需改动。

## 6. 测试策略（必写 case）

**后端 `runtime-smoke.test.ts`**（mock-claude 用 `MOCK_CLAUDE_IS_ERROR=1` + `MOCK_CLAUDE_RESULT_TEXT` 注入 stdout 错误文案）：

1. **改造现有 case**（`:155-174`）：文案 `API Error: 403 Request not allowed (authentication failed)` 的断言从 `auth-missing` 改为 **`network-blocked`**——它描述的正是本 RFC 要修的 proxy-blocked 误分类（注释同步更新，链回本 RFC）。
2. **新增**：`MOCK_CLAUDE_RESULT_TEXT='Invalid API key · Please run /login'` → **`auth-missing`**（守住真鉴权路径不被 network 正则吞）。
3. **新增**：`MOCK_CLAUDE_RESULT_TEXT='fetch failed'`（或 `getaddrinfo ENOTFOUND api.anthropic.com`）→ **`network-blocked`**（纯网络层）。
4. **回归**：`conforms` / `spawn-failed` / `stream-nonconforming` 既有断言保持绿。
5.（可选）opencode 协议：`MOCK_OPENCODE_STDERR` 注入 `ECONNREFUSED` → `network-blocked`，证明分类对两协议通用。

**前端 `runtime-list.test.tsx`**：`lastProbe.outcome='network-blocked'` → chip 文案取 `runtimes.smoke.network-blocked`、kind=`warn`（`findByText` / role 断言）。

**源码层兜底**：`networkHit` 在 `authHit` 之前的顺序是本 RFC 的命门——若被后续重构调换即回归（case 1 会变红即兜底）。

## 7. 失败模式与兼容

- 旧 `last_probe_json.outcome='auth-missing'` 渲染不受影响（union/i18n 均保留 auth-missing）。
- `network-blocked` 归 `warn`（非 `danger`）：语义是「可恢复——补上代理/网络即 conform」，与 `auth-missing` 同列，避免吓人成红。
- 无 migration、无 DB schema 变更、无跨模块导出（避开 binary-build module-cycle 风险）。

## 8. 与既有文档勘误

- `runtimeSmoke.ts:208-209` 的注释（"reachable-but-unauthenticated (or proxy-blocked) … misclassifies as stream-nonconforming"）改写：proxy/网络受阻现单列为 `network-blocked`，不再作为 auth-missing 的附带描述。（注：RFC-111 design.md 并无该措辞，原引用已纠正——Codex 设计 gate F3。）
- `STATE.md` 已完成表加一行（与 P-X-XX 同级），顶部「进行中 RFC」在完工后改 Done。
