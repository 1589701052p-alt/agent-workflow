# RFC-016 Proposal — 包装器交互重构：从"声明式节点列表"到"画布上真容器"

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：design/design.md §5（节点契约）+ §7.4（wrapper 节点） / RFC-003（catch-all 入端口） / RFC-006（端口呈现）

## 1. 背景

`wrapper-git` / `wrapper-loop` 是平台对"Code → Audit → Fix"主流程做编排时最常被使用的两类节点（git wrapper 用来圈定一个 commit 快照区间，loop wrapper 用来重试 / 迭代）。但当前编辑器对包装器的呈现与交互**与节点模型严重脱节**——包装器在 schema 里是"持有 inner node id 列表"的容器（`wrapper.nodeIds: string[]`），但在画布上**根本不渲染成容器**：

- `WrapperNodes.tsx` 把 wrapper 渲染成一张 ~240px 的小卡片，标题写"⎈ git wrapper"，正文只写"X inner nodes"。
- 真正属于包装器的 inner 节点跟外部节点**平铺在同一个 z-index 层**，视觉上完全没有"被包住"的感觉。
- 唯一的归属编辑入口是**右键 → "wrap selection"**（一次性把当前框选的节点写进新 wrapper.nodeIds）；事后增删成员只能去 Inspector 里看一串裸 node id 文字，没有任何画布层操作。
- `wrapper-loop` 的 exit condition 在 Inspector 里要求用户**手填 `nodeId` 字符串 + 手填 `portName` 字符串**——既不会下拉、也不会校验，写错了到运行期才报"unknown port"。
- loop wrapper 自己还会显式渲染一组左侧 input port（catch-all 加 named handle），让用户产生"我可以连边到 wrapper"的错觉，但实际上调度器只关心 inner 节点之间的边，wrapper 本身的"输入端口"是没有运行期语义的。

直接结果：用户在画布上拼一个 `git[ agent_design → agent_review ]` 都要先拖两个节点放到大致位置 → 框选 → 右键 → wrap selection；之后想把某个新加的 agent 也放进去，得回到 Inspector 看 id 串，或者把现有包装器删了重 wrap。新人完全看不出"哪个节点属于哪个包装器"。

业界对照（Dify / n8n / Langflow / ComfyUI Groups / Figma Frames）已经形成共识：**包装器要可见、可拖拽、自动 fit**。xyflow v12 原生提供 `parentId` + `extent: 'parent'` + group-type 节点支持，本平台已经依赖 xyflow v12 跑了 6 个 RFC（含 RFC-006 端口重构），是时候把这套能力接上来。

### 1.1 为什么要现在做

- M1–M5 已全部 Done（81/81 issue 关闭），平台进入"产品打磨期"——包装器交互是反复出现在用户反馈里的钝刀子（同 session 之前用户口头反馈"很难用、很难理解"），需要专项消化。
- 修复面**几乎全在前端**：xyflow 渲染层 + Inspector 表单 + auto-save 钩子；schema 不动、backend 调度器不动、validator 不动、DB migration 0 条。回滚成本低。
- 与并行 RFC（RFC-007 拖拽连线 / RFC-014 iterate sibling）不冲突——本 RFC 只动 wrapper 类节点和它在画布层的渲染/交互，不碰 review / iterate / agent-multi 等正交路径。

### 1.2 本 RFC 不动哪些地方

- **不动** `WorkflowNodeSchema` / `wrapper.nodeIds` 字段名 / `WorkflowDefinition.$schema_version`——zero migration、老 workflow 行零回写。
- **不动** `services/scheduler.ts` 对 wrapper 的执行语义（git 快照 / loop maxIterations + 3 种 exit condition / nested wrappers）。
- **不动** `services/workflow.validator.ts` 现有规则；新增 1 条非阻断 warning（详见 §2.1 #5）。
- **不动** `services/workflow.yaml.ts` 导入 / 导出格式——YAML 里仍是 `nodeIds: [..]` 列表，新增的画布尺寸字段是 optional pass-through。
- **不动** task 详情画布（`tasks.detail.tsx:TaskStatusCanvas`）的只读语义；只读模式下复用同一个新 wrapper 渲染，自动受益于"哪个节点属于哪个包装器"的可见容器，但禁用所有拖拽 / resize / 决断。
- **不动** RFC-003 catch-all 入端口在 loop wrapper 上的现有行为——本 RFC 重新评估 loop wrapper 是否仍然需要左侧 named input port（见 design.md §4.4）；catch-all 仍保留以接受"用户从一条边拖到 wrapper header"的兜底动作。

## 2. 目标

### 2.1 做

1. **wrapper 节点改造成 xyflow 原生 group**。
   - 渲染层：使用 xyflow `type: 'group'` 模式（或自定义 group 类型，最终选一在 design.md §3.1 决断），wrapper 占一块**可见的圆角矩形**，背景色用 `--panel` 的更浅变体（git wrapper 用偏蓝灰、loop wrapper 用偏紫灰，与现有 `data-status` 三态点不冲突），边框 1px dashed `--accent-muted`。
   - 子节点投影：渲染期由 wrapper.nodeIds 派生 xyflow node 的 `parentId` 字段；子节点 position 在加载时转换为相对于父 wrapper 的坐标（xyflow 要求 parentId 模式下子节点 position 相对 parent），保存时转回绝对坐标写回 DB——**DB schema 永远是绝对坐标**，不引入相对/绝对混合存储。
   - 自动 fit：子节点 bbox 计算（+ 24px padding 四向）决定 wrapper 渲染尺寸；尺寸缓存在 wrapper.size: { width, height } optional 字段（passthrough，已有 `WorkflowNodeSchema.passthrough()` 兜住），用户手动 resize 后停止自动 fit，回到完全自动需用右键菜单 "Fit to children"。

2. **拖入 / 拖出即归属**。
   - 拖动一个非 wrapper 节点：松手时检测落点是否在某个 wrapper 矩形内（命中规则：节点中心点落在 wrapper 矩形即视为命中，避免边界抖动）。
     - 命中：把节点 id 加到该 wrapper.nodeIds（如果已属于另一个 wrapper，先从原 wrapper.nodeIds 移除——一个节点同一时刻只能属于一个 wrapper）。
     - 未命中：从当前 wrapper.nodeIds 移除（已经在外部就保持不变）。
   - 拖动整个 wrapper：所有子节点跟随同步移动（xyflow `parentId` 原生行为）；wrapper.nodeIds 不变。
   - 嵌套：允许把 wrapper 拖进另一个 wrapper（即 `wrapper-loop` 内嵌 `wrapper-git`，与 §1.2 中的 backend 嵌套语义对齐）；命中检测对所有 wrapper 适用，仅 wrapper 自己除外。

3. **右键 / 工具栏：wrap selection / unwrap / fit to children**。
   - 保留现有"框选 → 右键 → wrap selection"快速路径，作为"先选后包"的备选。
   - 新增 wrapper 节点右键："Unwrap"（解散，把所有 inner 取出并把 wrapper 删掉，等价于现有 `decomposeWrapper`）/ "Fit to children"（强制重新 fit 一次）。
   - 新增 wrapper header **常驻 pill**：
     - git wrapper 显示 `⎈ snapshot ▾`（点开下拉只有"Unwrap" / "Fit to children"两项，作为右键的可发现替代）。
     - loop wrapper 显示 `⟳ × {maxIterations} · {exitCondKind}`（点击切到 Inspector loop tab）。

4. **loop wrapper Inspector 表单全部改成"基于成员节点的引用"**。
   - `maxIterations`：保留 NumberInput。
   - `exitCondition.kind`：保留 select（port-empty / port-equals / port-count-lt）。
   - `exitCondition.nodeId`：从 TextInput 改为 **select**，候选 = 该 wrapper 当前的 inner agent / review 节点（按 id 列出 + 节点 title hint）；候选随成员变化实时刷新；若 nodeId 不在当前候选中以红字提示 "该节点已不在 loop 内，请重新选择"，不再用裸字符串。
   - `exitCondition.portName`：从 TextInput 改为 **select**，候选 = 已选 nodeId 节点的输出端口（agent 节点取其 agent 的 `outputs[].name`；review 节点固定为 `output`）；同步红字校验。
   - `outputBindings`（loop wrapper 的对外输出）：保留现有结构，但 `bind.nodeId` / `bind.portName` 同样改为成员节点 + 其输出端口的下拉。

5. **新增 validator warning（非阻断）**："`wrapper-X 'wrapper_xxx' contains nodes outside the canvas group rect`" —— 当 wrapper.nodeIds 引用的节点位置在加载时不再落在 wrapper.size 计算的矩形内时（典型场景：YAML 手编 + 用户改过 wrapper.size 但没调整 inner 位置），编辑器加载后会在 ValidationPanel 提示，并提供 "Auto-fit to children" 行内按钮一键修复。

### 2.2 不做

- **不做** schema 层把"归属"从 `wrapper.nodeIds` 翻转为子节点 `parentNodeId`——会引入 migration 风险且与 backend `services/scheduler.ts:scopeOf(node)` 的现有寻址路径冲突；保持现状是更稳的选择。
- **不做** 多 wrapper 嵌套 + 共享子节点——一个子节点同一时刻只能属于一个 wrapper（与 backend `nestedWrapperGraph` 的现有约束保持一致）。
- **不做** wrapper 内部的"子画布 / 双击进入"——所有节点仍在同一 canvas 上，wrapper 只是"可见的圈"。子画布会引入额外的视口管理、面包屑、edge 跨边界裁剪等问题，超出本 RFC 范围。
- **不做** wrapper 本身渲染为可拖拽的 source/target 端口节点——本 RFC 评估后**移除 loop wrapper 当前的左侧 named input port**（保留 catch-all 兜底），因为它在调度器层没有运行期语义、长期误导用户（详见 design.md §4.4）。
- **不做** 后端 / DB migration / YAML schema 变化。
- **不做** "把 wrapper 拖出画布到 Sidebar 重新分类"等仓促交互；本 RFC 锁定**画布内**的归属编辑。

## 3. 用户故事

**S1（happy path：从零拼一个 git wrapper）**
用户从 Sidebar Wrappers 区把 Git Wrapper 拖到画布，落下后是一个空的 200×120 圆角虚线矩形（写着 "⎈ Git Wrapper" + "Drop nodes here"）。然后从 Agents 区把两个 agent 拖进矩形内——松手瞬间，wrapper 自动扩到能装下两个 agent；header 显示 "⎈ snapshot"。再拖一根边连接两个 inner agent。Done，无需右键无需 wrap selection。

**S2（增删成员）**
用户已有一个 git wrapper 套住 `[agent_design, agent_review]`，想把新加的 `agent_doc` 也放进去——直接把 `agent_doc` 拖进矩形，松手即归属。后来想把 `agent_review` 拿出来——拖到矩形外松手，wrapper 自动收缩、不再含 `agent_review`，wrapper.nodeIds 同步去掉。

**S3（loop wrapper exit condition：候选式表单）**
用户拖出 Loop Wrapper、把两个 agent 拖进去（`agent_fixer` 和 `agent_check`），打开 Inspector 切到 Loop 设置：

- maxIterations: 5
- exitCondition.kind: port-equals
- exitCondition.nodeId: **下拉**，列出 `agent_fixer (id: agent_design)` / `agent_check (id: agent_check)`——他选 `agent_check`。
- exitCondition.portName: **下拉**，列出 `agent_check` 当前 agent 配置声明的 outputs（如 `passed` / `issues`）——他选 `passed`。
- exitCondition.value: "yes"（仍是 TextInput）。

没有任何机会写错字符串。

**S4（嵌套：git inside loop）**
用户拖一个 Loop Wrapper、把现有的 git wrapper 整体拖进 loop 矩形——loop 自动扩到容纳整个 git wrapper（包括 git 的子节点）。wrapper.nodeIds：loop = [git_wrapper_id]，git = [agent_design, agent_review]，结构嵌套清晰可见。backend 的嵌套调度（`scheduler.ts` git-in-loop）零改动。

**S5（task 详情画布只读受益）**
用户进 `/tasks/:id`，画布渲染 task 时同样用新 wrapper 容器视觉——一眼看出"哪些 node 在 loop 里、哪些 node 在 git wrapper 里、当前迭代轮次"。所有拖拽 / resize 在只读模式下禁用。

**S6（老 workflow 无感升级）**
用户打开一个 M3 时期建的旧 workflow（wrapper 有 nodeIds 但没有 wrapper.size）——编辑器加载时 `computeFitBounds(wrapper, allNodes)` 算出尺寸用于渲染，下次 auto-save 把尺寸 commit 回 DB；用户视觉上看到的就是新的容器矩形，无需任何手动迁移。

## 4. 验收标准

### 功能

- **A1（拖入归属）**：在编辑器画布上拖一个 agent 节点到 wrapper 矩形内松手 → `definition.nodes` 中对应 wrapper 的 nodeIds 数组追加被拖节点 id；1s 内 auto-save 写回 DB。
- **A2（拖出归属）**：把当前在某 wrapper 内的节点拖到矩形外松手 → wrapper.nodeIds 移除该节点 id；wrapper.size 自动收缩。
- **A3（互斥归属）**：把 wrapper-A 内的节点拖进 wrapper-B 矩形 → 同一帧内从 wrapper-A.nodeIds 移除、加入 wrapper-B.nodeIds，无中间态。
- **A4（嵌套）**：把 git wrapper 整体拖进 loop wrapper 矩形 → loop.nodeIds 含 git wrapper id；backend `services/scheduler.ts` 嵌套测试 (`tests/wrapper-nested.test.ts` 等) 全部继续通过（无回归）。
- **A5（自动 fit）**：删除 wrapper 内最后一个节点后 → wrapper 收缩到空容器最小尺寸（200×120）；新加节点后 → wrapper 自动扩到能装下（+ 24px padding）；用户手动 resize 后 wrapper.size 被锁定为用户值，再加新节点不会被反弹。
- **A6（Unwrap）**：右键 wrapper → Unwrap → wrapper 节点被从 `definition.nodes` 删除，inner 节点保留、位置以"解散时各自相对 wrapper 的位置 + wrapper 当时绝对坐标"换算回绝对坐标。
- **A7（loop Inspector 候选式表单）**：打开 loop wrapper inspector → exitCondition.nodeId 是 select，options = wrapper.nodeIds 当前成员；选定后 exitCondition.portName 是 select，options = 该成员节点的 agent.outputs（review 节点为 `['output']`）。
- **A8（pill 操作）**：git wrapper header pill `⎈ snapshot ▾` 点击展开菜单含 Unwrap / Fit to children；loop wrapper header pill `⟳ × N · kind` 显示当前 maxIterations 与 exitCondition.kind。
- **A9（老 workflow 升级）**：加载一个没有 wrapper.size 的旧 workflow → 渲染期 `computeFitBounds` 算尺寸；用户首次任意操作触发 auto-save 后 wrapper.size 写入 DB；不主动触发 dirty——避免"打开一个旧 workflow 就被记一条无操作 commit"的反直觉行为。
- **A10（task 详情只读）**：`/tasks/:id` 上同一 wrapper 容器视觉渲染但拖拽 / resize / 右键全部禁用；inner 节点保持原 `data-status` 三态点。

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿。
- **B2** 不退化既有测试集——尤其 `canvas-*` 系列（RFC-003 / RFC-006）+ `wrapper-*` validator + scheduler nested 套件；其中 `wrapper-decompose.test.ts`（如果存在）按新交互更新但保留其作为"Unwrap 等价于现 decompose"的回归锁。
- **B3** backend tests：0 新增、0 退化（schema / scheduler / validator 全不动）。
- **B4** frontend tests 至少 +25：
  - wrapper 容器渲染层 8（GroupWrapperNode 渲染 / 子节点 parentId 投影 / 相对坐标投影 / fit bounds 计算 5 边界 / wrapper.size 缓存生效）。
  - 拖入 / 拖出 / 互斥归属纯函数 9（`resolveMembershipOnDragStop` 5 + `applyMembershipPatch` 4）。
  - loop Inspector 候选式表单 4（nodeId select 候选随 nodeIds 变化 / portName select 候选随 nodeId 变化 / 红字校验 / outputBindings 同步）。
  - header pill 2 + Unwrap 1 + Fit to children 1。
- **B5** Playwright e2e：扩 `e2e/main.spec.ts` 在 step 7 之后新增一段——画一个 git wrapper、拖入两个 agent 跑一轮 stub task，验证 task 详情画布上 wrapper 容器矩形可见、inner 节点的 status 三态点正确。
- **B6** 单二进制构建包体积 / 启动时间不退化（纯前端渲染逻辑改动，xyflow group 类型已在 deps 内）。

### 回归防护

- **C1** `tests/canvas-wrapper-membership.test.tsx` 顶部注释链回本 RFC：「locks RFC-016 §2.1 #2 — wrapper.nodeIds 必须由"节点中心点是否落在 wrapper 矩形内"派生；拖入 wrapper-A 内的节点拖到 wrapper-B 矩形必须从 A.nodeIds 同步移除（不允许两 wrapper 同时持有同一节点 id，与 backend nestedWrapperGraph 约束对齐）。红了说明命中检测或互斥规则被改坏」。
- **C2** `tests/canvas-wrapper-fit-bounds.test.ts` 顶部注释链回 §2.1 #1：「locks 自动 fit 算法 padding=24px、空容器最小 200×120 fallback；用户手动 resize 后必须停止自动 fit。红了说明 fit 算法被改回不可预测的尺寸」。
- **C3** 源代码层兜底（参 RFC-006 模式）：`canvas-wrapper-styles.test.ts` 用 fs 读 `WrapperNodes.tsx` + `styles.css`，断言 `.canvas-node--wrapper-group` 规则存在、不再含旧 `.canvas-node--wrapper-git` / `.canvas-node--wrapper-loop` 平铺卡片样式（避免 JSDOM 不跑 layout 时"渲染对了但 CSS 退化"的盲区）。
- **C4** `tests/loop-inspector-candidates.test.tsx` 锁 loop Inspector exitCondition.nodeId / portName 必须是 select 而非 TextInput——红了说明 RFC-016 #4 的"基于成员的引用"语义被回退到裸字符串。
- **C5** `tests/canvas-wrapper-relative-position.test.ts`：锁"DB schema 永远是绝对坐标"——保存 wrapper + inner 节点后，再次加载读 DB，inner 节点 position 必须是绝对坐标（不能因为 xyflow parentId 投影把相对坐标写回 DB）。红了说明 §2.1 #1 的"坐标系投影只发生在渲染层"规则被破坏。
