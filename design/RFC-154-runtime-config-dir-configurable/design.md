# RFC-154 — 技术设计

## 1. 数据模型

`runtimes` 表（`packages/backend/src/db/schema.ts:100`）新增两列,紧随 `binaryPath` 的「NULL=协议默认」范式:

```ts
// RFC-154: 自定义 fork 可能改掉 config 目录的发现方式——env var 名 和/或
// 叶子目录名。两列均 NULL = 协议默认（opencode: OPENCODE_CONFIG_DIR/.opencode；
// claude-code: CLAUDE_CONFIG_DIR/.claude）。只覆盖 config 目录；agent 注入通道
// （OPENCODE_CONFIG_CONTENT / claude flags）不在本 RFC 范围（见 proposal 非目标）。
configDirEnv: text('config_dir_env'),   // NULL → 协议默认 env var 名
configDirName: text('config_dir_name'), // NULL → 协议默认叶子目录名
```

**迁移**:`ADD COLUMN` ×2（可空，无默认，存量行自然 NULL）。落地时取当前下一个空号（RFC-153 已占 `0078`,故预期 `0079`——若落地时序变化以实际空号为准）。手写迁移每条 `ADD COLUMN` 之间加 `--> statement-breakpoint`（[[reference_migration_statement_breakpoint]]）。journal 计数锁 `upgrade-rolling.test.ts` 同步 +1（[[reference_migration_bumps_journal_count_test]]）。

## 2. 协议默认与解析单源

新增 shared 常量,作为「协议 → 默认 config 目录 profile」的唯一事实源:

```ts
// packages/shared/src/runtime.ts（或既有 runtime 常量文件）
export interface RuntimeConfigDirProfile {
  env: string   // 要设置的环境变量名
  name: string  // runRoot 下的叶子目录名
}
export const DEFAULT_CONFIG_DIR_PROFILE: Record<RuntimeKind, RuntimeConfigDirProfile> = {
  opencode: { env: 'OPENCODE_CONFIG_DIR', name: '.opencode' },
  'claude-code': { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
}
```

解析:`resolveAgentRuntime`（`services/runtimeRegistry.ts:183`）在返回的 `ResolvedRuntime` 里带上已解析的 config 目录:

```ts
// 行内非空则用，否则回落协议默认
const dft = DEFAULT_CONFIG_DIR_PROFILE[protocol]
configDir: {
  env:  nonEmpty(row.configDirEnv)  ?? dft.env,
  name: nonEmpty(row.configDirName) ?? dft.name,
}
```

### 2.1 configDir 是「节点运行（根 agent）」属性，NOT per-agent（Codex P1 修正）
一个 node run 只有一个 config 目录——闭包里的 dependents 与根 agent **共用同一个 opencode/claude 进程的 config dir**（它们不各自起进程）。因此 `configDir` **不放进** per-agent 的 `RuntimeProfile`（`runner.ts:476` 对每个 dependent 单独 `resolveAgentRuntime`——若放进去会解析出一堆用不到的、且可能不一致的 dependent config dir）。它属于根节点运行的冻结 runtime。

### 2.2 冻结路径必须显式带上 configDir（Codex P1——否则 resume/retry 丢失）
现有冻结载体 `node_runs.runtime_params_json` 的读回 `parseFrozenParams`（`nodeRunMint.ts:271-287`）是**白名单**,只认 `model/variant/temperature/steps/maxSteps`。若只把字段加进类型不改冻结读回,resume/retry/`frozenRuntimeOfSession` 会把 configDir 丢掉——claude 尤其致命:session transcript 落在**旧** config 目录,resume 换目录后找不到会话。

改造点(全部在 `nodeRunMint.ts`):
- `FrozenRuntime`（:261）增 `configDir: RuntimeConfigDirProfile`,作为 `params` 的**兄弟字段**（不塞进 `params`）。
- 冻结**写入**:`resolveFrozenRuntime`（:358-365）首帧 freeze 时,把解析出的 configDir 一并序列化——折进 `runtime_params_json` 的命名键（如 `{ ...params, __configDir: {env,name} }`）以避免给 `node_runs` 再加列（实现时二选一,倾向折 JSON）。
- 冻结**读回**:`parseFrozenParams` 拆出 `params`,`resolveFrozenRuntime` / `frozenRuntimeOfSession`（:298-398）额外解出 `configDir`（缺失/legacy NULL → 按 `row.runtime` 协议默认,保证旧行 byte 等价）。
- **继承路径**（:344-357 `inheritFrom`）：resume 一个 captured session 的新 retry 行,连 configDir 一起从 session-owner 继承——与 `{protocol,binary,params}` 同批,session id 与 config 目录成对消费（D11 延伸）。
- 首帧解析映射（:350-356）补 `configDir: r.configDir`。

**测试**:首次冻结后编辑该 runtime 行的 `config_dir_*` → 同 session resume/retry 仍用**旧** env/name（锁死冻结不被 mutable 行覆盖）。

**线程点写实（2026-07-08 复核 HEAD）**:scheduler 有 **5 个 dispatch 站点**把 `frozen.params` 传成 `runtimeParams`（`scheduler.ts:1099`/`1902`/`2890`/`4407`/`4783`——主 dispatch、两处 clarify-rerun、fanout shard、aggregator）,全部同步加传 `runtimeConfigDir: frozen.configDir` → `RunNodeOptions.runtimeConfigDir?`（optional,缺省 → 按 `opts.runtime` 协议默认,既有直构 RunNodeOptions 的测试零改动）→ `BusinessNodeSpawnContext.configDir`。

### 2.3 系统 agent / smoke / probe 明确出范围（Codex P2——避免破 golden）
`buildSpawn`（系统 agent:distiller/commit）当前把 `OPENCODE_CONFIG_DIR` 设为 `attemptDir` 本身、**不 append `.opencode` leaf**（golden `runtime-buildspawn.test.ts:56` = `/tmp/run`,非 `/tmp/run/.opencode`）;smoke（`runtimeSmoke.ts`）、probe（`routes/runtimes.ts`）同样只喂 `protocol/binaryPath/model`。

本 RFC **只覆盖业务节点 spawn（`buildBusinessSpawn`）**——那才是注入 framework skills、面向用户自定义 fork 的路径。系统 agent / smoke / probe **保持协议默认 config 目录不变**,goldens 逐字不动。
- 理由:系统 agent 不注入业务 skill;它们的 config 目录只是自身 inline config/transcript 的落点,与「让 fork 收到注入的 skill」无关。
- **已知局限（文档化）**:runtime 编辑页的「Test binary」probe 用协议默认 config 目录探测;若 fork 改了 env 名,probe 不会用自定义名(probe 本就是 advisory,schema 注释已声明 conformance advisory)——不阻断保存。留待后续按需扩展。

## 3. 校验（与 `validateBinaryPath` 并列，runtimeRegistry.ts:268 旁）

两个纯函数,`createRuntime` / `updateRuntime` 入口调用,非法抛 `ValidationError`:

```ts
export function validateConfigDirName(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = v.trim()
  if (s.length === 0) return null            // 空 → 协议默认
  // 必须是单层叶子名：无路径分隔符、无 . / .. 、非绝对路径、无 NUL
  // （'.' → join(runRoot,'.') = runRoot 本身，会把 skills/projects/credentials/
  //   system.md 混进 run root 顶层，削弱隔离——Codex P3，一并拒）
  if (
    s.includes('/') || s.includes('\\') || s === '.' || s === '..' || s.includes('\0')
  )
    throw new ValidationError('runtime-config-dir-name-invalid', 'config_dir_name 必须是单层目录名')
  return s
}

// Codex P1：平台在 spawn 里自己固定写的 env key——config_dir_env 撞上其中任何一个，
// 都会让本 RFC 明确「不配置」的 agent-注入通道 / 平台机制与 config-dir 通道互相覆盖，
// 必有一方丢失。opencode/claude 各写一组，取并集拒绝。
const RESERVED_SPAWN_ENV = new Set([
  'PWD',
  'OPENCODE_CONFIG_CONTENT',   // agent 定义通道（非目标）——撞了 agent 或 config dir 必丢一
  'OPENCODE_AW_INVENTORY_OUT', // inventory 插件契约
  'IS_SANDBOX',                // root 守卫
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  // 另一协议的 config-dir 默认名不必拒（同协议填自己默认名 = 无害幂等）
])

export function validateConfigDirEnv(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = v.trim()
  if (s.length === 0) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    throw new ValidationError('runtime-config-dir-env-invalid', 'config_dir_env 必须是合法环境变量名')
  if (RESERVED_SPAWN_ENV.has(s))
    throw new ValidationError('runtime-config-dir-env-reserved', `config_dir_env 不能是平台保留变量 ${s}`)
  return s
}
```

理由:`config_dir_name` 会与 `runRoot` 做 `join` 后 `mkdirSync`——路径穿越（含 `.`/`..`）会写到 runRoot 之外或塌回 runRoot,必须挡。`config_dir_env` 会作为 env 的 key,非法名会污染子进程环境;撞平台保留 key 会让 config-dir 与 agent 注入通道互相覆盖(Codex P1)。

## 4. 注入链路改造

> 范围提醒:以下参数化**只作用于业务节点 spawn（`buildBusinessSpawn`）**。系统 agent `buildSpawn`、smoke、probe 保持协议默认(§2.3),对应 golden 逐字不动。

### 4.1 opencode
- `opencode/driver.ts:176`:`runDir: join(ctx.runRoot, ctx.configDir.name)`（叶子来自 profile，取代字面量 `.opencode`）。
- `opencode/spawn.ts:79`:env 由 `{ OPENCODE_CONFIG_DIR: ctx.runDir }` 改为 `{ [ctx.configDirEnv]: ctx.runDir }`（key 参数化）。`OpencodeEnvContext` 增 `configDirEnv: string`。
- inventory 输出路径 `OPENCODE_AW_INVENTORY_OUT`（spawn.ts:86）不变（非目标）。

### 4.2 claude-code
- `claudeCode/spawn.ts:74`:`configDir = join(ctx.attemptDir, ctx.configDirName)`。
- `claudeCode/spawn.ts:118`:`{ [ctx.configDirEnv]: configDir }`。`ClaudeSpawnContext` 增 `configDirEnv` + `configDirName`。
- `claudeCode/driver.ts:65`（captureSessions）:`configDir: join(ctx.runRoot, ctx.configDir.name)`。
- `claudeCode/sessionCapture.ts`:主候选 `<configDir>/projects/<slug>` 用传入的 configDir（已随叶子名变）;**homedir 兜底候选 `~/.claude/projects`（sessionCapture.ts:42）保持不变**——那是 vanilla claude 的真实默认位置,是 claude 忽略 relocate 时的 belt-and-suspenders,与我们注入的叶子名无关。
- 凭据桥 `.credentials.json`、keychain item 名不变(非目标)。

### 4.3 skill 注入统一（顺带修冗余）
现状:`runner.ts:464` 无条件 `prepareSkills(runDir=<runRoot>/.opencode, ...)`;claude 另有 `prepareClaudeConfigDir` 内的近似循环。两处是近似重复。

改造:
1. 抽 shared helper `stageSkills(configDir, skills, log)`（managed→`cpSync` / external→`symlinkSync` / project→跳过 + missing sourcePath warn），放在一个无 runner 依赖的叶子模块（避免模块环，[[reference_binary_build_module_cycle]]）。runner 的 `prepareSkills` 与 `claudeCode/config.ts` 的 skill 循环都改为委托它。
   - **无条件建目录（Codex P2）**:`stageSkills` 必须 `mkdirSync(join(configDir,'skills'), {recursive:true})` **不论 skills 是否为空**。现状 `prepareSkills(<dir>/.opencode, [])` 即便空列表也建出 config dir——这是 opencode 启动前 config dir 存在的**保证**（opencode 1.17+ 会往里写 `.gitignore`，`runtime-smoke.test.ts:83-90` 有回归背景）。移走 runner 无条件调用后,若改成「有 skill 才建目录」会让空 skill 的 run 缺 config dir → opencode 启动异常。
2. **删除 runner 序章里无条件的 `prepareSkills` 调用**;改为各 driver 在自己的 spawn 路径里,用**自己解析出的 config 目录**注入 skills:
   - opencode driver:在 `buildBusinessSpawn` 里对 `join(runRoot, configDir.name)/skills` 调 `stageSkills`（把原本 runner 代劳的动作收进 driver，与 RFC-143「能力对象收口」方向一致）。
   - claude driver:`prepareClaudeConfigDir` 已在做,仅把叶子名参数化。
3. 结果:claude run 不再冒出 `.opencode`;opencode/claude 各自只注入到自己实际读取的目录;两份循环收敛成一份。

### 4.4 数据流总览（改造后）
```
dispatch: resolveAgentRuntime → RuntimeProfile{ …, configDir:{env,name} } 冻结
runNode: 解出 configDir profile，线程进 ctx
 ├─ opencode driver.buildBusinessSpawn:
 │    runDir = join(runRoot, configDir.name)
 │    stageSkills(runDir/skills, skills)
 │    env[configDir.env] = runDir     // 不再硬编码 OPENCODE_CONFIG_DIR
 └─ claude  driver.buildBusinessSpawn:
      configDir = join(runRoot, configDir.name)
      prepareClaudeConfigDir(configDir, skills)  // 内部 stageSkills + 凭据桥
      env[configDir.env] = configDir   // 不再硬编码 CLAUDE_CONFIG_DIR
```

## 5. 前端

runtime 新建/编辑表单（`RuntimeList.tsx` 关联的 Dialog）新增两个可选字段,严格复用公共原语（禁止原生元素，见 CLAUDE.md 前端一致性铁律）:

- `<Field label={t('runtime.configDirEnv')} hint={t('runtime.configDirEnv.hint')}>` + `<TextInput>`（placeholder 显示协议默认值,如 `OPENCODE_CONFIG_DIR`）。
- `<Field label={t('runtime.configDirName')} hint>` + `<TextInput>`（placeholder `.opencode` / `.claude`，随所选 protocol 变）。
- 两字段归入表单既有的「高级」区块（若无则平铺于二进制路径下方，保持与 binaryPath 同一视觉层级）。
- i18n:`en-US.ts` / `zh-CN.ts` 各加 4 个 key（label×2 + hint×2）。
- 空字符串提交按「未配置」处理（前端 trim 后为空则不发送 / 发送 null）。

## 6. 失败模式

| 场景 | 行为 |
|---|---|
| 两列 NULL（存量/未配置） | 协议默认,spawn 字节等价（golden 锁） |
| `config_dir_name='../x'` / 含 `/` / `'.'` / `'..'` | 保存被 `validateConfigDirName` 拒（表单 + 服务端双挡） |
| `config_dir_env='9BAD'` / 空格名 | 保存被 `validateConfigDirEnv` 拒 |
| `config_dir_env='OPENCODE_CONFIG_CONTENT'`（或 PWD/IS_SANDBOX/git identity 等保留 key） | 保存被 `RESERVED_SPAWN_ENV` 拒（Codex P1，防 config-dir 与 agent 通道互相覆盖） |
| 首帧冻结后编辑 runtime 的 config_dir_* | resume/retry 用**冻结的旧值**（§2.2），不跟随 mutable 行 |
| 空 skills 列表 | `stageSkills` 仍建 `<configDir>/skills`（§4.3 Codex P2），opencode 启动前目录就位 |
| fork 也改了 `OPENCODE_CONFIG_CONTENT` | **本 RFC 不覆盖**:skills 进对目录,但 agent 注入仍失效（proposal 已知局限） |
| 自定义 env 名与某**非保留**继承环境变量同名 | 我们的值后写,覆盖继承值（与今天 `OPENCODE_CONFIG_DIR` 行为一致，无新风险） |
| 系统 agent / smoke / probe | 协议默认 config 目录不变（§2.3）;「Test binary」不探测自定义 env（advisory 局限，文档化） |
| claude sessionCapture 主候选目录随叶子名变、homedir 兜底不变 | transcript 主候选跟随;兜底保底 |

## 7. 与 RFC-153 的耦合（重要）

RFC-153（Draft，同日）正在:删 `runtimes.builtin` 列（migration `0078`）、改 `createRuntime` / `seedBuiltinRuntimes` / `assertConfigDefaultsMigrated`。本 RFC 也动 `runtimes` 表 schema + `createRuntime`（加两列的读写）+ seed（内置 runtime 的两列留 NULL 即默认，无需显式 seed 值）。

**现状（2026-07-08 二次复核 HEAD 确认）**:RFC-153 **已提交**（`6ca15c0e`）——`runtimes.builtin` 已删、`seedBuiltinRuntimes` 已改空表种子、migration `0078` 已入 journal（head=0078）。**本 RFC 迁移号定为 `0079`**。耦合风险解除,无语义冲突。

另:当前工作树里有他人 RFC-146 PR-2 的未提交改动（canvas/validator 一批）——本 RFC 提交时**按路径精确 `git add`、单步 `git commit -- <paths>`**（[[feedback_dont_delete_others_code_for_ci]] / [[feedback_shared_index_commit_race]]）,不碰他人文件。

## 8. 测试策略（§测试策略——PR 必跑绿）

**纯函数 / 数据预言（首选可断言面）**
- `validateConfigDirName`:接受 `.foo`/`null`/空→null;拒 `../x`、`a/b`、`/abs`、`.`、`..`、含 NUL。正/边界/错误全覆盖。
- `validateConfigDirEnv`:接受 `FOO_DIR`/`_x`/null;拒空格名、`9X`、含 `=`;**拒保留 key**(`OPENCODE_CONFIG_CONTENT`/`PWD`/`OPENCODE_AW_INVENTORY_OUT`/`IS_SANDBOX`/`GIT_AUTHOR_NAME` 等)。
- 协议默认解析:两列 NULL 时 `resolveAgentRuntime` 返回 `{env:'OPENCODE_CONFIG_DIR',name:'.opencode'}`（opencode）/ claude 对应值;非空时返回行值。

**冻结存活（Codex P1）**
- 首帧 `resolveFrozenRuntime` 冻结自定义 `{env,name}` → 编辑 runtime 行改成别的值 → 同 nodeRunId resume/`frozenRuntimeOfSession` 读回仍是**冻结的旧** `{env,name}`。
- legacy `runtime_params_json`（无 configDir 键）读回 → 按 `row.runtime` 协议默认(向后兼容)。

**spawn golden（byte-for-byte）**
- opencode 业务:两列 NULL → env 含 `OPENCODE_CONFIG_DIR=<runRoot>/.opencode`，与现有 golden 逐字一致;自定义 `configDirEnv=FOO_DIR`/`configDirName=.foo` → env 含 `FOO_DIR=<runRoot>/.foo` 且**不含** `OPENCODE_CONFIG_DIR`。
- claude 业务:同构（`CLAUDE_CONFIG_DIR` ↔ 自定义）。
- **系统 agent / smoke golden 不变**:`buildSpawn` 仍 `OPENCODE_CONFIG_DIR=<attemptDir>`（无 leaf），`runtime-buildspawn.test.ts` / `runtime-smoke.test.ts` 零改动为证(§2.3)。

**skill 落点 + 冗余回归**
- 给一个 managed + 一个 external skill,opencode run 后断言落在 `<runRoot>/<name>/skills/<skill>`;claude run 后断言落在 claude 的 config 目录;**断言 claude run 后 `<runRoot>/.opencode` 不存在**（冗余修复回归锁,test 顶注明锁的是本 RFC 的 claude-no-.opencode 修复）。
- **空 skills 仍建目录（Codex P2）**:skills=[] 时 `stageSkills` / business spawn 后 `<configDir>/skills` 仍存在（锁死移走 runner 无条件调用不回归 opencode 启动前置目录）。

**迁移**
- `upgrade-rolling.test.ts` journal 计数 +1（title + 断言 + 注释同步）。
- rolling 迁移后 `runtimes` 有两新列且存量行 NULL。

**前端**
- runtime 表单渲染出两字段（`getByRole`/label 查询），protocol 切换时 placeholder 默认值变;提交空值→payload 为 null / 缺省;非法值→表单挡。vitest（前端不在 CI 的 `bun test` 范围,[[reference_ci_test_scope]]）。

**源码守卫**
- 断言 `OPENCODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` / `.opencode` / `.claude` 的字面量只出现在 `DEFAULT_CONFIG_DIR_PROFILE` 单源处 + sessionCapture 的 homedir 兜底（白名单），不再散落在 spawn/driver（防 re-fork）。

**复核固化的安全事实（实现时勿误改）**
- `inventory.json` 与其插件物化在 **`runRoot` 直下**（`opencode/driver.ts:127-133`），claude 的 `system.md` 同在 attemptDir 直下——**均不在 config 叶子目录里**,叶子改名不影响 inventory read-back / system-prompt-file。
- `runDir` 在 `runner.ts` 仅 2 处使用（`:454` 定义 + `:464` prepareSkills）——删序章后无残留消费方。
- `runtime_params_json` 全仓唯一消费方是 `nodeRunMint.ts`（写 `:363`、读 `:329/:394`）——折 `__configDir` 键不影响任何其他读者;旧代码的白名单解析读新行自动忽略该键（降级安全）。
