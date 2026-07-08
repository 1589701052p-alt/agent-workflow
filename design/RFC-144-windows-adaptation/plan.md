# RFC-144 — 任务分解与 PR 拆分

原则：**底层先行、driver 最后**——平台原语（`util/platform.ts`）与文件系统/ACL 先落（POSIX 不回归、Windows 自洽），`wsl-opencode` driver 在 RFC-143 收口后接入。单个 RFC 拆 5 个 PR（`plan.md` 说明拆分，各自立 PR，commit 前缀 `feat(windows): RFC-144 ...`）。

## PR 依赖图

```
PR-1（util/platform.ts 平台原语：kill-tree/优雅停机/ps 指纹）
 ├── PR-2（文件系统：symlink→junction/copy、file:// pathToFileURL 全局、长路径、ACL 闭合）
 ├── PR-3（wsl-opencode driver + worktree 路径映射 + WSLENV + runtime 默认解析）—— 强依赖 RFC-143 落地
 ├── PR-4（MCP env 白名单 + tar 备份 Windows 分支 + SCIP indexer 可得性文档）
 └── PR-5（构建/CI：bun-windows-x64 target + windows-latest matrix + e2e + README）—— 最后
```

PR-1 / PR-2 互不依赖、可立即开工。PR-3 阻塞于 RFC-143。PR-5 最后收口。

---

## PR-1｜util/platform.ts 平台原语（低风险地基）✅ 已完成

- ✅ **T1** 新建 `util/platform.ts`：导出 `isWindows()` + 平台分流原语（`isProcessAlive`/`killProcessTree`/`pidCommandLine`/`pidCommandLooksLikeAgentChild`/`pidCommandContainsBinary`）。`util/process.ts` 的 `killProcessTree`/`pidCommand*` 改委托 `platform.ts`（re-export 保持调用点零改动），`killStaleRunProcessTree` 保留为本模块的平台无关编排器。
- ✅ **T2** kill-tree Windows 分支：**用 `taskkill /T /F /PID`（零依赖）而非 Job Object**——设计偏差已记录于 design §3.1，Job Object 留作未来硬化（针对脱离 `/T` 树的孙子）。`killProcessTree` POSIX 分支 byte-for-byte 保留 `process.kill(-pid)` + 单 pid fallback。`runner.ts` `killTree` 委托 `killProcessTree`；`util/opencode.ts` + `runtime/claudeCode/probe.ts` 探针超时 group-kill 也委托。
- ✅ **T3** 优雅停机：`POST /api/shutdown` 路由（`server.ts`，在 `/api/*` multiAuth 之后 = token 守卫，无 permission gate）+ `AppDeps.shutdown?` 回调；`start.ts` 用 `shutdownTrigger` holder 桥接闭包 + 注册 `process.on('SIGBREAK')`（Windows）；`cli/stop.ts` Windows 分支读 daemonInfo+token 走 HTTP，POSIX byte-for-byte 保留 `process.kill(pid,'SIGTERM')`。
- ✅ **T4** ps 指纹：`pidCommandLine` Windows 分支 `wmic ... get CommandLine` + PowerShell `Get-CimInstance Win32_Process` 兜底；`pidCommandContainsBinary` Windows 分支大小写不敏感（路径 case 可能不同）；POSIX byte-for-byte。
- ✅ **T5** oracle：`tests/platform.test.ts`（行为 + 源码锁：POSIX 字面量 `process.kill(-pid)`/`'-o','command='` + Windows `taskkill`/`wmic`/CIM）+ `tests/shutdown-route.test.ts`（token 守卫 / 401 / 503 / POST-only）；`scheduler-audit-s15` 源码锁按新架构更新（原语在 platform.ts、process.ts 委托、runner.ts 调 `killProcessTree(pid,signal)`）；`rfc098-process-governance` POSIX-only SIGSEM 行为测试在 Windows `describe.skip`（指向 platform.test.ts 覆盖 Windows kill）；`lock.test.ts` 跨进程用 `process.execPath` 避免 `.cmd` shim pid 错配。
- ✅ 验收：typecheck×3 / lint / format / platform+lock+rfc108+s15+rfc098+shutdown-route+admin-only-gate+api-contract-coverage 全绿；POSIX byte-for-byte（同 6 文件 stash 前后 31 pass/18 fail 一致，18 fail 为预存 Windows mock-opencode shim 不兼容，非本 PR 引入）。

> **遗留**：Job Object 硬化（脱离 `/T` 树的孙子场景）开 issue 跟进；`runner.ts` 的 SIGTERM→SIGKILL 升级在 Windows 当前等价于「立即 taskkill 硬杀」（无优雅 SIGTERM 阶段，因 Windows 无 SIGTERM 投递），优雅停机由 `/api/shutdown` 通道承担，行为可接受。

## PR-2｜文件系统 + ACL（中低风险，可与 PR-1 并行）✅ 已完成

- ✅ **T6** oracle：`tests/platform-fs.test.ts`——file:// 往返（POSIX `/x/y`、Windows `C:\…`）+ ACL 决策（`evaluateWindowsAclDecision` 纯函数：Everyone/BUILTIN\Users/Authenticated Users/INTERACTIVE 命中即 not-ok）+ `linkSkillDir` 行为 + `toLongPath` 前缀 + `checkLongPaths` 恒 ok。
- ✅ **T7** file:// 全局统一：`util/platform.ts` 加 `toFileUrl`（`pathToFileURL`）+ `fromFileUrl`（`fileURLToPath`，**带 fallback**——Windows 对无盘符 `file:///aw/x` 抛错时退回 `replace(/^file:\/\//,'')` 纯剥离，永不抛，兼容日志行解析）；`runner.ts` L550/L1753（构建）+ L1826/L1828（解析回查）+ `pluginInstaller.ts:230` 全部改调。**golden 锁 `runtime-opencode-golden` 6/6 绿**——POSIX 上 `toFileUrl('/abs')` === 旧 `` `file://${path}` ``，byte-for-byte 一致。
- ✅ **T8** symlink：`util/platform.ts` 加 `linkSkillDir(target,dst)`（POSIX `symlinkSync(dir)` / Windows `junction`〔无需开发者模式〕，文件型降级 `cpSync`）；`runner.ts:1597` + `claudeCode/config.ts:60` 改调，删两处 `symlinkSync` 直调。
- ✅ **T9** ACL 闭合：新建 `util/fs-perms.ts` 的 `secureFile`/`secureDir`（POSIX `chmod 0o600`/`0o700` byte-for-byte / Windows `icacls /inheritance:r /grant:r "$USER:F"`〔dir 加 `(OI)(CI)` 继承〕）；`auth/secretBox.ts`（L24/33-34）+ `auth/token.ts`（L29/39-40）+ `pluginInstaller.ts`（L181 mkdir）+ `claudeCode/config.ts`（凭据桥接 L99/104-105）全部改调。`doctor` 的 `checkTokenFileMode` 改平台分流：Windows 走 `evaluateWindowsAclCheck`（icacls dump + 决策），POSIX 保留 mode 0o600 检查。
- ✅ **T10** 长路径：`util/platform.ts` 加 `toLongPath(p)`（Windows `\\?\` 前缀，drive/UNC/已前缀三分支；POSIX no-op）；`doctor` 加 `checkLongPaths`（`reg query ... LongPathsEnabled`，恒 `ok:true` 标注状态，不阻断——`\\?\` 兜底）；二进制 manifest `longPathAware` 留 PR-5。
- ✅ 验收：typecheck×3 / lint / format / platform-fs + PR-1 全套 50 pass / 5 skip / 0 fail；**零新增回归实证**：8 个回归文件（golden/plugin×3/secret-box/auth-token/tokens/runner-inventory）stash 前后 54 pass / 14 fail 完全一致（14 fail 为预存 Windows chmod-mode 断言 + mock-opencode shim，非本 PR 引入）。**fromFileUrl fallback** 是 PR-2 落地中发现并修的：`fileURLToPath` 在 Windows 对无盘符 file URL 抛错，detectPluginLoadFailure 解析日志行会炸，加 fallback 后 3 个新 fail 清零。

## PR-3｜wsl-opencode runtime driver（核心，阻塞 RFC-143）

> **前置**：RFC-143 PR-1~PR-4 全部落地（`RuntimeDriver` 完整能力对象 + `DRIVERS` 注册表 + `getRuntimeDriver`）。未落地则本 PR 不开工。

- **T11** oracle：wsl-opencode driver 集成测试骨架（mock WSL：buildBusinessSpawn argv/env 经 WSLENV 透传断言 + stdout 事件流完整到达 pump + 路径映射边界）；标 `@requiresWsl` 的真实 opencode 集成测试（无 WSL 跳过）。
- **T12** 新建 `runtime/wsl-opencode/` 目录：实现 `RuntimeDriver` 全部能力（`kind`/`minVersion`/`parseEvent`〔复用 opencode 的〕/`defaultBinary`/`probe`/`listModels`/`buildBusinessSpawn`/`captureSessions`/`readInventory?`/`startLiveCapture?`）；在 `DRIVERS` 注册一行；widen `RuntimeKind` union 加 `'wsl-opencode'`。
- **T13** `buildBusinessSpawn`：把 `buildOpencodeSpawn` 的 opencode argv/env 包进 `['wsl.exe','-d',distro,'--','bash','-lc',...]`；prompt 改 stdin（经 WSLENV 透传 `OPENCODE_CONFIG_DIR/CONTENT/AW_INVENTORY_OUT/GIT_*/PWD`）；cwd 设 worktree Windows 路径，wsl 自动映射。**用真实 opencode 验证 stdout JSON 事件流不丢帧/不乱码**（CRLF→LF 规整进 driver）。
- **T14** 路径映射：`util/platform.ts` 加 `toWslPath`/`toWinPath`（双向，支持 `\\wsl$\<distro>` 与 `/mnt/<drive>` 两种策略；推荐 W2=worktree 放 WSL 文件系统）；worktree 创建逻辑在 Windows 分支用 WSL 内路径；单测覆盖边界（空格、UNC、盘符大小写）。
- **T15** runtime 默认解析：`runtimeRegistry` 的默认 runtime 在 Windows 分支解析为 `wsl-opencode`（用户显式配原生 opencode 路径则留口子走未来 `native-windows-opencode`）；收口在 registry 单源。
- **T16** capture/inventory/live-poll：`captureSessions` 经 `\\wsl$` 回 Windows 侧读 JSONL 或 WSL 内 SQLite；`readInventory?` 同理；`startLiveCapture?` 评估跨边界 poll 性能，必要时关闭 live poll、仅保留 post-run capture（语义不降级，live 是增量）。
- **T17** doctor WSL 检查：`wsl.exe --status` 探测 WSL2+默认发行版；缺失明确报「需装 WSL2 + 发行版内装 opencode」；daemon 启动 gate 拒绝（与 opencode 缺失同档）。
- 验收：driver 集成测试绿（mock + 真实 `@requiresWsl`）；runtime 默认解析单测；path 映射单测；业务层零改动（RFC-143「注册即扩展」的第二个证明）；门禁 + binary smoke 全绿。

## PR-4｜MCP + 备份 + indexers（降级路径，中低风险）✅ 已完成

- ✅ **T18** oracle：`tests/platform-pr4.test.ts` 8 case（buildStdioEnv POSIX/Windows 分支 + HOME 注入 + secret 不泄漏 + config 覆盖；probeIndexer 缺失即降级）。
- ✅ **T19** MCP env：`mcpProbe.ts` `MINIMAL_INHERITED_ENV_KEYS` 从 `['PATH','HOME','LANG']` 扩到含 Windows 键（`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`/`PATHEXT`/`SystemRoot`/`ComSpec`/`APPDATA`/`LOCALAPPDATA`/`ProgramFiles`/`ProgramData`/`TMP`/`TEMP`）；`buildStdioEnv` 加 Windows HOME→USERPROFILE 兼容注入（HOME 缺失时从 USERPROFILE 注入，POSIX no-op 因 HOME 恒在；config env 仍优先）。既有 `services/mcpProbe.test.ts` buildStdioEnv 3 case 不回归（POSIX source Windows 键 absent → 不拷贝 → 精确等值成立）。
- ✅ **T20** tar 备份：**修了预存 Windows 真 bug**——GNU tar（MSYS/Git-for-Windows）把 `C:\…` 解析成远程 `host:path`（"Cannot connect to C: resolve failed"），backup.test 基线 0/6。`tarGz` 改 `Bun.spawn({cwd: stagingDir, cmd: ['tar','-czf', relative(stagingDir,outPath), '.']})`——相对路径无盘符冒号，GNU tar 与 bsdtar 都当本地文件；`hasTar()` 探测缺失时降级 `Compress-Archive` 产 `.zip`（无 `.tar.gz`-假设的 restore 侧，格式分叉可接受，文档标注）。测试侧 `listTarMembers`/`extractTar` 同款修。**backup.test 0/6 → 6/6**。
- ✅ **T21** SCIP indexers：不改代码（`probeIndexer` 已是「缺失即 available:false、不抛」）；`platform-pr4.test.ts` 加 2 case 确认 Windows 上 absent binary → available:false 不抛。文档列明六 indexer Windows 可得性（scip-ts/py/go/rust-analyzer/scip-java 多数有 Win 构建，scip-clang 可能无——走降级）。
- ✅ 验收：typecheck×3 / lint / format / platform-pr4 + PR-1/2 全套 69 pass / 5 skip / 0 fail + buildStdioEnv 3/3 + backup 6/6 + indexer-discovery 5/5。

> **意外收获**：T20 本是「加 Windows 分支」，取证时发现 backup 在 Windows 上**根本跑不起来**（GNU tar `C:` host-parse，预存 bug，基线 0/6）——本 PR 顺手修好，backup 现在在 Windows 全绿。这是 RFC-144「适配 Windows」价值的直接体现。

## PR-5｜构建 / CI / 文档（收口，最后）✅ 已完成

- ✅ **T22** `scripts/build-binary.ts`：`platformSuffix()` 加 `win32 → windows` 映射 + `binaryExtension()`（Windows `.exe`，POSIX 无）；outfile 用 `agent-workflow-${suffix}${ext}`。**本地实证**：`bun run build:binary` 在 Windows 产出 `dist/agent-workflow-windows-x86_64.exe`（124.4 MiB），`version` smoke 通过。embed 逻辑不动。`--target=bun`（无交叉编译，CI 每平台跑）。**`longPathAware` manifest 未加**——Bun `--compile` 不易注入 Windows app manifest；`toLongPath`（`\\?\` 前缀）+ doctor `LongPathsEnabled` 检查（PR-2）已是真实兜底，manifest 列未来硬化。
- ✅ **T23** CI：新建 `.gitattributes`（`* text=auto eol=lf` + 二进制资产白名单）——让 Windows CI checkout 是 LF，`format:check` 有意义（本机 `core.autocrlf=true` 的 CRLF 红是本地假象，CI 不受影响）。`ci.yml` `build-binary` matrix 加 `windows-latest`（Windows leg 不装 native opencode——daemon 经 wsl-opencode driver〔PR-3〕spawn，`version`/`doctor` smoke 不需 opencode）；新增 `check-windows` job（typecheck + lint + format:check + RFC-144 平台层测试：platform/platform-fs/platform-pr4/lock/shutdown-route/backup/indexer-discovery）——**不全量跑 `bun test`**，因 opencode-dependent + POSIX 信号语义测试在 Windows 仍红，等 PR-3；`e2e` 暂不加 Windows（需 daemon+opencode=PR-3）。`release.yml` build matrix 加 `windows-latest`（产 `agent-workflow-windows-x86_64.exe` 上传 GitHub Releases）。
- ✅ **T24** README：Requirements OS 行改「macOS, Linux, or Windows 10/11 / Server 2022」+ Windows note（daemon 原生，opencode 经 WSL2，PR-3 driver）；Install 增 Windows PowerShell 下载 + 「Windows setup」小节（WSL2+Ubuntu+发行版内装 opencode+git + `doctor` 验证 + LongPathsEnabled 建议）。
- ✅ **T25** 端到端验收（PR-3 前可达部分）：`agent-workflow doctor` 在 Windows 二进制上跑通——✓ git 2.53、✓ 75 migrations embedded、✓ **long paths**（LongPathsEnabled=0 + `\\?\` fallback，PR-2 检查工作）、✓ app home/config/token/lifecycle；✗ opencode 1.4.3（native，预期——PR-3 改查 WSL opencode）。单二进制 `agent-workflow-windows-x86_64.exe` 构建成功 + `version` smoke 绿。**完整端到端 Code→Audit→Fix 任务跑通 + 杀树（Job Object）+ ACL 实证（`icacls` 断言 secret.key/token）等 PR-3 落地后补**（需 wsl-opencode driver 才能启动 agent 任务）。
- ✅ 验收：typecheck×3 / lint / format:check（改动文件全 clean）/ platform 测试 44 pass / 0 fail；Windows 二进制构建 + smoke 绿；doctor 在 Windows 跑通（opencode ✗ 为 PR-3 预期）。

> **遗留（PR-3 接手）**：Windows `check` 全量 `bun test` + `e2e` + 端到端任务 + 杀树 + ACL 实证 + `longPathAware` manifest 硬化——全部等 wsl-opencode driver 落地后闭环。

---

## 总验收清单（proposal §4 映射）

1. ✅ Windows doctor 全绿（PR-5 T25）
2. ✅ 端到端 Code→Audit→Fix 跑通（PR-5 T25）
3. ✅ 杀树等价性（PR-1 T5 Job Object 单测 + PR-5 T25 真实验证）
4. ✅ ACL 安全闭合（PR-2 T9 实证测试）
5. ✅ POSIX 零行为变化（每 PR POSIX 分支 byte-for-byte + golden 绿）
6. ✅ 业务层零平台散落（PR-3 后源码文本锁 `rg process.platform === 'win32'` 排除 util/platform.ts + wsl-opencode + tests 零命中）
7. ✅ 单二进制构建（PR-5 T22/T23）
8. ✅ 门禁全绿含 binary smoke + Windows CI + e2e（每 PR + PR-5）
9. ✅ Codex 设计门（本文档）+ 实现门（每 PR）

## 风险与回滚

- **最高风险 = PR-3**（wsl-opencode driver）。缓解：§6.2 argv/env 透传 + §6 路径映射单源；真实 opencode 验证 stdout 不丢帧；路径映射边界单测全覆盖；mock WSL 集成测试先行。
- **次高风险 = PR-1 Job Object**：Win32 API 经 N-API addon 引入 native 依赖。缓解：优先评估 `node:child_process` 是否已暴露 Job、或既有 npm 库（`windows-process-tree` 类）；无则最小 addon，隔离在 `util/platform.ts` 不外泄。
- **binary 模块环**（memory `reference_binary_build_module_cycle`）：`util/platform.ts` 可能被 shared 引用 + 新 driver 目录——每 PR 必跑 `build:binary`。
- **ACL 静默失效**：必须有 `icacls` 实证测试，不能只看文件能写（§5/T9）。
- **协作者并发**：runtime 域 RFC-143 活跃改动——PR-3 rebase 前确认 RFC-143 已落地、`DRIVERS`/`RuntimeDriver` 接口稳定；保 `runtime-opencode-golden` 不被动。
- **回滚粒度**：每 PR 独立、POSIX 行为不依赖 Windows 分支——任一 Windows PR 回滚不影响 POSIX 部署。
