# RFC-016 Plan — 任务分解 + PR 拆分

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)

## PR 拆分建议

单 PR 落地。理由：

- 改动面**全在前端**（schema / backend / migration 零改动），不存在跨服务部署窗口风险。
- 渲染层 + 拖拽交互 + Inspector + CSS + i18n 是同一个心智模型的"半成品 → 成品"切换，拆 PR 会出现"老视觉 + 新交互"或"新视觉 + 老 Inspector"的中间态，反而难评审。
- 若实施期间发现某子任务可独立交付（例：先把 loop Inspector 候选式表单单独上线），允许从下方 T 列表中切一个 T-子集成单独 PR，但默认聚合提交。

commit message 前缀：`feat(canvas): RFC-016 wrapper container UX`。

## 子任务（T 列表，按建议实施顺序）

### T1 —— shared schema 加 wrapper.size optional 字段

- 文件：`packages/shared/src/schemas/workflow.ts`
- 改动：
  - WorkflowNode 已有 `.passthrough()`，但显式为 wrapper 类节点声明 `size?: { width: number; height: number; sizeLocked?: boolean }` 让前端类型可用——通过新建 `WrapperSizeSchema` + 在 WorkflowNodeSchema 上扩展 optional 字段，不破坏现有解析。
- 验证：
  - `bun --filter shared typecheck` 通过。
  - 现有 workflow schemas 测试套件（如有 round-trip 测）全绿。

### T2 —— 纯函数 1：`computeFitBounds` + `loopMemberCandidates`

- 文件：新 `packages/frontend/src/components/canvas/wrapperFit.ts` + `wrapperCandidates.ts`
- 测试：`tests/wrapper-fit-bounds.test.ts`（5 case：空 nodeIds / 单子节点 / 多子节点 / 嵌套 wrapper 作为子节点 / sizeLocked 路径不重算）；`tests/wrapper-loop-candidates.test.ts`（4 case：agent 节点取 outputs / review 节点固定 output / 嵌套 wrapper 不出现在候选 / 缺 outputs 兜底 ['out']）。

### T3 —— 纯函数 2：归属解析 + patch

- 文件：新 `packages/frontend/src/components/canvas/wrapperMembership.ts`
- 函数：`resolveMembershipOnDragStop` + `applyMembershipPatch`。
- 测试：`tests/wrapper-membership.test.ts`（9 case：基础落入 / 落出 / 拖到嵌套时取最内层 / 自我命中排除 / 两 wrapper 切换原子性 / 落点未变保持 reference equality / draggedNodeId 是 wrapper 本身不进自己 / 命中即当前 wrapper 不触发 patch / nodeIds 去重）。

### T4 —— 纯函数 3：xyflow ↔ definition 坐标系投影

- 文件：编辑 `packages/frontend/src/components/canvas/connectionSync.ts` 或新 `coordProjection.ts`
- 函数：`definitionToXyflow` + `xyflowToDefinition`。
- 测试：`tests/wrapper-coord-projection.test.ts`（6 case：单层 wrapper 投影 / 嵌套 git-in-loop 三层 / 子节点绝对坐标保持 DB 不变 / 空 wrapper / wrapper.size 缺省时 computeFitBounds 兜底 / sizeLocked=true 时不重算）。

### T5 —— 新组件 `GroupWrapperNode` 替换两旧组件

- 文件：
  - 改：`packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx`（重写为统一 GroupWrapperNode + WrapperHeaderPill 子组件；旧 GitWrapperNode / LoopWrapperNode 删）。
  - 改：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`（nodeTypes 映射 `wrapper-git` / `wrapper-loop` 都指向 GroupWrapperNode）。
- 测试：`tests/group-wrapper-node.test.tsx`（8 case：git / loop 各自 className / header label / pill 内容差异 / status 三态点 / drop-hover 与 leave-hint class 切换 / loop 仍保留 catch-all / 不再渲染 named left port / data.title 缺省时回退 nodeId）。

### T6 —— WorkflowCanvas 接入新 nodeTypes + onNodeDragStop 钩子

- 文件：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`
- 改动：
  - `nodeTypes` 字典两 key 都映射到 GroupWrapperNode。
  - `definitionToXyflow` / `xyflowToDefinition` 接入。
  - `onNodeDragStop` 调用 T3 纯函数 + commitChange。
  - `onNodeDrag` 期间维护 `dropHoverWrapperId` 局部 state，传给 GroupWrapperNode 的 className。
  - 启用 xyflow `<NodeResizer>` 在 selected wrapper 上；onResize 节流 + 松手时 commitChange 写 wrapper.size + sizeLocked=true。
- 测试：通过 T2 + T3 + T4 + T5 单测覆盖；canvas 集成层面用源代码层兜底（参 C3）。

### T7 —— NodeInspector loop 表单候选式重写

- 文件：`packages/frontend/src/components/canvas/NodeInspector.tsx`
- 改动：wrapper-loop 分支的 exitCondition.nodeId / portName 改 select；outputBindings 行内 select；i18n 新 5 条 key（中英各）。
- 测试：`tests/wrapper-loop-inspector.test.tsx`（5 case：候选源派生 / 选 nodeId 后 portName 候选刷新 / 旧 value 不在新候选时红字 / outputBindings select / 候选随 nodeIds 拖入/拖出动态更新）。

### T8 —— 右键菜单 + header pill 行为

- 文件：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`（menuItems 扩展）+ `nodes/WrapperHeaderPill.tsx`（新）
- 改动：
  - 新增 menu items：Open Inspector / Fit to children / Unwrap / Delete wrapper and inner nodes（后者需 confirm dialog）。
  - WrapperHeaderPill：git 显示 "⎈ snapshot ▾"、loop 显示 "⟳ × N · kind"；点击 git pill 弹小菜单（Unwrap + Fit）、点击 loop pill 切到 Inspector。
- 测试：`tests/wrapper-context-menu.test.tsx`（4 case：menu items 渲染 / Unwrap 等价 decomposeWrapper / Fit to children 清 sizeLocked + 重算 / Delete 二次确认）+ `tests/wrapper-header-pill.test.tsx`（3 case：git/loop 各自文案 / loop maxIterations + kind 实时反映 / git pill 点击展开二项菜单）。

### T9 —— Validator 加 warning + ValidationPanel 行内 "Auto-fit"

- 文件：
  - 改：`packages/backend/src/services/workflow.validator.ts`（新 rule `wrapper-children-outside-bounds` severity=warning）。
  - 改：`packages/frontend/src/components/ValidationPanel.tsx`（warning 项含 `wrapper-children-outside-bounds` 时渲染 "Auto-fit" 链接，点击调本地 fit + commitChange）。
- 测试：`tests/workflow-validator-wrapper-bounds.test.ts`（4 case：inner 在边界内不报 / inner 越界报 warning / size 缺省时不报（size 缺省 = 渲染期临时算，DB 不知道边界） / 嵌套 wrapper 子级越界冒泡）+ `tests/validation-panel-autofit.test.tsx`（2 case：warning 渲染 Auto-fit 链接 / 点击触发 fit）。

### T10 —— 源代码层兜底（CSS 旧规则消除 + i18n key 完整性）

- 文件：`packages/frontend/src/styles.css` + `tests/canvas-wrapper-styles.test.ts`
- 改动：删旧 `.canvas-node--wrapper-git` / `.canvas-node--wrapper-loop` / `.canvas-node--wrapper` 规则；新 `.canvas-node--wrapper-group--{git,loop,drop-hover,leave-hint}` + `.wrapper-header-pill` 规则。
- 测试（参 RFC-006 C3 模式）：fs 读 styles.css 用正则断言旧规则不再出现、新规则字面量存在；fs 读 WrapperNodes.tsx 断言不再 import 旧组件名。

### T11 —— Playwright e2e 扩展

- 文件：`e2e/main.spec.ts`（在现有 task done 后追加 step）
- 步骤：画布拖一个 git wrapper、再拖两个 agent 节点进矩形、auto-save 落定后保存 workflow → 跑一轮 stub task → 进 `/tasks/:id` 验 wrapper 容器矩形 + inner agent 节点 `getBoundingClientRect` 落在 wrapper rect 内（1px slack）。

### T12 —— STATE.md + plan.md 索引同步

- 文件：
  - `design/plan.md`（RFC 索引 RFC-016 行从 Draft 改 In Progress / Done）。
  - `STATE.md`（顶部"进行中 RFC"加 RFC-016 链接；落地后在"已完成 RFC"表里加一行）。

## 验收清单（按 proposal §4 + design §8 合并）

- [ ] A1–A10 全部测试用例落地并通过。
- [ ] B1：`bun run typecheck && bun run test && bun run format:check` 全绿。
- [ ] B2：既有 canvas-_ / wrapper-_ / scheduler 测试套件零回归。
- [ ] B3：backend 测试数量 0 新增、0 退化。
- [ ] B4：frontend 新测试 ≥ 25（按 T2/T3/T4/T5/T7/T8/T9/T10 分布）。
- [ ] B5：Playwright e2e 在 ubuntu + macos 矩阵全绿。
- [ ] B6：单二进制包体积 / 启动时间不退化（perf-sweep 不强制 re-run，但若 frontend bundle 因 NodeResizer 引入额外 chunk 显著膨胀 ≥ 10% 则要在 PR 描述里注明）。
- [ ] C1–C5 回归防护测试与顶部注释（含 RFC-016 链接 + 锁定语义说明）全部落地。
- [ ] design.md §7.4 / 主 design.md 中包装器章节同步更新（标注"v2 容器化，详见 RFC-016"）。
- [ ] CI（GitHub Actions）所有 jobs 绿（lint/typecheck/test × {macos, ubuntu} + build single-binary × {macos, ubuntu} + playwright × {macos, ubuntu}）。

## 与并行 RFC 的相互影响

- **RFC-007 拖拽连线**：本 RFC 不动 edge 连线交互；catch-all 兜底（RFC-003）继续维持。
- **RFC-008 / RFC-009 / RFC-010 / RFC-011 / RFC-012 / RFC-013**：全 review / markdown / diff 路径，与画布 wrapper 交互正交。
- **RFC-014 iterate sibling regen**：纯 review iterate 路径改动，与 wrapper 交互正交。
- **RFC-015 fanout source port drag**：与 agent-multi 端口拖拽相关，与本 RFC 不冲突；wrapper 容器内的 agent-multi 节点照常显示其 source port 拖拽源。

并发工作树原则（参 CLAUDE.md "Multi-person collaboration"）：本 RFC 改动文件清单：

- `packages/shared/src/schemas/workflow.ts`
- `packages/frontend/src/components/canvas/WorkflowCanvas.tsx`
- `packages/frontend/src/components/canvas/NodeInspector.tsx`
- `packages/frontend/src/components/canvas/ValidationPanel.tsx`
- `packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx`
- `packages/frontend/src/components/canvas/nodes/WrapperHeaderPill.tsx`（新）
- `packages/frontend/src/components/canvas/wrapperFit.ts`（新）
- `packages/frontend/src/components/canvas/wrapperCandidates.ts`（新）
- `packages/frontend/src/components/canvas/wrapperMembership.ts`（新）
- `packages/frontend/src/components/canvas/coordProjection.ts`（新 or 编辑既有 connectionSync.ts）
- `packages/frontend/src/styles.css`
- `packages/frontend/src/i18n/{zh,en}.json`
- `packages/backend/src/services/workflow.validator.ts`
- `packages/backend/tests/workflow-validator-wrapper-bounds.test.ts`（新）
- `packages/frontend/tests/wrapper-*.test.{ts,tsx}`（多新）
- `packages/frontend/tests/canvas-wrapper-styles.test.ts`（新）
- `packages/frontend/tests/group-wrapper-node.test.tsx`（新）
- `e2e/main.spec.ts`
- `design/plan.md` + `STATE.md`（索引同步）

落 commit 时严格按 CLAUDE.md "Multi-person collaboration"：精确 `git add` 上述文件、不动同仓他人未追踪文件、不删别人在 `design/plan.md` / `STATE.md` 已加的并行 RFC 行。
