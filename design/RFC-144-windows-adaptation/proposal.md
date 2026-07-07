# RFC-144 — 全功能 Windows 适配（Windows adaptation）

状态：Draft（待用户批准 → 进入实现）
触发：用户 2026-07-07「将这个工程的所有功能都适配 windows」。现 README Requirements 明写「OS: macOS or Linux / Windows is not supported in v1」；用户拍板走推荐策略 C（daemon 原生 Windows + opencode 经可插拔 runtime driver 走 WSL）+ 5 PR 拆分，全部同意。

---

## 1. 背景

平台的核心能力是 spawn `opencode run` 子进程。整个 daemon、git worktree 任务、review/clarify、记忆、ACL、结构化 diff 都是围绕这个能力搭的。但：

1. **opencode 本身对 Windows 的支持是实验性的、官方推荐 WSL**（[sst/opencode](https://github.com/sst/opencode)）——这是唯一一个**不能靠改本仓代码解决**的外部约束。
2. 即便 opencode 能在 Windows 跑，daemon 自身还有一批 POSIX-only 假设散落在 `util/` 与 `services/`：进程组 group-kill、`SIGTERM`/`SIGKILL` 升级、`ps -p <pid> -o command=` 指纹、external skill symlink、`file://` 字符串拼接、`tar` 备份、`chmod 600` 敏感文件隔离。这些在 Windows 上要么静默失效（chmod=安全回归），要么直接报错（`ps` 找不到、负 pid kill 无效）。

取证（2026-07-07 快照，file:line 见 design §2）确认：单实例 PID-file 锁（`util/lock.ts`）已跨平台；全后端 spawn 均用 argv 数组、无 `sh -c`——这两点是干净地基。其余 13 类 blocker 需要逐层适配。

## 2. 目标 / 非目标

### 目标

- **在 Windows 10/11 + Windows Server 2022 上原生运行 daemon**，覆盖现有全部功能面：agent/skill/MCP/plugin、工作流编辑、git worktree 任务、review/clarify、长期记忆、多用户 ACL、结构化 diff。
- **单二进制 `agent-workflow-windows-x64.exe`** 走 GitHub Releases 分发，CI 矩阵加 `windows-latest`。
- **与 POSIX 共用一套源码**：平台分支收敛到 `util/platform.ts` + `wsl-opencode` driver，业务层（runner/scheduler/routes）零 `if (process.platform === 'win32')` 散落。
- **opencode 外部约束封装在 driver 边界内**：借 RFC-143 能力对象收口的「注册即扩展」，Windows 上注册 `wsl-opencode` driver，业务层零改动。
- **安全模型等价闭合**：symlink/ACL 攻击面、敏感文件隔离在 Windows 上不得降级。

### 非目标

- **不改 opencode 上游**：它是外部 CLI，行为以源码为准（CLAUDE.md 强制）。
- **不实现 opencode 的原生 Windows 移植**：策略 C 明确把 opencode 经 WSL 运行；若未来 opencode 原生支持 Windows，driver 注册表加一个 `native-windows-opencode` driver 即可，不在本 RFC 范围。
- **不强制 WSL-only 部署**：daemon 自身原生 Windows，仅 opencode 子进程经 WSL。
- **不支持 Windows Server Core 精简版 / 容器化**：v1 不覆盖。
- **不降级安全**：`chmod 600` 在 Windows 是 no-op，必须用 ACL 等价替代，不留「测试在 Windows 跑绿了但文件实际全可读」的隐患。

## 3. 用户故事

- **作为 Windows 用户**：我想 `agent-workflow doctor` 在我的 Windows 机器上跑出全绿（含 WSL/opencode/git/long-path/ACL 检查），然后端到端跑通一次 Code→Audit→Fix 任务，而不是被一句「Windows not supported in v1」挡在门外。
- **作为运维**：我想 daemon 原生跑在 Windows 上（开机自启、单实例锁、HTTP/WS 服务），只在 spawn agent 子进程时透明地经 WSL 调用 opencode——业务工作流定义、git worktree、review/clarify 全部照常。
- **作为维护者**：我想让所有平台差异收口到 `util/platform.ts` + 一个 `wsl-opencode` driver，而不是在 runner/scheduler/routes 里 grep 出几十处 `if (windows)`——新增 POSIX 行为变化时一处改、两边对齐。
- **作为安全 review 者**：我想确认 `secret.key` / `token` 在 Windows 上用 ACL 真的只对当前用户可读，而不是 chmod 的 no-op 静默放过。

## 4. 验收标准

1. **Windows doctor 全绿**：`agent-workflow doctor` 在装了 WSL2+opencode+git+启用长路径的 Windows 机器上全绿，含 WSL 状态 / opencode 版本 / git / long-path / ACL 五项检查。
2. **端到端任务跑通**：Windows 上启动一个 Code→Audit→Fix 工作流任务（git wrapper + fan-out + review gate），全链路成功，任务详情/diff/review/clarify 各 tab 正常。
3. **杀树等价性**：opencode 子进程卡死时，Windows 的 Job Object 机制能收回全部子孙（等价 POSIX `kill(-pgid, SIGKILL)`）；新增回归测试。
4. **ACL 安全闭合**：`secret.key` / `token` 在 Windows 上用 `icacls` 实证仅当前用户可读（测试断言 ACL，不能只看文件能写）。
5. **POSIX 零行为变化**：`runtime-opencode-golden.test.ts` 及既有 kill/stop/lock/symlink/file:// 测试在 POSIX 上 byte-for-byte 绿；平台分支只在 `util/platform.ts` + driver 内。
6. **业务层零平台散落**：`rg -n "process\.platform\s*===\s*'win32'|require\('os'\)\.platform\(\)" packages/backend/src`（排除 `util/platform.ts` + `runtime/wsl-opencode/` + tests）零命中。
7. **单二进制构建**：`bun run build:binary` 在 `windows-latest` CI 上产出可运行的 `agent-workflow-windows-x64.exe`，smoke 通过。
8. **门禁全绿**：typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / binary smoke / Playwright e2e（Windows）/ CI Windows matrix。
9. **Codex 设计门 + 实现门**：设计门（本文档批准前）+ 实现门（每 PR 代码后）各跑一轮。

## 5. 相关 RFC / 挂钩

- **RFC-143**（runtime 能力对象收口）：**强依赖**。本 RFC 的 `wsl-opencode` driver 是 RFC-143 收口后「注册即扩展」的第一个真实用例；PR-3 必须在 RFC-143 落地后开工。
- **RFC-111**（runtime 抽象引入）：driver seam 的起源；`wsl-opencode` 复用其 spawn/parseEvent 模型。
- **RFC-067**（per-task git identity）、**RFC-099**（资源 ACL）、**RFC-029**（inventory 插件）：这些能力经 driver 透传到 WSL 内 opencode，本 RFC 保证其行为等价。
- **flag-audit §4.1**：RFC-143 收口的 driver 注册表是本 RFC 的接合点——Windows 适配不另起一套旁路，而是顺着收口后的单一注册表扩展。
