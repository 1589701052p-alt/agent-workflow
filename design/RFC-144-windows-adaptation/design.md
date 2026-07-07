# RFC-144 — 技术设计

> 阻塞点全景见 §2（13 类，带 file:line，2026-07-07 快照，落地前逐项复核）；平台原语收口见 §3；文件系统与路径见 §4；敏感文件 ACL 见 §5；wsl-opencode driver 见 §6（核心）；MCP/indexers/备份见 §7；构建与 CI 见 §8；失败模式 §9；测试策略 §10。

## 1. 设计原则

1. **平台分支单源**：所有 `process.platform === 'win32'` 判别只许出现在 `util/platform.ts` 与 `runtime/wsl-opencode/` driver 内部。业务层（runner/scheduler/routes/services）调平台原语函数，永不自己判平台——违者按回归打回（与 RFC-143 旁路清零同款纪律）。
2. **外部约束封装在 driver 边界**：opencode 不支持原生 Windows 这一事实，封装在 `wsl-opencode` driver 内；业务层只见 `getRuntimeDriver(runtime)`，与 RFC-143 收口后的调用形态完全一致。
3. **行为等价，不重写**：POSIX 路径的 kill/stop/lock/symlink/file:// 行为被既有 golden/单测锁死。Windows 适配是「同一语义换个平台机制」，不是行为变更。POSIX 分支 byte-for-byte 保留。
4. **安全不降级**：chmod 在 Windows 是 no-op 这类「静默失效」是安全回归的高危区——必须用 ACL 等价闭合，且配实证测试，不能靠「测试在 Windows 跑绿」掩盖。
5. **opencode 行为以源码为准**：`wsl` 透传 env、路径映射、stdout JSON 事件流是否丢帧等，必须在 PR-3 用真实 opencode 验证（CLAUDE.md 强制），不靠记忆。

## 2. 阻塞点全景（取证结果）

| 类 | 现状（file:line） | Windows 问题 | 收口去向 |
|---|---|---|---|
| **进程组/kill** | `util/process.ts:32` `process.kill(-pid,sig)`；`runner.ts:924` `detached:true`；`opencode.ts:86` 探针 detached | POSIX `setsid()` 进程组在 Windows 不存在；负 pid group-kill 无效 | §3.1 Job Object |
| **信号语义** | `cli/stop.ts:46` `SIGTERM`；`runner.ts:1240` `SIGTERM→SIGKILL`；`start.ts:515` handler | Windows 无 SIGTERM；`process.kill(pid)`=硬杀，无优雅停机 | §3.2 优雅停机双通道 |
| **`ps` 命令指纹** | `util/process.ts:61,79` `ps -p <pid> -o command=` | `ps` 不在 Windows；陈旧 PID 复用门失效 | §3.3 wmic/CIM 分流 |
| **单实例锁** | `util/lock.ts:53` `openSync('wx')` O_EXCL PID 文件 | ✅ 已跨平台（注释明说 no flock dependency） | 无需改 |
| **symlink** | `runner.ts:1596` external skill `symlinkSync(dir)`；`claudeCode/config.ts:60` | Windows 软链需开发者模式/管理员 | §4.1 junction/copy |
| **file:// plugin spec** | `runner.ts:549,1752` `` `file://${pluginPath}` ``；`pluginInstaller.ts:230` `new URL(spec).pathname` | `C:\…` → `file://C:\…` 畸形；pathname=`/C:/…` 需 fileURLToPath | §4.2 pathToFileURL 全局统一 |
| **home/路径** | `util/paths.ts:appHome()` `homedir()+'.agent-workflow'`；`skill-source.ts:647` `~/` | 基本可用；但 Windows MAX_PATH=260 对深 worktree 是真风险 | §4.3 长路径 |
| **tar 备份** | `services/backup.ts:152` `Bun.spawn(['tar','-czf',...])` | Win10 1803+ 自带 bsdtar 但靠不住 | §7.2 tar 探测+降级 |
| **chmod 600** | `auth/secretBox.ts:24`、`auth/token.ts:29`、`pluginInstaller.ts:181` mode 0o700 | Windows 无 unix mode → 敏感文件实际未隔离=安全回归 | §5 ACL 闭合 |
| **MCP stdio env** | `mcpProbe.ts:367` `['PATH','HOME','LANG']` | Windows 无 `HOME`（是 USERPROFILE）；`npx`/`uvx` 是 `.cmd` shim | §7.1 env 白名单扩充 |
| **opencode spawn** | `opencode/spawn.ts` `['opencode','run',...]`；`PWD` 注入 | npm 全局 opencode 在 Windows 是 `opencode.cmd` shim；opencode 不原生支持 Windows | §6 wsl-opencode driver |
| **SCIP indexers** | `structuralDiff/deep/indexers.ts:37` scip-ts/py/go、rust-analyzer、scip-clang/java | 外部二进制，多数有 Windows 构建，scip-clang 可能没有 | §7.3 可选降级 |
| **构建/CI** | `scripts/build-binary.ts` `--target=bun`；现仅 macos/linux matrix | 需加 `bun-windows-x64` target + `windows-latest` matrix | §8 |
| **shell** | 全后端 spawn 均用 argv 数组、无 `sh -c` | ✅ 最干净的一点，几乎不用动 | 无需改 |

## 3. 平台原语收口（`util/platform.ts`，业务层无感）

新建 `util/platform.ts` 为**唯一**平台分支出口。`util/process.ts` 的现有导出（`isProcessAlive`/`killProcessTree`/`pidCommand*`/`killStaleRunProcessTree`）改为委托 `platform.ts` 的平台分流实现；签名不变，调用点零改动。

### 3.1 进程树 kill — `taskkill /T /F`（v1）→ Job Object（未来硬化）

Windows 无进程组/`setsid`。**v1 实现**用 `taskkill /T /F /PID <pid>`——`/T` 递归杀整个进程树，是最接近 group-kill 的零依赖机制（无 N-API addon）。已落地于 `util/platform.ts` `killProcessTree` Windows 分支，POSIX 分支 byte-for-byte 保留 `process.kill(-pid)` + 单 pid fallback。

> **设计偏差（已记录）**：原设计 §3.1 写的是 Job Object（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，spawn 时挂子进程进 Job、关句柄收全树含脱离的孙子）。实现时评估：Job Object 需 Win32 API 经 N-API addon 暴露，引入 native 依赖与构建复杂度，而 `taskkill /T /F` 对 v1 的常见场景（opencode 子进程 + 其 MCP/shell-tool 直系后代）已足够。**Job Object 留作未来硬化**——针对「孙子进程脱离 `/T` 树」的极端场景（如 docker MCP daemon 自行 detach）。`detached: true` 在 Windows 分支暂保留（不阻断 taskkill），等 Job Object 落地时再评估改为不 detached。

落地范围（PR-1）：`util/process.ts` 三原语委托 `util/platform.ts`；`runner.ts` `killTree` 委托 `killProcessTree`；`util/opencode.ts` + `runtime/claudeCode/probe.ts` 探针超时的 group-kill 也委托。POSIX 全路径 byte-for-byte 不变。

### 3.2 优雅停机 — 双通道

Windows 无 SIGTERM，`process.kill(pid)` 是 TerminateProcess（硬杀）。优雅停机改走双通道：

1. **`CTRL_BREAK_EVENT` / console ctrl**：daemon 自身注册 `process.on('SIGBREAK')`（Windows console ctrl-break 映射）+ 既有 `SIGINT`（Windows 下 ctrl-c 仍触发）。POSIX 的 `SIGTERM` handler 在 Windows 改挂 `SIGBREAK`。
2. **`agent-workflow stop`**（`cli/stop.ts:46`）：Windows 分支不再 `process.kill(pid,'SIGTERM')`，改为 HTTP `POST /api/shutdown`（既有 Hono server 加一个本地 token 守卫的端点，token 从 `Paths.daemonInfo` 读）。daemon 收到后走既有 `shutdown()` 路径（abort 所有任务 AbortController、关 DB、释放锁）。
3. **SIGTERM→SIGKILL 升级**（`runner.ts:1240`）：Windows 分支改为「HTTP 通知优雅停 → bounded 等待 → Job Object 硬杀」三级，语义等价。POSIX 保留 SIGTERM→SIGKILL byte-for-byte。

### 3.3 PID 命令指纹 — wmic/CIM

`pidCommandLooksLikeAgentChild`/`pidCommandContainsBinary`（`util/process.ts:59-85`）现用 `ps -p <pid> -o command=`。Windows 分支改用：

- 优先 `wmic process where ProcessId=<pid> get CommandLine`（兼容性好，Win7+ 都有）；wmic 在新 Win11 被弃用但仍可用。
- 兜底 PowerShell `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select CommandLine`。
- 字符串匹配逻辑（`/opencode|bun/i` regex、`includes(binaryPath)`）不变，只换取命令行的机制。

`isProcessAlive(pid)`（`util/process.ts:14` `process.kill(pid,0)`）✅ 已跨平台，不动。

## 4. 文件系统与路径

### 4.1 symlink — junction/copy

`runner.ts:1596` / `claudeCode/config.ts:60` 的 external skill `symlinkSync(target, dst, 'dir')`：

- Windows 分支改 `fs.symlinkSync(target, dst, 'junction')`——**目录 junction 不需开发者模式/管理员**（与 dir symlink 不同）。
- 文件型 external skill（罕见）降级为 copy（external skill 本就是只读引用，与 managed skill 的 copy 路径同源，代价可接受）。
- POSIX 分支保留 `'dir'` symlink。
- 收口到 `util/platform.ts` 的 `linkSkillDir(target, dst)` 单函数，两调用点改调它。

`upload.ts` 的 symlink-traversal 安全检查（`realpathInside`/`lstat`）✅ 在 Windows 仍工作（lstat 可用），不动；但 PR-2 补一条「Windows 上 symlink-based repo 攻击行为等价」的回归测试。

### 4.2 file:// — pathToFileURL 全局统一

`runner.ts:549,1752` 的 `` `file://${pluginPath}` `` 字符串拼接在 Windows 产 `file://C:\…`（畸形）；`pluginInstaller.ts:230` `new URL(spec).pathname` 在 Windows 产 `/C:/…`（反解错）。

- **全局统一**用 `node:url`：拼用 `pathToFileURL(pluginPath).href`，反解用 `fileURLToPath(url)`。
- 这是跨平台正确写法，**POSIX 行为等价**（`pathToFileURL('/x/y')`→`file:///x/y`，与现状字符串拼接结果一致），可全平台统一、删掉分支。
- 改动点：`runner.ts:549,1752,1822,1824`、`pluginInstaller.ts:229-230`。

### 4.3 长路径 — MAX_PATH

Windows 默认 MAX_PATH=260；worktree 根 `~/.agent-workflow/worktrees/{slug}/{task-id}` + 深嵌套仓库文件易触上限：

1. `agent-workflow doctor` 加「LongPathsEnabled 注册表项」检查，未启用则提示（不强制阻断——用 `\\?\` 前缀兜底）。
2. 二进制 manifest 加 `longPathAware: true`（`scripts/build-binary.ts` 配 Bun compile 选项或单独 `.manifest` 文件）。
3. 对超长路径 fallback `\\?\` 前缀（`util/platform.ts` 的 `toLongPath(p)`）。

### 4.4 home 目录

`appHome()`（`util/paths.ts`）维持 `homedir()+'/.agent-workflow'`（Windows 下 `C:\Users\<u>\.agent-workflow`，可接受，与 POSIX 跨机一致）；`AGENT_WORKFLOW_HOME` 覆盖已支持。**不强行改 `%APPDATA%`**——会破坏跨平台一致体验。`skill-source.ts:647` 的 `~/` 扩展走 `homedir()` ✅ 已可用。`claudeCode/config.ts:102` 的 `~/.claude/.credentials.json` 在 Windows 下读 `C:\Users\<u>\.claude`（claude-code 在 Windows 的存储位置），PR-3 用真实 claude-code 验证。

## 5. 敏感文件 ACL（安全等价闭合）

Windows 无 unix mode，`chmod 600` 是 no-op——`secret.key`（OIDC client_secret 密封密钥）/`token`（daemon token）在 Windows 实际全可读，**这是安全回归，必须修**。

新建 `util/fs-perms.ts`：

```ts
/** Secure a sensitive file/dir to current-user-only (chmod 600 / icacls). */
export function secureFile(p: string): void
/** Secure a dir to current-user-only (chmod 700 / icacls). */
export function secureDir(p: string): void
```

- POSIX 分支：`chmodSync(p, 0o600)` / `0o700`（现状行为）。
- Windows 分支：`icacls <p> /inheritance:r /grant:r "${USER}:R"`（文件）/`":(OI)(CI)F"`（目录，含继承）。当前用户从 `os.userInfo().username` 或 `process.env.USERNAME` 取。
- 调用点：`auth/secretBox.ts:24,33`、`auth/token.ts:29,39`、`pluginInstaller.ts:181` 改调 `secureFile`/`secureDir`。
- **实证测试**：Windows 上用 `icacls <p>` dump ACL，断言只有当前用户、无 `Everyone`/`Users` 组——不能只看文件能写。

## 6. wsl-opencode runtime driver（策略 C 核心）

这是与 RFC-143 的接合点。RFC-143 把 `RuntimeDriver` 收口成完整能力对象（`probe`/`listModels`/`captureSessions`/`buildBusinessSpawn`/`defaultBinary`+optional `readInventory?`/`startLiveCapture?`+`minVersion`）。在此之上新增 `wsl-opencode` driver，实现同一接口：

### 6.1 能力映射

| 能力 | wsl-opencode 实现 |
|---|---|
| `kind` | `'wsl-opencode'` |
| `minVersion` | 与 opencode driver 同 `'1.14.0'`（同一个 opencode，经 WSL 跑） |
| `parseEvent` | 复用 `runtime/opencode/parseEvent`（stdout JSON 事件流不变） |
| `defaultBinary` | `['wsl.exe']`（或可配 `wslOpencodePath` → 直接 `wsl.exe -d <distro> -- opencode`） |
| `probe` | 经 `wsl.exe -d <distro> -- opencode --version`，解析同 `extractVersion` |
| `listModels` | 经 `wsl.exe -d <distro> -- opencode models --verbose` |
| `buildBusinessSpawn` | 见 §6.2（核心） |
| `captureSessions` | 经 WSL 内 opencode SQLite 路径，或 JSONL 经 `\\wsl$` 回 Windows 侧读 |
| `readInventory?` | 经 `\\wsl$\<distro>\…\inventory.json` 回读 |
| `startLiveCapture?` | 经 WSL 内 opencode SQLite（poll 跨边界，需评估性能；或关闭 live poll、仅 post-run capture） |

### 6.2 buildBusinessSpawn（argv/env 组装）

把既有 `buildOpencodeSpawn`（`runtime/opencode/spawn.ts`）的 opencode argv/env 包进 WSL 调用：

- **argv**：`['wsl.exe', '-d', distro, '--', 'bash', '-lc', 'opencode run <prompt> --agent <name> --format json --thinking --dangerously-skip-permissions']`。prompt 经 stdin 或 argv——经 WSL 时 argv 的 E2BIG 风险更高，倾向 stdin（claude driver 已有先例，`runner.ts:919`）。`--session` resume 同理。
- **env**：`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG_CONTENT`/`OPENCODE_AW_INVENTORY_OUT`/`GIT_*`/`PWD` 经 `WSLENV` 透传（`WSLENV=OPENCODE_CONFIG_DIR/p:OPENCODE_CONFIG_CONTENT/p:OPENCODE_AW_INVENTORY_OUT/u:GIT_AUTHOR_NAME/u:…`）。`PWD` 改为 WSL 内路径。
- **cwd**：`Bun.spawn` 的 `cwd:` 设为 worktree 的 **Windows 路径**，`wsl.exe` 自动把它映射成 WSL 内路径（或显式映射）。
- **stdin/stdout/stderr**：pipe 不变；opencode 的 `--format json` 事件流经 stdout 原样到达 runner 的 pump——**PR-3 必须用真实 opencode 验证不丢帧**（CLAUDE.md：opencode 行为以源码为准）。

### 6.3 worktree 路径策略（决策点）

- **选项 W1**：worktree 放 Windows 文件系统（`~/.agent-workflow/worktrees/...` = `C:\Users\…`），WSL 经 `/mnt/c/…` 访问。**优**：Windows 侧 git/diff/文件浏览直接可用；**劣**：`/mnt` 跨文件系统 IO 慢，opencode 读写仓库文件有性能税。
- **选项 W2**：worktree 放 WSL 文件系统（`\\wsl$\<distro>\home\…`），WSL 内原生路径。**优**：IO 快；**劣**：Windows 侧 task detail 的 worktree 文件浏览/diff 要经 UNC 路径，`git` 在 Windows 侧操作要切 WSL。
- **推荐 W2**（性能优先），文档说明取舍；`util/platform.ts` 提供 `toWslPath(winPath)`/`toWinPath(wslPath)` 双向映射单源。

### 6.4 runtime 默认解析

Windows 上默认 runtime 解析为 `wsl-opencode`（除非用户在 config 显式配了原生 Windows opencode 路径——届时走未来 `native-windows-opencode` driver，本 RFC 不实现但留口子）。`runtimeRegistry` 的默认解析逻辑加 Windows 分支，收口在 registry 单源。

### 6.5 WSL 依赖检查

`doctor` 加 WSL 检查：`wsl.exe --status` 探测 WSL2 + 默认发行版；缺失则明确报「需装 WSL2 + 一个 Linux 发行版 + 发行版内装 opencode」而非模糊失败。这是策略 C 对「原生 Windows」的诚实妥协，文档与 doctor 都标注。

## 7. MCP / indexers / 备份（降级路径）

### 7.1 MCP stdio env

`mcpProbe.ts:367` `MINIMAL_INHERITED_ENV_KEYS = ['PATH','HOME','LANG']`：Windows 加 `USERPROFILE`/`HOMEDRIVE`+`HOMEPATH`/`PATHEXT`/`SystemRoot`/`ComSpec`。对 `HOME` 做「opencode/MCP 若依赖 HOME 则映射成 USERPROFILE」的兼容注入（`util/platform.ts` 的 `normalizeEnvForPlatform(env)`）。`npx`/`uvx` 类 `.cmd` shim 由 Bun spawn 的 PATHEXT 解析处理（PR-4 用真实 MCP server 验证）。

### 7.2 tar 备份

`services/backup.ts:152` `Bun.spawn(['tar','-czf',...])`：Windows 探测 `tar.exe`（Win10 1803+ 自带 bsdtar，`which('tar')`）；可用则直接用（argv 不变）；不可用降级为 Node `zlib`+`tar`(npm) 纯 JS，或 `powershell -Command 'Compress-Archive …'`（产物 `.zip` 而非 `.tar.gz`，文档标注）。优先用系统 tar。

### 7.3 SCIP indexers

`structuralDiff/deep/indexers.ts:37` 的六个 indexer（scip-typescript/python/go、rust-analyzer、scip-clang、scip-java）保持可选——`probeIndexer` 已是「缺失即 `available:false`、不抛」。Windows 上 scip-clang 等若无构建，结构化 diff 自动降级为文本 diff，不阻塞主流程。文档列明各 indexer 的 Windows 可得性；不改代码。

## 8. 构建与 CI

- `scripts/build-binary.ts`：matrix 加 `--target=bun-windows-x64`，产物名 `agent-workflow-windows-x64.exe`。embed 逻辑（前端 dist + migrations + opencode-plugin `.mjs`）平台无关，不动。
- `.github/workflows`：加 `windows-latest` job，跑 `typecheck && test && format:check && build:binary smoke` + Playwright e2e。
- README Requirements 表「OS: macOS or Linux」改为「macOS / Linux / Windows 10/11+Server 2022（opencode 经 WSL）」。

## 9. 失败模式

- **WSL 缺失**：doctor 在 `wsl.exe --status` 失败时明确报「需装 WSL2」，daemon 启动 gate 拒绝（与 opencode 缺失同档）。不模糊失败。
- **路径映射竞态**：Windows↔WSL 路径来回转换（`/mnt/c` vs `\\wsl$`、大小写、空格、盘符）是 bug 温床——集中在 `util/platform.ts` 的 `toWslPath`/`toWinPath` 单源，单测覆盖边界（空格、UNC、盘符大小写）。
- **ACL 静默失效**：chmod no-op 易被「Windows 测试跑绿」掩盖——必须有 `icacls` dump 断言 ACL 的实证测试（§5）。
- **stdout 丢帧**：opencode `--format json` 事件流经 `wsl.exe` 透传可能丢帧或改编码（CRLF/UTF-8 BOM）——PR-3 用真实 opencode 跑一条任务验证事件流完整到达 pump；必要时在 driver 内做 CRLF→LF 规整。
- **Job Object 句柄泄漏**：spawn 开 Job 但未 close → 句柄泄漏。`proc.exited` 后 finalizer close + 兜底定时清理；单测断言映射 Map 不无限增长。
- **binary 模块环**：本 RFC 触 shared 导出（`util/platform.ts` 可能被 shared 引用）+ 新 driver 目录——`build:binary` 可能暴露 typecheck/bun:test 漏掉的 init-cycle（memory `reference_binary_build_module_cycle`）。每 PR 必跑 binary smoke。
- **MAX_PATH**：未启用长路径时深 worktree 失败——doctor 检查 + `\\?\` 兜底；不阻断启动但 doctor 标黄。

## 10. 测试策略

### 保护网（POSIX，保持绿 / 按需同步）

- `runtime-opencode-golden.test.ts` — opencode 业务 spawn byte-for-byte，**POSIX 路径必须逐字绿**（§3/§6 的 Windows 分支不触碰 POSIX argv/env）。
- `lock.test.ts` / `process.test.ts` — 锁与 kill 既有单测；`util/process.ts` 委托 `platform.ts` 后同步。
- `runner-inventory-integration.test.ts` — inventory 注入/回读；wsl driver 路径映射不破坏 POSIX 路径。
- `pluginInstaller` / `backup` / `mcpProbe` 现有单测——POSIX 分支不回归。

### 新增（本 RFC 验收锁）

1. **平台原语单测**（Windows 分支，mock 或真实）：`killProcessTree` Job Object 收回子孙（mock spawn + 模拟 Job）；`pidCommand*` 走 wmic mock；优雅停机 HTTP `/shutdown` 端点 + token 守卫。
2. **file:// 跨平台往返**：`pathToFileURL`→`fileURLToPath` 在 Windows 路径（`C:\…`）与 POSIX 路径（`/x/y`）下往返等价。
3. **ACL 实证测试**（Windows）：`secureFile`/`secureDir` 后用 `icacls` dump 断言仅当前用户。
4. **wsl-opencode driver 集成测试**：mock WSL（或真实）跑通 buildBusinessSpawn + probe + listModels + captureSessions + readInventory 一条路径；argv/env 经 WSLENV 透传断言；stdout 事件流完整到达 pump 断言（真实 opencode 验证标注 `@requiresWsl`）。
5. **路径映射单测**：`toWslPath`/`toWinPath` 边界（空格、UNC、盘符大小写、`\\wsl$` vs `/mnt/c`）。
6. **业务层零平台散落源码文本锁**：`rg -n "process\.platform\s*===\s*'win32'" packages/backend/src`（排除 `util/platform.ts` + `runtime/wsl-opencode/` + tests）零命中。
7. **doctor Windows 检查**：WSL/opencode/git/long-path/ACL 五项各自的单测。

### 门禁

typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / **binary smoke（必跑，模块环）** / Playwright e2e（Windows）/ CI Windows matrix；Codex 设计门（本文档）+ 实现门（每 PR）。

### 平台标注约定

Windows-only 测试用 `describe.skip`（POSIX CI 跳过）+ CI Windows matrix 跑；真实 opencode/WSL 的集成测试标 `@requiresWsl`，无 WSL 环境跳过而非红。
