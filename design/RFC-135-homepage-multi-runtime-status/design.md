# RFC-135 · 技术设计

## 1. 现状锚点（实现前请核对源码）

- 首页探针：`packages/frontend/src/components/home/HomepageGreeting.tsx:35-40`
  `useQuery` 打 `GET /api/runtime/opencode`，staleTime 30s / refetchInterval 60s；
  `describeRuntime` 纯函数 + `__test__` 导出。
- 旧端点：`packages/backend/src/routes/runtime.ts:15-39`（opencode / claude 两个
  `--version` 实时探针，读全局 config 路径）；同文件 `GET /api/runtime/models`
  为活跃端点（ModelSelect / RuntimeFormDialog 在用），**保留**。
- 注册表：`packages/backend/src/services/runtimeRegistry.ts` —
  `listRuntimes`、`runtimeRowToView(row, defaultRuntimeName)`（`isDefault =
  row.name === (defaultRuntimeName ?? 'opencode')`）、内置行 seed
  （`BUILTIN_RUNTIMES` = opencode + claude-code）。
- binary 解析先例：`packages/backend/src/routes/runtimes.ts:172-176`
  （`row.binaryPath ?? (protocol==='opencode' ? cfg.opencodePath ?? 'opencode'
  : cfg.claudeCodePath ?? 'claude')`）。
- 轻量探测函数：`packages/backend/src/util/opencode.ts:46 probeOpencode(path?)`、
  `packages/backend/src/services/runtime/claudeCode/probe.ts:33 probeClaudeCode(path?)`
  —— 均接受自定义二进制路径，返回 `{binary, version, compatible,
  incompatibleReason?}`；daemon 启动探测也用它们（**util 不删**）。
- 死代码：`packages/frontend/src/components/RuntimeStatusCard.tsx` 零引用
  （settings.tsx 只挂 `RuntimeList`）。

## 2. 接口契约（新增）

`GET /api/runtimes/status` — token auth + **`requirePermission('runtime:read')`**
（Codex gate F1：旧探针受 `server.ts:144-145` 的 `/api/runtime/*` → `runtime:read`
route gate 保护，而 `/api/runtimes/*` 前缀没有等价 gate——新端点若只做「任何
authed 用户」，被收窄的 PAT 无 `runtime:read` 也能触发所有注册二进制 spawn。
本端点在 handler/route 级补同名权限；普通用户（admin+user 默认含 runtime:read，
admin-only-gate.test.ts:180 现状即锁此面）仍可读，不属于 admin-only 的深 smoke 面）。

响应（shared 新 schema `RuntimesStatusResponseSchema`）：

```jsonc
{
  "runtimes": [
    {
      "name": "opencode",          // 注册表行名
      "protocol": "opencode",      // 'opencode' | 'claude-code'
      "binary": "/usr/local/bin/opencode", // 实际探测的二进制（按 §3 解析）
      "ok": true,                  // 可用性：`--version` 进程成功退出（exit 0）
      "version": "0.13.2",         // 解析出的版本串，仅展示用；null = 未解析出
      "isDefault": true            // name === (config.defaultRuntime ?? 'opencode')
    }
  ]
}
```

**响应刻意不含 `compatible` / `minVersion`**（用户拍板 2026-07-02，见 D3）：可用性
只看「二进制能跑 `--version` 且成功退出」，不做版本门槛比较；且 **`version`
解析失败不影响可用性**——自定义二进制的版本串可能非 `X.Y.Z` 形（`extractVersion`
解析不出），此时 `ok: true, version: null`，UI 显示为可用但不带版本号。为此
probe util 返回值增加**向后兼容可选字段 `ran?: boolean`**（true iff exit 0；
现有消费方 daemon / 深 smoke 不读它，零行为变化），status 端点以 `ran` 定 `ok`。

- **只含 enabled 行**（disabled 行不参与调度 picker，也不进首页状态——D2）。
- 排序沿 `listRuntimes` 现有顺序（无需额外承诺）。
- 空数组是合法响应（全部被 disable）。

## 3. 数据流

```
GET /api/runtimes/status
  → listRuntimes(db) → filter(enabled)
  → 每行并行：
      binary = row.binaryPath ?? 协议默认（复用 routes/runtimes.ts:172-176 规则，
               抽出小 helper resolveRuntimeBinary(row, cfg) 供 status 端点与
               POST /:name/probe 共用——消一处潜在漂移，呼应 dedup 审计原则）
      probe  = protocol === 'opencode' ? probeOpencode(binary) : probeClaudeCode(binary)
  → map 成契约行（isDefault 用 config.defaultRuntime ?? 'opencode'）
```

实现放 `routes/runtimes.ts`（同注册表面）；无新 service 文件必要，helper 放
`runtimeRegistry.ts` 或 `routes/runtimes.ts` 顶部（实现时就近选择，不新建模块）。

## 4. 关键决策

- **D1 展示形态**：逐个显示 enabled 运行时；`>3` 收敛为聚合计数 + **点名最坏
  severity 的异常行**（fault 优先于 soft，同 severity 取列表序第一——Codex gate
  F5：按「首个异常」点名会让前排的 soft 灰行藏住后排红色默认运行时故障）。
  阈值 3 写死在前端纯函数（首页 hero 单行宽度约束，非配置项）。
- **D2 enabled 过滤**：disabled 行不出现。用户「不想看到某运行时的红点」的正规
  出口就是 RFC-118 的 disable 开关。
- **D3 可用性判定与软硬语义（RFC-111 D10 的泛化 + 用户拍板）**：
  - **可用性不比较版本号**（用户拍板 2026-07-02）：已发现自定义二进制因自带
    版本体系与官方 `MIN_*_VERSION` 不可比而被误判「不兼容/探测失败」的真实案例。
    判定收敛为：`--version` 进程成功退出（exit 0）= 可用（ok）——**既不比较
    门槛，也不要求版本串可解析**（非 `X.Y.Z` 形版本串照样 ok，只是不展示
    版本号）；否则 = 缺失（missing）。原设计的 incompatible（红）状态**整个
    删除**。
  - probe util 内部仍会计算 `compatible`（daemon 启动的最低版本门槛是另一回事，
    **不在本 RFC 范围**，行为不动）；status 端点只取 `binary` / `version`，
    不消费也不透出 `compatible`。
  - 软硬语义按**默认运行时**泛化：`isDefault` 行缺失 → 红（fault）；非默认行
    缺失 → 灰（soft）。开箱 opencode-only 机器：内置 claude-code 行 enabled 且
    缺失 → 灰点弱提示，不构成常驻红点（保 RFC-111 D10 的原始动机）。
- **D4 数据来源**：实时 `--version` 探测，**不用** `lastProbe`——那是手动深 smoke
  的落库缓存（可能 null / 过期 / admin 才能刷新），语义是「上次测试结果」而非
  「现在就绪」。深 smoke 昂贵（真调模型）不可轮询。
- **D5 轮询与成本**：前端沿现状 staleTime 30s + refetchInterval 60s，query key
  `['runtimes','status','home']`。每次请求 spawn N 个 `--version`（N=enabled 行数，
  典型 2，并行）。不加服务端 TTL 缓存（成本不足以要求）。
  **每行探测带超时且 kill 子进程**（Codex gate F2 + F4）：旧探针只测全局 config
  的 opencode/claude，新端点探测**任意注册 binaryPath**且聚合等待所有行——单个
  挂死的 fork 会让端点与所有人的首页永卡 checking；而且**route 层纯 Promise.race
  不够**——HTTP 先返回了，probe 内部 `Bun.spawn` 的挂死子进程没人 kill，60s 轮询
  下每次泄一个进程。因此超时下沉到 probe util：`probeOpencode` / `probeClaudeCode`
  签名扩展为**向后兼容的可选 opts `{ timeoutMs?, quiet? }`**（不传 = 现行为，
  daemon 启动探测零变化）。`timeoutMs` 传入时内部 race `proc.exited` 与定时器，
  超时直接 **`proc.kill('SIGKILL')`**（Codex gate F6：默认 SIGTERM 可被忽略，
  kill 后再无界等 `proc.exited` 会重新悬挂——SIGKILL 不可忽略，等待必然有界）
  再 await exited 回收，按 `version: null` 返回。status 端点传 5000ms（可注入
  供测试用小值）。
- **D6 旧面清理**：删 `RuntimeStatusCard.tsx`、`GET /api/runtime/opencode`、
  `GET /api/runtime/claude`、shared `RuntimeOpencodeStatusSchema` /
  `RuntimeClaudeStatusSchema`（`OpencodeModelSchema` / `RuntimeModelsResponseSchema`
  保留）。`routes/runtime.ts` 只剩 models 端点（文件保留，头注释更新）。
  本仓 pre-1.0 且旧探针无对外 API 承诺，直删不留兼容层。
- **D7 前端结构**：`describeRuntime` 重构为 `describeRuntimes(t, probe)` 纯函数
  （输入 query 状态 + 行数组，输出 items[] 或聚合视图的判别 union），保留
  `__test__` 导出模式；每个 item 渲染自己的状态点。
  **状态点 CSS 语义化改名**（Codex gate F3：现有变体按「原因」命名且颜色与新
  语义错位——`--missing` 是红，而新语义要求非默认缺失=灰，按旧名直用必然错色）：
  `describeRuntimes` 对每 item 输出 **severity**（`ok`=绿 / `fault`=红 /
  `soft`=灰 / `checking`=琥珀，原因→severity 的映射即 D3——version 非 null=ok，
  null 则默认行 fault、非默认行 soft），CSS 改为
  `.homepage__runtime-dot--{ok|fault|soft|checking}` 四个语义变体（唯一消费方
  就是首页，旧四类同批删除，无迁移负担）；缺失非默认时文案套 `muted`。
  新增 CSS 仅限 severity 变体与 item 间距，不新造 chrome。

## 5. i18n

`home.runtime.*` 重构（zh-CN / en-US 对称，含 bundle 类型声明）：

| key | zh-CN | en-US |
| --- | --- | --- |
| `item.ready` | `{{name}} v{{version}}` | `{{name}} v{{version}}` |
| `item.readyNoVersion`（ok 但版本串未解析出） | `{{name}} 可用` | `{{name}} ok` |
| `item.missing` | `{{name}} 未找到` | `{{name}} not found` |
| `checking` | 检查中…（沿用） | checking…（沿用） |
| `aggregate` | `{{ok}}/{{total}} 个运行时就绪` | `{{ok}}/{{total}} runtimes ready` |
| `aggregateWorst` | `{{ok}}/{{total}} 个运行时就绪 · {{name}} 异常`（点名按 D1 最坏 severity） | `{{ok}}/{{total}} runtimes ready · {{name}} unhealthy` |
| `noneEnabled` | `无已启用的运行时` | `no runtimes enabled` |

旧 `ready` / `missing` / `incompatible`（opencode 硬编码文案）删除——
incompatible 状态随 D3 拍板整个消失，不设对应新 key。

## 6. 失败模式

- 某二进制不可执行 / 不存在 → probe 返回 `version: null`（probe util 已吞异常），
  端点不 5xx；前端按 D3 渲染灰/红。
  **日志噪音抑制**（Codex gate F7）：opencode-only 开箱机器上内置 claude-code
  行 enabled 且缺失是**预期常态**，60s 轮询若沿用 probe util 现有 log.warn 会
  每分钟刷一条告警。status 端点对每行 probe 传 `quiet: true`（探测结果已体现
  在响应与首页 UI 里，不再重复进日志）；daemon 启动探测不传，告警行为不变。
- 某二进制 `--version` 挂死 → 该行在 D5 超时（默认 5s）后被 SIGKILL 回收并按
  失败处理（`ok: false`），端点整体仍在超时窗口内返回，其余行不受影响。
  **实现要点（实测 + Codex 实现 gate）**：对直接子进程的 SIGKILL 不够——挂死
  二进制若是 wrapper（如 sh 脚本），真正挂死的是其**孙进程**：它既继续持有
  stdout 管道写端（把 `text()` 的 EOF 等待挂到它退出），又在每次轮询后存活
  累积（进程泄漏）。最终形态：带 `timeoutMs` 的探测以 **`detached: true`**
  （Bun 原生支持，独立进程组）spawn，超时用 `process.kill(-pid, 'SIGKILL')`
  **整组回收**（fallback 单进程 kill）；probe 内 exit 等待与 stdout 读取解耦
  且读取同样有界（超限降级空串；`ran` 只看 exit code）。测试用「fork 不 exec」
  的 sh fixture + 唯一 pgrep 标记断言全树无幸存。不传 `timeoutMs` = 历史行为
  逐字不变（不 detached）。
- 端点整体失败（网络 / 401）→ 前端沿现状：checking 态兜底（`describeRuntimes`
  对 `isLoading || !data` 返回 checking，与今天行为一致；不为 error 单独设计视觉）。
- 全部 disabled → 空数组 → `noneEnabled` 灰点 + 链接设置页。
- 并发：探测彼此独立并行（`Promise.all`），单行失败不影响其他行。

## 7. 测试策略（随实现落地，缺一不交付）

Backend（新文件 `packages/backend/tests/rfc135-runtimes-status.test.ts`）：
1. 默认注册表（两内置行 enabled）→ 200 返回两行；opencode 行 `isDefault: true`；
   字段形状过 shared schema 校验。
2. disable claude-code 后 → 只返回 opencode 行（enabled 过滤锁定）。
3. 注册自定义 fork（binaryPath 指向测试 fixture 假脚本，echo 一个版本号）→
   该行 `binary` = fixture 路径、`ok: true`、`version` = 假脚本输出
   （binaryPath 感知锁定；fixture 手法沿 `runtime-routes.test.ts` 既有做法）。
3b. fixture 输出**非 `X.Y.Z` 形版本串**（如 `fork build 42`，exit 0）→
   `ok: true, version: null`（D3 拍板核心回归：能跑即可用，解析失败不降级）。
4. binaryPath 指向不存在路径 → `ok: false, version: null`，端点仍 200；响应体
   **不含** `compatible` / `minVersion` 键（D3 拍板锁定——防未来实现顺手透出）。
5. 鉴权：无 token → 401；普通用户 token → 200（接住 admin-only-gate.test.ts 里
   被删旧断言的职责）；**收窄 PAT（无 `runtime:read`）→ 403**（gate F1 回归）。
6. `config.defaultRuntime` 指到 claude-code → isDefault 标记跟随。
7. 挂死二进制 fixture（sleep 脚本）+ 注入小超时 → 端点及时返回、该行
   `version: null`，同批其他行正常，**且挂死子进程已被 kill**（探测 fixture 的
   进程不存活；gate F2/F4 回归）。

联动更新：
- `runtime-routes.test.ts`：删 `GET /api/runtime/opencode` / `GET /api/runtime/claude`
  两个 describe 块（models 部分保留）。
- `admin-only-gate.test.ts:180` 附近：旧探针断言改为 `/api/runtimes/status`。
- `tests/contracts/registry.ts:378,384`：两旧端点条目删除，新端点条目登记。

Frontend（vitest）：
1. `describeRuntimes` 纯函数单测：双绿 / 非默认缺失（soft 灰）/ 默认缺失
   （fault 红）——severity 映射即 D3/D7，gate F3 的错色回归靠这里锁——
   / **奇异版本号仍 ok**（自定义 fork 输出非标准版本串 → 绿；D3 拍板回归）
   / >3 收敛 + **最坏 severity 点名**（soft 行在前、fault 行在后 → 点名 fault
   行；gate F5 回归）/ 空列表 noneEnabled / loading→checking。
2. `homepage.test.tsx` 与 `index-page-routing.test.tsx`（gate F8：后者
   `:72` 的 mock 同样拦截旧端点，漏改会静默失去新响应形状的覆盖）：mock 由
   `/api/runtime/opencode` 换成 `/api/runtimes/status`；断言两运行时名称+版本
   渲染、缺失场景文案（中英任一按现有测试惯例）。
3. 源码层文本断言（兜底，随既有模式放 `homepage.test.tsx` 或独立小测试）：
   `HomepageGreeting.tsx` 源码不得出现 `'/api/runtime/opencode'`。
4. i18n key 对称：依赖现有 bundle 类型声明（TS 编译期保证），无需专测。

## 8. 兼容性

- 零 migration（纯读端点；无表结构变更）。
- API 破坏面：删除两个旧探针端点（无前端消费方；pre-1.0 无外部承诺——proposal
  AC-4 已声明）。`GET /api/runtimes`、`GET /api/runtime/models` 字节不变。
- shared 包导出删除两个类型：全仓引用仅 `RuntimeStatusCard.tsx`（同批删）与
  `HomepageGreeting.tsx`（同批改），无残留消费方。

## 9. 评审记录

- Codex 设计 gate 第 1 轮（2026-07-02）：3 × P2 全部采纳并 fold——
  F1 新端点补 `runtime:read` 权限（§2 + §7 case 5）；F2 聚合探测每行超时
  （D5 + §6 + §7 case 7）；F3 状态点 CSS 语义化改名，杜绝旧类名错色（D7 +
  §7 frontend case 1）。
- Codex 设计 gate 第 2 轮（2026-07-02）：1 × P2 采纳——F4 route 层纯 race 超时
  会泄漏挂死子进程（60s 轮询逐次累积），改为超时下沉 probe util 可选
  `timeoutMs` + kill 回收（D5 + §6 + §7 case 7）。
- Codex 设计 gate 第 3 轮（2026-07-02）：3 × P2 + 1 × P3 全部采纳——
  F5 聚合点名按最坏 severity（D1 + §7 frontend case 1）；F6 kill 改用不可忽略
  的 SIGKILL，杜绝 kill 后二次悬挂（D5）；F7 status 端点 probe 传 `quiet`
  抑制 soft-missing 常态下的 60s 周期告警刷屏（§6）；F8 plan 补
  `index-page-routing.test.tsx:72` 旧端点 mock 联动（§7 frontend case 2）。
- Codex 设计 gate 第 4 轮（2026-07-02）：1 × P2 采纳——F9 proposal AC-3 残留
  「首个异常项」与 D1 最坏 severity 矛盾，已对齐。第 5 轮 clean（approve），
  设计 gate 收敛：5 轮 / 9 findings 全 fold。
- 用户批准（2026-07-02）+ 追加拍板：**可用性判定不比较版本号**（线上已现
  自定义二进制版本体系与官方门槛不可比导致的探测误报）——契约去
  `compatible` / `minVersion`，incompatible 状态删除（D3/§2/§5/§7 已同步）；
  daemon 启动版本门槛不在本 RFC 范围。
- Codex 实现 gate 第 1 轮（2026-07-02）：1 × P2 采纳——F10 超时只 SIGKILL
  直接子进程，sh-wrapper 的孙进程（真正挂死者）每轮询泄漏一个 → 改为
  `detached: true` 独立进程组 + `process.kill(-pid, 'SIGKILL')` 整组回收
  （§6 实现要点；测试加 pgrep 全树无幸存断言）。
- Codex 实现 gate 第 2 轮（2026-07-02）：1 × P2 采纳——F11 wrapper 在超时
  **前**非零退出会 clear 唯一 timer，遗留后代永不被杀 → finally 侧无条件
  整组 reap 兜底（幂等，组空 ESRCH 吞掉；测试加「fork 后 exit 7」fixture +
  pgrep 断言）。
- Codex 实现 gate 第 3 轮（2026-07-02）：1 × P2 采纳——F12 `config.defaultRuntime`
  指向已删/未知名时端点按原字符串比较 → 无行标 isDefault，坏掉的**有效默认**
  （dispatch fail-safe 回 opencode）误渲染为 soft 灰 → defaultName 对齐
  `resolveRuntimeByName` 的 fail-safe（enabled 行中无 configured 名即回落
  opencode；RFC-118 保证默认行不可 disable，enabled 过滤不掩蔽）。第 4 轮
  clean（approve）——实现 gate 收敛：4 轮 / 3 findings 全 fold。
