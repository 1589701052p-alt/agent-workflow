# RFC-106 — 技术设计

## 现状机制（实现依据，已读源码核对）

- **入口 handle 渲染** `components/canvas/nodes/PortHandles.tsx`：`side==='left'` 时渲染
  - 一个铺满左缘的隐形 catch-all `<Handle type="target" id="__inbound__">`（`canvas-node__handle--catchall`，z-index 0）；
  - 每个已有输入端口一行 `<Handle type="target" id={portName}>`（`canvas-node__handle`，z-index 1，命中优先）。
  - 注释明言"Named handles take hit priority (z-index 1 > 0) so fan-in drops still hit the precise port" —— 正是本 RFC 要改的默认。
- **落点 → 端口名** `WorkflowCanvas.translateInboundConnection(conn)`：落在 `__inbound__` 上时把 `targetHandle` 改写成 `sourceHandle`（即新端口名 = 来源输出口名）；落在具名 handle 上则保持该端口名（复用）。
- **建边** `WorkflowCanvas.buildEdgeFromConnection(def, conn)`：仅拦截**完全相同**的四元组重复边；不阻止不同来源落到同一 (node, port)。
- **output 节点歧义消解** `connectionSync.applyConnectionForReviewOutput`：catch-all 落到 output 时若端口名已占用，自动 `_2/_3` 追加，使 output 收集多路。
- **ReactFlow 接线** `WorkflowCanvas.tsx`：用了 `onConnect` / `isValidConnection`，**未**用 `onConnectStart/End`、`connectionLineComponent`、`connectionRadius`、`useConnection` —— 即当前完全是 xyflow 默认拖拽预览。

## xyflow v12 能力（context7 核对 v12.10）

- `useConnection(): ConnectionState | null` —— 拖拽中实时状态，含 `inProgress / isValid / fromNode / fromHandle / toNode / toHandle / toPosition / pointer`。`toNode`+`toHandle` 即"当前吸附到哪个节点的哪个 handle"，是反馈的数据源。
- `connectionLineComponent`：自定义连线组件，入参含 `toNode / toHandle / connectionStatus`。
- `onConnectStart(e, {nodeId, handleId, handleType})` / `onConnectEnd(e)`；CSS 类 `.react-flow__connection.valid/.invalid`、handle 的 `connectingfrom/connectingto`。
- `connectionRadius`（默认 20）：全局磁吸半径。

## 设计总览

三块，互相解耦：

### A. 判定纯函数（单一事实源，驱动"反馈"与"落点"两端一致）

新增 `components/canvas/dropTarget.ts`：

```ts
export type DropClassification =
  | { kind: 'new'; nodeId: string; portName: string }     // 新输入端口（catch-all 落点）
  | { kind: 'reuse'; nodeId: string; portName: string }   // 复用已有输入端口
  | { kind: 'none' }                                       // 不是"落到已存在节点的入口"——交给既有 channel/其它路径

// ConnLike 用**归一化的字符串 handle id**（Codex P2）—— `onConnect` 给的是 string id，而
// `useConnection()` 给的 fromHandle/toHandle 是 xyflow `Handle` 对象，预览侧调用前必须读 `.id`
// 归一化，否则要么 typecheck 挂、要么预览永远匹配不上。
export interface ConnLike {
  source: string | null        // 来源节点 id
  sourceHandle: string | null  // 来源输出口名
  target: string | null        // 目标节点 id
  targetHandle: string | null  // 目标 handle id（端口名 / '__inbound__' / 系统 handle）
}
// 规则（**次序要紧**，Codex P2）：
//   1. source/target/handle 任一为空，或 source===target（自连）     → none
//   2. **先查目标节点 kind**：非 agent-single 且非 output 一律 → none
//      （wrapper-loop/git/fanout 也注册了 '__inbound__' catch-all，但本特性范围只含
//        agent+output；review/fanout 走各自既有路径）
//   3. targetHandle === '__inbound__'（catch-all）                 → new（见「唯一端口名」）
//   4. targetHandle 形如 /^__.+__$/（系统 handle：__clarify_response__ /
//      __external_feedback__ / __noop_top__ 等）                   → none
//   5. targetHandle 命中目标的某个现有输入端口名                     → reuse 该端口
//   6. 其余                                                        → none
export function classifyDropTarget(def: WorkflowDefinition, conn: ConnLike): DropClassification

// 唯一端口名（Codex 设计 gate P1 —— 修核心漏洞）：catch-all 落点的 portName 不能直接
// 取「来源输出口名」。computePorts 把入口端口按「入边目标端口名去重」推导，所以若两个上游
// 都暴露 `result`/`out`，沿用旧的 `targetHandle = sourceHandle` 会让第二条边又落到同一个
// `C.result` —— 正是本 RFC 要消灭的误连。因此 `new` 分支必须对**所有 catch-all 节点**算一个
// 在「该目标节点现有输入端口集合」里唯一的名字：
export function nextFreeInputPort(existingInputPorts: string[], desired: string): string
//   desired 不冲突 → desired；否则 desired_2 / desired_3 …（把 output 专用的 _2/_3 逻辑
//   从 applyConnectionForReviewOutput 上提为这条通用纯函数，agent / output 共用，去重复）。
```

- 该函数**同时**被：(1) 反馈层读取以渲染"新输入/复用"提示；(2) `onConnectEnd`/`handleConnect` 用于决定建什么边。两端用同一函数 ⇒ 验收标准"预览与落点一致"天然成立。
- `none` 分支保证 clarify/cross 拖拽、review/fanout 专用输入路径、"拖到空白新建节点"等不被本特性改变。

### B. 命中优先级反转 + "复用小磁吸"

目标：节点入口区默认命中 catch-all（新输入）；只有**精准**压到某个已有端口点上才命中具名 handle（复用）。

- **优先级反转**：把 catch-all 提到默认命中层，具名输入 handle 退为"需精准"。两条候选实现，实现期二选一（以手感为准，plan 列验证步骤）：
  1. **缩小具名 handle 命中区**（首选，最贴 xyflow 习惯）：给已有输入 handle 的 `.react-flow__handle` 命中盒显著缩小（如 6px 圆点、`pointer-events` 命中区不放大），catch-all 维持铺满左缘；配合**降低全局或该侧 `connectionRadius`** 让磁吸更"短"。这样指针离端口点稍远即落入 catch-all。
  2. **自定义落点判定兜底**：若纯靠 handle 尺寸/radius 调不出稳定手感，则在 `onConnectEnd` 用 `pointer` 坐标对每个已有输入 handle 的包围盒做"精准半径内才算 reuse"的几何判定，绕开 xyflow 默认吸附 —— 仍复用 `classifyDropTarget` 的语义。
- **样式**：新增 `canvas-node__handle--reuse`（小、需精准）与 catch-all 的 hover/active 态；命中复用时端口行加 `--reuse-target` 高亮。全部走既有 `styles.css` 的 canvas-node 命名空间，不自写孤立 CSS。

> z-index：把当前"具名 > catch-all"的命中优先级，在视觉/命中层面调整为"入口区默认 catch-all、端口点精准命中"。具体用 z-index 还是命中盒尺寸由候选 1 决定；不破坏既有端口点的连线锚定（已连边仍精准落在端口点上）。

### C. 实时反馈渲染

- 用 `useConnection()` 取 `inProgress / fromHandle / toNode / toHandle`，经 `classifyDropTarget` 得 `{kind,nodeId,portName}`。
- **目标节点高亮**：给 `toNode` 对应的 canvas 节点加 className（如 `is-connect-target` + `is-connect-reuse`/`is-connect-new`），CSS 描边/底色区分。实现可用一个挂在 ReactFlow 内的轻量组件 `ConnectDropHint`（消费 `useConnection`，把状态写进一个 context / 直接渲染浮层），或自定义 `connectionLineComponent` 在连线端渲染"新输入/复用同一输入"徽标。
- **连线状态**：复用 xyflow 的 `valid/invalid` class；额外用 `kind` 区分"新/复用"的颜色或徽标文案（i18n key：`canvas.connect.newInput` / `canvas.connect.reuseInput`）。
- 文案走 i18n（en/zh 两份），不硬编码。

## 实现纪要（as-built —— 与上文 A/B/C 设计的偏差，已在 dev server 与用户实拖验证）

上文的"磁吸 + 浮层徽标"方案在真机拖拽中**被证伪并替换**。关键事实：**xyflow 按"指针到各 handle 中心的距离"选落点**，而铺满左缘的 catch-all 其中心在节点纵向正中——所以拖到节点上半/下半时，最近的反而是那一行的具名小圆点，`connectionRadius` 怎么调都救不了"默认新输入"。浮层徽标也答非所问：用户要的是**把真实的新端口画在节点上、连线连上去、与松手一模一样**，不是飘在外面的提示。最终落地的方案如下：

1. **`findNewInputTarget(def, boxes, point, srcNode, srcHandle)`（纯，`dropTarget.ts`）**——用**指针对节点包围盒做命中测试**（不依赖 xyflow 的 `toNode`，它只在指针压在 handle 上才有值），返回悬停的 agent/output 节点 + 去冲突后的新端口名（`nextFreeInputPort`）。预览与建边两端共用它 ⇒ 所见=所得。
2. **已有输入 handle `isConnectableEnd=false`（PortHandles）**——杜绝 xyflow 把拖拽误吸到已有端口（即"连到已有节点上"的根因）。已连边仍锚定在这些 handle 上（该开关只挡**新**连线落点）。
3. **`ConnectDropHint` = 注入器（非浮层）**——消费 `useConnection`，算出悬停目标 + 新端口名，经画布的 **`setNodes`**（受控节点，走 `onPreviewChange` 回调，**只进 node.data、绝不进 definition**，松手即清）把 `previewInputPort` 注入悬停节点。`PortHandles` 据此渲染一行**真实的、可连的预览端口**（`--preview` 仅加淡色+脉冲，形态与真端口一致）。
4. **自定义 `connectionLineComponent`**——在拖拽中把连线尾**精确画到预览端口 handle 的 DOM 位置**（`findNewInputTarget` 解析目标 + `querySelector(data-handleid)` 取屏幕坐标 → `screenToFlowPosition`），over 空白/非目标则退化为跟随指针的 bezier。⇒ 飞行中的线 === 松手后的边。
5. **建边两路**：落在 handle 上 → `onConnect`/`handleConnect`（沿用 T4：`classifyDropTarget` 给 agent catch-all 算去冲突名）；落在**节点身上**（无 handle 命中）→ `onConnectEnd` 用 `findNewInputTarget` 命中测试补建。`connectHandledRef` 去重，二者只触发其一。
6. **`classifyDropTarget` 保留**——仍是 handle-drop 路径（T4）的 new/reuse/none 判定；上文 §A 的规则与 Codex P1/P2 修正全部生效。

**精准复用（reuse）—— 已实现**（`connectResolve.ts`）：`resolveDropTarget` 在 `findNewInputTarget` 命中节点后，再用 `nearestPort`（纯）判断光标是否落在某个**已有输入端口圆点的小半径内**（`REUSE_RADIUS_PX=8` 屏幕像素）——落在就 `reuse` 该端口、否则 `new`。命中复用时注入 `data.reuseInputPort` 高亮该已有端口行（橙色 `--reuse-target` 脉冲，区别于新增的主题色脉冲），浮层徽标显示「复用输入 · 端口名」；松手把该端口的来源**替换**为新边（先滤掉旧入边）。预览 / 连线 / `onConnect` / `onConnectEnd` 四处都过 `resolveDropTarget`，口径一致。

**坐标系（踩坑实录，务必照搬）**：xyflow 的 `connection.to`/`pointer`/`event` 坐标系是关键，搞错就全黑：
- **节点命中测试**用 `connection.to`（React 层是**流图坐标**），喂 `findNewInputTarget`（与 `getNodeBoxes` 的 `positionAbsolute` 同系，Codex P2：包装节点必须用绝对坐标）。
- **精准复用判定**用**客户端坐标**的真实光标（画布在 `onConnectStart..End` 期间 `document` 上跟踪 `e.clientX/clientY` 进 `connectPointer` ref），与端口 `getBoundingClientRect`（同为客户端坐标）比；**不能**用 `connection.to`——它被 xyflow 吸附到 catch-all 句柄（节点中点）会误判复用，且与建边用的客户端光标打架。`connection.pointer` 是容器相对的屏幕坐标、不是流图坐标，直接当流图用会让命中测试全失效（本 RFC 实现期踩过）。
- **建边**：落 handle → `onConnect`（读 `connectPointer`）；落节点身上 → `onConnectEnd`（读 `event.clientX/Y`）；二者都 `screenToFlowPosition` 做命中、客户端坐标做复用，`connectHandledRef` 去重。
- 通道拖拽（clarify/cross）：`findNewInputTarget` 对 `__clarify__` 源口 / clarify·cross 源节点直接返 `null`（Codex P1：杜绝通道拖拽误建普通边）。

> 测试：纯函数 `findNewInputTarget`/`nextFreeInputPort`/`existingInputPorts`/`classifyDropTarget`（`dropTarget.test.ts`）+ 预览端口渲染（`connect-preview-port.test.tsx`：注入 `previewInputPort` → 真实端口行 + 可连 handle）+ 接线源码锚点（`connect-drop-hint.test.ts`：注入器/onConnectEnd/connectionLineComponent 三者均经 `findNewInputTarget`）。

## 接口契约与改动点

- 新增 `dropTarget.ts`（纯）：`classifyDropTarget` + 类型。
- `PortHandles.tsx`：具名输入 handle 加"小/精准"class；catch-all 命中默认化。Props 公共 API 不变。
- `WorkflowCanvas.tsx`：挂 `onConnectStart/End`（或仅渲染 `ConnectDropHint` + 自定义 connectionLine）；`handleConnect` 的通用路径改为先 `classifyDropTarget`，按 `new/reuse` 决定 `translateInboundConnection`/直接建边（行为与现状对齐，只是判定收口到纯函数）。**保持** clarify/cross 两个 classifier 在最前（次序不变）。
- `styles.css`：`canvas-node__handle--reuse` / `is-connect-target` 等。
- i18n `en.ts` / `zh.ts`：两个连接提示 key。

## 失败模式 / 边界

- **clarify/cross channel**：`classifyDropTarget` 在系统 handle 上返回 `none`，且 `handleConnect` 里两个 channel classifier 仍在最前 —— channel 拖拽零改动（含刚落地的 false-root guard）。
- **wrapper-fanout 边界边**：`markBoundaryWrapperInput/Output` 仍在建边后执行；`new/reuse` 只影响目标端口名，不影响 boundary 标记。
- **output 多路收集**：`new` 落点经 `applyConnectionForReviewOutput` 仍 `_2/_3` 消歧；`reuse` 精准落到已有 output 端口则替换其来源 —— 反馈如实显示二者。
- **catch-all 与具名 handle 重叠区**：候选 1 靠命中盒尺寸/radius 收敛；万一某缩放比例下仍抖动 → 候选 2 几何判定兜底。
- **触控板/缩放**：磁吸半径以"屏幕像素"为准，受 zoom 影响；验证步骤覆盖不同 zoom。

## 测试策略（必写 case）

- **纯函数** `dropTarget.test.ts`：**两个同名输出落 agent catch-all → 两个不同输入端口**（核心误连修复锁，P1）、catch-all→new、具名→reuse、review/fanout 专用输入→none、系统 handle→none、自连/空 toNode→none、output 端口冲突→`nextFreeInputPort` 消歧、来源口名透传；`nextFreeInputPort` 单测（无冲突原样 / 冲突 `_2`/`_3` / 连续占用跳号）。
- **PortHandles**：渲染断言 —— 已有输入 handle 带 `--reuse`/小磁吸 class；catch-all 仍存在；`getByTitle`/role 锚点。
- **WorkflowCanvas 接线**：源码文本断言 —— `handleConnect` 通用路径调用 `classifyDropTarget`；两个 channel classifier 仍在其之前（次序锁，类似 RFC-056 的 `canvas-cross-clarify-wiring` 锁）。
- **反馈层**：`ConnectDropHint`/connectionLine 组件在 `inProgress` + reuse/new 下渲染对应 i18n 文案（role/text 断言）。
- **回归**：现有 `canvas*.test.ts` / clarify 拖拽测试全绿。
- **手动验证**（plan T-V）：dev server 拖拽，多 zoom 下确认"新输入默认 + 精准复用"手感，截图与 /agents 等核心页风格自查。

## 与既有约定的一致性

- 复用公共组件/样式（canvas-node 命名空间、i18n、既有 handle 渲染器），不落原生孤立 CSS（遵守"前台界面统一风格"硬规）。
- 判定收口为纯函数 + 源码锚点兜底（遵守"test-with-every-change"的可断言面优先）。
