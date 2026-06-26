# RFC-106 — 任务分解

单 PR 交付（纯前端、无 DB/migration、无后端）。commit 前缀：`feat(frontend): RFC-106 拖拽连线目标预览与精准复用输入`。

## 子任务

### RFC-106-T1 — 判定纯函数 `dropTarget.ts`（基础）
- 新增 `components/canvas/dropTarget.ts`：`DropClassification` 类型 + `classifyDropTarget(def, conn)` + **`nextFreeInputPort(existingInputPorts, desired)`**（通用唯一端口名，Codex P1）。
- 规则：catch-all→`new`（端口名 = `nextFreeInputPort(目标现有输入端口, 来源输出口名)`，对 **agent/output 一致**消歧，不再只走 output 专用 `_2/_3`）/具名输入→`reuse`/review·fanout 专用输入·系统 handle·自连·空 toNode→`none`。
- 把 `applyConnectionForReviewOutput` 里 output 专用的 `_2/_3` 消歧上提为 `nextFreeInputPort` 共用（去重复，dedup-audit 缝）。
- 单测 `dropTarget.test.ts` 覆盖全部分支：**两个上游同名输出（如都 `result`）落 agent catch-all → 两个不同输入端口**（锁住核心误连修复）、output 同名冲突、reuse、review/fanout/clarify 系统口→none、自连/空 toNode→none、来源口名透传。
- 依赖：无。

### RFC-106-T2 — 命中优先级反转 + 复用小磁吸（PortHandles + 样式）
- `PortHandles.tsx`：已有输入 handle 加 `canvas-node__handle--reuse`（小/精准命中）；catch-all 命中默认化。公共 Props 不变。
- `styles.css`：`--reuse` 小磁吸、catch-all hover/active、`is-connect-target`/`--reuse-target` 高亮（canvas-node 命名空间）。
- 必要时设 `connectionRadius`（候选 1）。
- 测试：PortHandles 渲染断言（`--reuse` class、catch-all 存在、role/title 锚点）。
- 依赖：T1（类型）。

### RFC-106-T3 — 实时反馈渲染（useConnection + 提示）
- 新增 `ConnectDropHint`（消费 `useConnection`，经 `classifyDropTarget` 出 kind）或自定义 `connectionLineComponent`：目标节点高亮 + "新输入/复用同一输入"徽标。
- i18n `en.ts`/`zh.ts`：`canvas.connect.newInput` / `canvas.connect.reuseInput`。
- `WorkflowCanvas.tsx`：挂 `onConnectStart/End`（或渲染 hint 组件 + 自定义 connectionLine）。
- 测试：反馈组件在 `inProgress`+reuse/new 下渲染对应文案（role/text）。
- 依赖：T1。

### RFC-106-T4 — 接线收口 `handleConnect`（集成）
- `handleConnect` 通用路径改为先 `classifyDropTarget`，**直接用分类结果的 `portName` 建边**——`new` → `target.portName = 分类出的去冲突名`（如 `result_2`），`reuse` → 该端口名。**不再走 `translateInboundConnection`**（它会把 `__inbound__` 改写回 `sourceHandle`=`result`，重新制造撞名、且与预览不一致——Codex P2）。`none` → 维持现状路径（boundary 标记、output 消歧等不变）。**clarify/cross 两 classifier 仍在最前**。
- 测试：源码次序锁（channel classifier 先于 `classifyDropTarget`）+ 集成断言（两条同名输出落同一 agent → 两条边落不同端口；reuse 落点接已有端口）。
- 依赖：T1、T2、T3。

### RFC-106-T-V — 手动手感验证 + 视觉自查（交付前）
- 起 dev server，多 zoom 拖拽：确认"新输入默认 + 精准复用"手感；微调 T2 的磁吸取值（若候选 1 不稳 → 切候选 2 几何判定）。
- 截图与 `/agents` `/workflows` 等核心页 side-by-side 风格自查（按钮/描边/间距一致）。

## 验收清单
- [ ] T1–T4 全部完成，对应单测全绿。
- [ ] 预览提示 ⇄ 实际落点 由同一 `classifyDropTarget` 驱动（验收"二者一致"）。
- [ ] 复用需精准命中（小磁吸）；非精准默认新输入。
- [ ] clarify/cross 拖拽、wrapper-fanout 边界、output 多路收集零回归（既有测试绿）。
- [ ] `bun run typecheck && 前端 vitest && format:check` 全绿；CI 全绿。
- [ ] Codex 设计 gate（本 RFC 文档）+ 实现 gate（代码）通过，发现项 fold。
- [ ] STATE.md / plan.md RFC 索引登记，完工置 Done。

## PR 拆分建议
默认单 PR（四任务耦合在同一交互链路，拆开会留半截不可用的中间态）。若 T3 反馈层体量超预期，可把 T1+T2+T4（落点正确性）先合一个 PR、T3（纯视觉反馈）跟一个 PR，但 proposal 的"实时反馈"验收需两者齐活才算达成。

## 风险
- xyflow 默认磁吸与"自定义精准复用"的边界手感需实测微调（已列 T-V）；候选 2 提供几何兜底，降低"调不出手感"风险。
- 自定义 connectionLine / useConnection 在缩放下的坐标 —— 以屏幕像素为准，T-V 覆盖多 zoom。

## 实现状态（as-built，详见 design.md §实现纪要）

磁吸方案在实拖中被证伪 → 换为**真实预览端口注入 + 自定义连线**（见 design §实现纪要）。映射：

- **T1**（纯函数）✅ —— `classifyDropTarget`/`nextFreeInputPort`/`existingInputPorts` + 新增 `findNewInputTarget`（指针命中测试）。
- **T2**（磁吸）↩ 替换 —— 已有输入 handle `isConnectableEnd=false`（杜绝误吸已有端口）。
- **T3**（反馈）↩ 重做 —— `ConnectDropHint` 改注入器（往悬停节点注 `previewInputPort`）+ `PortHandles` 渲染真实预览端口 + 自定义 `connectionLineComponent` 把线尾连到该端口。
- **T4**（接线）✅ —— `handleConnect`（handle 落点，T4 去冲突）+ `onConnectEnd`（节点身上落点，命中测试补建）+ `connectHandledRef` 去重。
- **T-V**（手感）✅ —— dev server 与用户实拖验证：预览端口实时出现 + 连线吸附其上 + 松手建边一致。
- **精准复用 ✅** —— `connectResolve.ts`：`resolveDropTarget` = `findNewInputTarget`（命中节点）+ `nearestPort`（光标落在已有端口 8px 内才 reuse）；命中注入 `reuseInputPort` 高亮该端口（橙脉冲）+ 浮层徽标「复用输入」；松手替换该端口来源。四处（预览/线/onConnect/onConnectEnd）共用，口径一致。
- **坐标系** —— 命中用 `connection.to`（流图）；复用精度用客户端真实光标（`connectPointer`，对端口 `getBoundingClientRect`）；建边 `screenToFlowPosition`。详见 design §实现纪要。

测试：`dropTarget.test.ts`（`nextFreeInputPort`/`existingInputPorts`）/ `connect-drop-hint.test.ts`（`findNewInputTarget` 命中 + `nearestPort` 精度 + 源码锚点）/ `connect-preview-port.test.tsx`（新增预览端口 + 复用高亮渲染）。全量前端 vitest 2670 + typecheck×3 + lint + format 绿。dev server 与用户实拖确认新增/复用/切换/松手一致。
