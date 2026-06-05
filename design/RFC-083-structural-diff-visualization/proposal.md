# RFC-083 — 结构化代码 Diff 可视化（Structural Diff Visualization）

状态：**Draft**（待用户批准进入实现）

## 背景

平台的核心价值是驱动多个 opencode agent 协作（旗舰流水线 Code → Audit → Fix）。每个节点是一个 agent，会对 worktree 改代码。今天理解"某个 agent 改了啥"只有一条路径：读**文本 unified diff**（`DiffViewer` / `WorktreeDiffPanel`，源自 `gitDiffSnapshot`）。逐行 hunk 对 reviewer / auditor 极不友好——要在脑子里重建"哪个类的哪个方法被加/改/删、引入了什么新依赖、影响面有多大"。当一个 audit agent 要快速判断 worker agent 改动的范围与风险时，文本 diff 是最低效的载体。

本 RFC 增加一个**结构化叠加视图**：把"前后两份代码"解析成符号图（文件 → 类 → 方法 → 成员 + import / 调用 / 继承边），做集合差分，直接告诉人：

- 哪些**文件**改了；
- 哪些**类 / 接口 / trait / struct / enum** 新增 / 修改 / 删除；
- 哪些**方法 / 函数** 新增 / 修改 / 删除（重命名 / 移动感知）；
- 哪些**成员 / 字段** 新增 / 修改 / 删除；
- 新引入 / 移除 / 升级了哪些**外部包依赖**；
- 每个被改符号**改了哪些逻辑**（v1：静态确定性描述 + 直达 hunk）与**改了哪些依赖**（新增 import 边）；
- 改动的**影响面 / blast-radius**：谁调用了被改的方法（深度模式）。

## 目标

1. 对**三种粒度**给出结构化变更视图：
   - **按节点（per-agent）**：某个 agent 节点执行前后单独改了什么（贴合用户原话"某个 agent 执行前后的节点 diff"）；
   - **整任务（task）**：base_commit → 当前 worktree 的累计变更；
   - **git-wrapper 节点**：wrapper 的 `git_diff` 输出所代表的"首个内层节点前 → 末个内层节点后"区间。
2. 覆盖 **8 种语言**：C++、Java、Python、Rust、Go、JavaScript、TypeScript、Scala。
3. **静态、确定性、可复现优先**：v1 的全部结构 / 依赖 / 影响信号都来自静态分析，无 LLM、可重跑得到同样结果（审计信号必须可信）。AI 逻辑摘要后置为显式标注的可选增强。
4. **不破坏单二进制分发**：基线引擎（tree-sitter WASM）随二进制内嵌、架构无关、对"改坏了编译不过"的中间态也能跑。
5. **影响面 + C++/Scala 一等公民**通过**可选深度模式**实现：守护进程探测/调用"外部已安装"的 SCIP 索引器（与现状中 `opencode` / `git` 同为 PATH 上的外部依赖一致），装了就给精确跨文件结果，没装 / 项目编译不过 / 超时则**自动回退基线**并明确标注。

## 非目标（v1）

- **不替代文本 diff**：结构视图是文本 diff 的叠加 / 补充，二者可切换、互通（点符号跳到对应 hunk）。
- **不做 AI 生成的逻辑摘要**：留到后置可选增强（见 design §11）。
- **不改 opencode 运行时 / agent 输出协议 / 现有 diff 抓取管线**：完全复用既有 `(fromCommit, worktree)` 输入。
- **不强求所有语言同等精度**：基线对 C++/Scala 是 best-effort（成员 / `#include` / Scala-3 构造不全），深度模式可用时才一等公民。
- **不做实时增量 / IDE 级语义**：分析在节点 / 任务完成时一次性算出产物（artifact）。

## 用户故事

1. **审阅 worker 改动**：我打开任务详情的"结构"视图，顶部摘要卡片显示 `4 文件 · 类 +3/~2/−1 · 方法 +12/~5/−1 · 字段 +6/~2 · 新依赖 2（tokio, serde_json）`，下方按文件折叠的结构树，每个类 / 方法 / 字段带 `+`（绿）`~`（黄）`−`（红）徽标。秒级 get 到改动全貌。
2. **审某个 audit / fix 节点**：我在节点列表 / 画布选某个 agent 节点，结构视图切到"按节点"，只显示**这个 agent** 改了什么，不被其它节点的改动干扰。
3. **看影响面**：结构树里"方法 `OrderService.charge()` 被修改"旁显示"⚠ 5 处调用点（深度模式）"，点开列出调用方文件 + 行号，跳转过去。
4. **依赖变化**：依赖面板列出"`Cargo.toml` 新增 `tokio = 1.x`，源码 3 个文件新增 `use tokio::...`"，并标出"新 import 命中新 manifest 依赖"= 最高置信"本次改动引入了对 X 的依赖"。
5. **降级透明**：深度分析不可用（未装索引器 / 项目编译不过 / 超时）时，我看到清晰横幅"已用基线分析（跨文件影响面不可用）"，**结构树与依赖变化仍在**。C++/Scala 文件若基线 best-effort，文件级标注"结构分析不完整"。

## 验收标准（产品层）

- 6 种一等语言（Py / Go / TS / JS / Java / Rust）：给定一对 before/after 文件，结构树正确列出类 / 方法 / 字段的增 / 改 / 删，且方法重命名显示为"重命名"而非"删+增"。
- C++ / Scala：基线 best-effort 产出 + 文件级"不完整"标注，不报错、不污染其它文件结果。
- 依赖变更：8 大生态 manifest（Cargo / go.mod / package.json / pom+gradle / build.sbt / pyproject+requirements / CMake+vcpkg）的"新增外部依赖"被正确识别；新 import 边被抽取并分类 internal / stdlib / external。
- 三种粒度（节点 / 任务 / wrapper）都能出视图；按节点的快照边界缺口（未跟踪文件 / readonly 节点 / GC 后裁剪）被显式标注而非静默丢失。
- 影响面（深度模式）：在一个可编译的 fixture 上，被改方法的反向调用点被正确列出；深度不可用时**自动回退**基线、视图不崩。
- 单二进制 build smoke（`bun run build:binary`）通过：grammar WASM 随二进制内嵌、运行期可加载。
- 全绿门槛：`bun run typecheck && bun run test && bun run format:check`（见 design §测试策略）。

## 决策记录（来自用户，2026-06-05）

| 维度 | 决策 |
| --- | --- |
| 粒度 | 按节点 + 任务汇总 + git-wrapper 视图 |
| v1 范围 | 结构 + 依赖 + 影响面 |
| 逻辑细节 | 先静态确定性，AI 后置可选 |
| 语言 | 8 种全一等公民（C++/Scala 经深度模式） |
| 引擎 | 分层：内置 tree-sitter 基线 + 可选外部 SCIP 深度模式 |
| 编译态 | 深度尽力跑，失败 / 不可编译 / 超时自动回退基线 |

详见 [design.md](./design.md) 与 [plan.md](./plan.md)。
