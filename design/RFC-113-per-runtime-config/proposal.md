# RFC-113 — 运行时即执行 profile（代理只选运行时、参数归运行时所有）

状态：**Done**（3 PR 全部上库 + 双 gate：`9f54502` PR-A〔profile 数据层 + 两段迁移〕/ `97902d4` PR-B〔runner 读运行时参数 + 节点去参数 + 二进制收口〕/ `bbaf94c` PR-C〔前端选择器-only + 纯表 + profile 编辑 + 行级默认 + 全局项搬迁〕；Codex 设计 gate 10 findings 全 fold〔见 design §9〕；前端 vitest 2759 pass + backend 全量 + typecheck/lint/format 全绿。顺带修 smoke 缺 mkdir〔`b86eac9`〕+ 源码字面 NUL 字节〔`d15546d`〕）

触发：2026-06-27 用户两轮：「运行时页签应该只承载一张表才对啊，下面所有的配置都是运行时独有的了」+「代理配置里只能选择运行时而不允许修改运行时参数；工作流编排里也不允许修改运行时参数；运行时配置时支持同一个二进制创建多个运行时，按名称区分，每个运行时可以有不一样的运行时参数」。

---

## 1. 背景与模型转变

RFC-112 把「运行时」做成了**命名 + 二进制 + 协议**的注册表。本 RFC 把运行时进一步升级为**完整执行 profile**，并据此重排参数归属：

**核心转变**：
- **运行时 = 完整执行 profile** = `(名称, 协议, 二进制, model, variant, temperature, steps, maxSteps)` 一整套。
- **代理（agent）只选运行时**：不再自带 model/variant/temperature/steps；agent 配置里只剩一个运行时选择器。`readonly` 仍属代理（「这个代理能不能写」是代理能力，不是运行时参数）。
- **工作流节点不覆盖运行时参数**：节点上的 model/variant/temperature/steps override 移除（节点保留 prompt 模板 / 超时 / 重试 / 单多进程等非运行时项；也不覆盖运行时本身，沿用 RFC-111 D1「节点不覆盖运行时」）。
- **同一二进制可建多个运行时**：名称是唯一键、二进制可重复——`opencode-opus`(opencode 二进制+opus+temp0.7) 与 `opencode-haiku`(同二进制+haiku+temp0) 是两个运行时。
- **运行时页签 = 纯表**：去掉表下方长表单；运行时/模型配置进表的每一行；真全局项（并发/日志/commit&push）移到别的页签。

**与我初稿（已废）的区别**：初稿以为 config 模型默认只是前端新建预填、做成「每运行时」无后端解析变更。但用户要的是**代理彻底不带参数、参数归运行时**——所以 runner 必须从**解析出的运行时**取 model/variant/steps（真后端解析链变更），且存量代理的参数要迁移。

## 2. 目标 / 非目标

### 目标

1. **运行时即 profile**（D1）：`runtimes` 表加 `model` / `variant` / `temperature` / `steps` / `max_steps` 列（variant/temperature/steps 仅 opencode 协议有意义；claude 协议只 model）。
2. **代理只选运行时**（D2，用户答）：agent 配置 UI 只剩运行时选择器；移除 model/variant/temperature/steps 字段。`agents.model/variant/temperature/steps/maxSteps` 列**弃用**（迁移后不再读写；保留列以兼容存量直到迁移完成）。`readonly` 保留。
3. **节点不改运行时参数**（D3，用户答）：工作流节点 override 移除 model/variant/temperature/steps；节点不选运行时（沿用 agent 的，RFC-111 D1）。
4. **同二进制多运行时**（D4，用户答）：注册支持同 `binary_path` 不同 `name` + 不同参数；name 唯一即可，无 binary 唯一约束（本就没有）。
5. **后端解析改读运行时**（D5）：runner `buildInlineConfig` 的 model/variant/steps 从 **agent 解析出的运行时行**取（`agent.runtime → runtime row → 参数`），不再从 agent 列。
6. **存量代理迁移 = 按参数组合自动建 profile**（D6，用户答）：扫描存量代理的不同 `(协议, 二进制, model, variant, temperature, steps, maxSteps)` 组合，去重后每种建一个命名运行时，代理指向匹配项——**行为完全不变**。
7. **运行时页签纯表 + 行级默认 + 全局项搬迁**（D7）：运行时页签只剩 `RuntimeList`；行内可改全套 profile + 「设为默认」标记（写 config.defaultRuntime）；并发/logLevel/commit&push 移到别页签。
8. **内置运行时可改配置面、身份锁**（D8）：内置 opencode/claude 行的 binary/model/params 可编辑；name/protocol/删除仍锁。config.opencodePath/claudeCodePath/defaultModel/... 迁入内置行。

### 非目标

- **不改 RFC-112 的协议/驱动/冻结/冒烟/路由机制**：只加 profile 列 + 改参数归属 + 迁移 + UI 重排。
- **不动 `readonly` 归属**：仍是代理能力。
- **不引入运行期「代理未选运行时」之外的新回退**：代理必有运行时（agent.runtime ?? config.defaultRuntime）。
- **不动 commit&push 功能逻辑**，只搬其设置位置（其内部 agent 仍 opencode、RFC-111 D14）。

## 3. 用户故事

- **US-1（运行时即 profile）**：管理员建运行时 `opencode-opus`（opencode 二进制 + model=opus + temp=0.7）与 `opencode-haiku`（同二进制 + haiku + temp=0），两者只差参数、共享二进制。
- **US-2（代理只选）**：建审计代理时，agent 表单只有一个运行时下拉（选 `opencode-haiku`）+ readonly 开关；没有 model/temp 字段——参数由运行时决定。
- **US-3（节点不覆盖）**：工作流画布里节点抽屉不再有 model/variant/temp/steps 覆盖项；节点用其代理的运行时参数。
- **US-4（纯表）**：运行时页签只一张表，每行可改 profile 全套 + 测试 + 设默认 + 删除。
- **US-5（存量无损）**：升级后，原本各带 model/temp 的存量代理被自动归入按其参数组合建的运行时，跑起来与升级前一致。

## 4. 验收标准

1. `runtimes` 加 5 列（migration）；行编辑可改（variant/temp/steps 仅 opencode 协议显示）；同二进制可建多名运行时。
2. agent UI 只剩运行时选择器（无 model/variant/temp/steps）；`agents.*` 参数列迁移后不再被读写。
3. 工作流节点抽屉无 model/variant/temp/steps override。
4. runner `buildInlineConfig` 从运行时取 model/variant/steps；agent/节点不再供这些值。
5. **存量迁移**：启动一次性、幂等——按 `(协议,二进制,model,variant,temperature,steps,maxSteps)` 去重建命名运行时，存量代理 `runtime` 指向匹配项；行为不变（黄金：迁移前后某代理解析出的 inline model/变体/步数一致）。
6. 运行时页签纯表 + 行级默认标记（写 config.defaultRuntime、去下拉）；全局项（并发/logLevel/commit&push）在目标页签。
7. 内置行 binary/model/params 可改、name/protocol/删除 403；config.opencodePath/claudeCodePath/defaultModel/... 迁入内置行。
8. 门禁全绿 + Codex 设计/实现 gate fold；迁移有专门回归（含「无 model 的存量代理→内置运行时」「自定义 model→新 profile」「同参数多代理→共享一个 profile」）。

## 5. 决策登记

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| **D1** | 运行时构成 | **完整 profile**（+model/variant/temperature/steps/maxSteps） | 运行时是一整套执行配置；variant/temp/steps 仅 opencode。 |
| **D2** | 代理参数 | **代理只选运行时、不带参数**（用户答）；readonly 留代理 | agent UI 只剩运行时选择器；agents.* 参数列弃用。 |
| **D3** | 节点覆盖 | **节点不改运行时参数**（用户答） | 移除节点 model/variant/temp/steps override；节点不选运行时（RFC-111 D1）。 |
| **D4** | 同二进制多运行时 | **支持**（用户答）；name 唯一、binary 可重复 | 命名 profile 机制：同二进制不同参数=不同运行时。 |
| **D5** | 后端解析 | **runner 从运行时取 model/variant/steps**（真解析链变更） | 代理已无参数；buildInlineConfig 读 agent.runtime→行。 |
| **D6** | 存量代理迁移 | **按参数组合去重自动建 profile + 代理指向**（用户答） | 行为完全不变；契合命名 profile 模型。 |
| **D7** | 页签/默认/全局 | 运行时页签纯表 + 行级默认标记 + 全局项移别页签 | 见前两轮决策。 |
| **D8** | 内置可编辑面 | binary/model/params 放开、name/protocol/删除锁；config.* 迁入内置行 | 用户要在表里改内置；身份仍只读（RFC-104/112）。 |

## 6. 影响面概览

- **DB**：`runtimes` 加 5 列；`agents.model/variant/temperature/steps/maxSteps` 弃用（迁移后不读写）。
- **后端**：`runtimeRegistry`（profile 列 CRUD + 内置可改配置面 + seed 保留值）；runner `buildInlineConfig` 改读运行时；节点 override schema 去参数项；**两段一次性迁移**（config→内置行；agent 参数→去重 profile + 重指向）；二进制收口（RFC-112 P2 claudeCodePath 透传移除）。
- **前端**：AgentForm 只剩运行时选择器；WorkflowCanvas 节点抽屉去参数 override；`RuntimeFormDialog` 加 profile 字段（按协议显隐）+ 同二进制多运行时；运行时页签纯表 + 行级默认；全局项搬迁；agents.new 去 model 预填；i18n。
- **测试**：profile 列 CRUD + 同二进制多运行时；runner 读运行时参数（黄金）；两段迁移幂等无损（多场景）；agent/节点无参数字段（源码文本断言兜底）；UI；全局项迁移。

详见 `design.md` / `plan.md`。
