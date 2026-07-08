# RFC-154 — runtime config 目录注入可配置化（proposal）

- 状态：Draft
- 触发：2026-07-08 用户「放 skill 和 agent 的目录名，要支持用户自己配置，因为自定义的二进制有可能会改掉」
- 关联：RFC-111（双 runtime 注入机制）、RFC-112（`runtimes.binaryPath` 自定义 fork 二进制）、RFC-113（runtime = 完整执行 profile）、RFC-153（同表在删 `builtin` 列——排序耦合点，见 design §7）

## 背景

平台向两个 runtime 注入 agent / skill 的落点,当前**全部硬编码**:

| runtime | config 目录 env var | 叶子目录名 | 该目录里装什么 |
|---|---|---|---|
| opencode | `OPENCODE_CONFIG_DIR` | `.opencode` | framework-managed skills（`<dir>/skills/`）——opencode 的 config root |
| claude-code | `CLAUDE_CONFIG_DIR` | `.claude` | skills（`<dir>/skills/`）+ transcript（`<dir>/projects/`）+ 桥接凭据 |

硬编码点:`runner.ts:454`（`.opencode` 叶子 + 无条件 `prepareSkills`）、`opencode/spawn.ts:79`（env 名）、`opencode/driver.ts:176`（叶子）、`claudeCode/spawn.ts:74,118`（叶子 + env 名）、`claudeCode/driver.ts:65`、`claudeCode/sessionCapture.ts`。

RFC-112 已允许把 runtime 指向一个**自定义 fork 的二进制**（`runtimes.binaryPath`）。但自定义 fork 完全可能:

1. 读一个**不同名的环境变量**（不是 `OPENCODE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR`）来定位自己的 config 目录;
2. 或按**固定目录名约定**发现 config 目录（写死找某个特定名字的目录）。

任一情况下,平台注入的 skills 都进不到 fork 实际读取的位置——skill 注入静默失效,fork 回落到它自己真实的默认目录。当前**没有任何配置旋钮**能改这两样,只能改源码。

顺带,现有实现有一个**既存冗余 bug**:`runner.ts:464` 的 `prepareSkills` 在 runtime 无关的序章里**无条件**把 skills 拷进 `<runRoot>/.opencode/skills/`,即便 runtime 是 claude——而 claude 真正读的是 `<runRoot>/.claude/skills/`（由 `prepareClaudeConfigDir` 另注入一遍）。claude run 因此凭空多出一个从不被读的 `.opencode/` 目录（managed skill 还白白 `cpSync` 全量拷贝一份）。这段代码写于 RFC-111 引入 claude 支持**之前**,加 claude 时漏了 runtime 分支。

## 目标

1. 让 **config 目录的 env var 名** 与 **叶子目录名** 成为 **per-runtime 可配置项**,存于 `runtimes` 表,对 opencode 与 claude-code 两协议都生效。
2. `NULL` / 留空 = 协议默认（`OPENCODE_CONFIG_DIR` + `.opencode` / `CLAUDE_CONFIG_DIR` + `.claude`），与 `binaryPath` NULL→默认二进制、`model` NULL→二进制默认 的既有范式一致。
3. 顺手修掉「claude run 也建 `.opencode`」的冗余:skill 注入改为 **runtime-aware**,只注入到该 runtime 实际读取的（现已可配的）config 目录,并把 runner 与 claude 两处近似重复的 skill 注入循环收敛成单一 helper。
4. 未配置（存量 runtime，两列皆 NULL）时,spawn 的 argv / env / 文件系统操作与今天**字节等价**（golden 锁保护）。

## 非目标（明确不做）

- **opencode 的 inline-config env var（`OPENCODE_CONFIG_CONTENT`）不做可配**。这是 opencode 注入 **agent 定义**的通道。用户 2026-07-08 明确拍板本 RFC「仅 config 目录」。⚠️ **已知局限**:若某 fork 同时把 `OPENCODE_CONFIG_CONTENT` 也改了名,则即使配了自定义 config 目录,该 fork 的 **agent 定义仍注入不到**,需后续 RFC 扩展。此边界用户已知悉并接受。
- **claude 的 flag 名（`--append-system-prompt-file` / `--agents` / `--mcp-config` / `--strict-mcp-config`）不做可配**。同理属于 agent/MCP 注入通道,超出「config 目录」范畴。
- `OPENCODE_AW_INVENTORY_OUT` 不做可配（这是平台自注入插件与 runner 之间的私有契约,不是 fork 会改的 opencode 面）。
- **系统 agent（distiller/commit）/ smoke / probe 的 config 目录不做可配**（design §2.3）。它们是 framework 内部进程、不注入业务 skill,`buildSpawn` 的 golden 是 `OPENCODE_CONFIG_DIR=<attemptDir>`（无 leaf）与业务 spawn 不同形；本 RFC 只覆盖业务节点 spawn（`buildBusinessSpawn`）。**已知局限**:runtime 编辑页「Test binary」probe 用协议默认 env 探测,不覆盖自定义 env 名（probe 本就 advisory，不阻断保存）。
- 不改 skill 的三态语义（managed=copy / external=symlink / project=跳过）、不改 agent 注入机制本身、不改 model/凭据桥/git identity 逻辑。

## 用户故事

- 作为运维,我构建了一个把 config 目录环境变量改名为 `MYCODE_CONFIG_DIR`、且默认目录叫 `.mycode` 的 opencode fork。我在「运行时」页新建一个指向该二进制的 runtime,在「config 目录」高级设置里填 env 名 `MYCODE_CONFIG_DIR`、目录名 `.mycode`。此后该 runtime 下发的任务,skills 被正确注入到 fork 读取的位置,agent 正常运行。
- 作为运维,我没动过任何自定义配置。所有既有 runtime（两列 NULL）行为与升级前完全一致,skills 仍进 `.opencode` / `.claude`。
- 作为运维,我在 config 目录名里误填了 `../evil` 或空字符串,保存时被表单 + 服务端拒绝并给出明确报错,不会污染 runRoot 之外的路径。

## 验收标准

1. `runtimes` 表新增两个可空列 `config_dir_env`、`config_dir_name`;迁移可正向 apply,`upgrade-rolling` 的 journal 计数锁同步 +1。
2. 新建/编辑 runtime 的前端表单出现这两个可选字段（复用 `<Field>` + `<TextInput>`,禁止原生元素）,带 hint 说明「留空=协议默认」,含深浅主题视觉自查。
3. 两列均 NULL 的 runtime,opencode 与 claude 的 spawn env（含 env var 名）+ 叶子目录 + skill 落点与升级前字节等价（golden 锁）。
4. 配了自定义值的 runtime:opencode 的 env 里出现 `<customEnv>=<runRoot>/<customName>` 且**不再**出现 `OPENCODE_CONFIG_DIR`;skills 落在 `<runRoot>/<customName>/skills/`;claude 同理。
5. claude run **不再**产生 `<runRoot>/.opencode`（或任何 opencode 叶子）目录（冗余修复回归锁）;空 skills 列表仍建出 config 目录（不回归 opencode 启动前置）。
6. 校验:`config_dir_name` 拒绝路径分隔符 / `.` / `..` / 绝对路径 / 空;`config_dir_env` 拒绝空 / 非法 env 名 / **平台保留 key**（`OPENCODE_CONFIG_CONTENT`/`PWD`/`IS_SANDBOX`/git identity 等）。纯函数单测覆盖正/边界/错误路径。
7. 首帧冻结后编辑 runtime 的 config_dir_*,同 session resume/retry 仍用冻结的旧值（冻结存活锁）;系统 agent / smoke golden 逐字不变。
8. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿;binary smoke 绿;push 后 CI 三项 + e2e 绿。
