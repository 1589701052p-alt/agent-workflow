# RFC-003 Plan — 实施分解

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)

## 任务分解

按依赖序列，建议单 PR 提交（前端纯 UI 改动，无后端 / schema 变更，预计 < 600 LoC）。

| 编号 | 标题 | 范围 | Size | Deps |
| --- | --- | --- | --- | --- |
| RFC-003-T1 | PortHandles 加 catch-all | `nodes/PortHandles.tsx` 加 `catchAll?: { id }` prop；`nodes/types.ts` 导出 `INBOUND_HANDLE_ID = '__inbound__'`；`styles.css` 加 `.canvas-node__handle--catchall` + z-index 约束 | XS | — |
| RFC-003-T2 | 节点开关 catch-all | `AgentNode.tsx` 左侧传 catchAll；`WrapperNodes.tsx` 的 LoopWrapperNode 同样；GitWrapperNode / InputNode / OutputNode 不动 | XS | T1 |
| RFC-003-T3 | onConnect 转译 | `WorkflowCanvas.tsx` 的 `handleConnect` 在 `targetHandle === INBOUND_HANDLE_ID` 时把 targetHandle 替换为 sourceHandle，再走 `buildEdgeFromConnection` | XS | T1 |
| RFC-003-T4 | selection union + onEdgeClick | `WorkflowCanvas.tsx` 把 onSelect 接口升级为 `(CanvasSelection|null)`；接 `onEdgeClick`；`onSelectionChange` 在 `(0 node, 1 edge)` 时也吐 edge 选择；编辑器路由相应消费 | S | — |
| RFC-003-T5 | EdgeInspector | 新建 `EdgeInspector.tsx`；编辑器路由根据 `selection.kind` 互斥渲 NodeInspector / EdgeInspector；4 条 i18n key | S | T4 |
| RFC-003-T6 | NodeInspector MissingRefList | `NodeInspector.tsx` agent 分支 PortRefList 下方加 MissingRefList；2 条 i18n key | XS | — |
| RFC-003-T7 | 前端单测 | `canvas-port-handles.test.tsx` 扩 4 case；`canvas-connect.test.tsx` 新 4 case；`canvas-edge-inspector.test.tsx` 新 4 case；`canvas-missing-refs.test.tsx` 新 4 case | S | T1–T6 |
| RFC-003-T8 | 手工 QA + CI gate | design.md §8.3 全 8 条跑一遍；`bun run typecheck && bun test`；commit + push 后 GitHub Actions 全绿（按 [[feedback_post_commit_ci_check]]） | XS | T1–T7 |

总计预估：~0.5–1 个工作日。

## PR 拆分建议

**单 PR**。理由：

- T1（PortHandles 加 catch-all）单 merge 后没人引用 → dead style；
- T3（onConnect 转译）依赖 T1 才能产生效果；
- T4（selection union）改 onSelect 签名，不与 T5 一起 merge 会破坏现编辑器 inspector 容器；
- T5（EdgeInspector）依赖 T4；
- T6（MissingRefList）独立但属同一 RFC scope，合并审稿更高效；
- 总改动量 ~540 LoC，单 PR 仍在可审范围。

PR 标题：`feat(editor): RFC-003 catch-all input handle + edge inspector`。

Commit message（HEREDOC）参考：

```
feat(editor): RFC-003 catch-all input handle + edge inspector

Per design/proposal.md §3.5/§4.2/§4.3, an agent node's input ports are
the by-product of edges, not pre-declarations. The current canvas only
renders a left-side handle for ports that ALREADY have an inbound edge,
making the first edge into a brand-new agent node impossible to drag.

Fix:
- PortHandles renders an extra invisible target Handle covering the
  full left edge when `catchAll` is passed; AgentNode + LoopWrapperNode
  enable it. Named handles keep z-index priority for fan-in drops.
- WorkflowCanvas's onConnect translates `__inbound__` into the source
  port name (the design's default for target.portName).
- New EdgeInspector lets users rename `target.portName` after the fact
  (covers the design.md:510 `in.out → worker.requirement` case).
- NodeInspector adds a MissingRefList showing template `{{x}}` refs
  that have no inbound edge — UI mirror of P-2-01 backend validation.

No backend or schema changes; old workflows load unchanged.
```

## 验收清单

实现完成时必须满足：

- [ ] `design/RFC-003-canvas-input-port-wiring/` 三文档齐全
- [ ] `bun run typecheck` 全绿
- [ ] `bun test` 全绿（含 RFC-003 新增 PortHandles + connect + EdgeInspector + MissingRefList 单测）
- [ ] 手工 QA 8 条断言全部通过（design §8.3）
- [ ] `STATE.md` 追加 RFC-003 已完成条目
- [ ] `design/plan.md` RFC 索引表登记 RFC-003 = Done
- [ ] commit + push 后 GitHub Actions 全绿（按 [[feedback_post_commit_ci_check]]）

## 风险跟踪

| 风险 | 兜底 |
| --- | --- |
| catch-all `<Handle>` 与具名 handle 命中冲突 | DOM 顺序：catch-all 先；CSS z-index 具名 handle = 1 / catch-all = 0；单测 case 3 断言 |
| onConnect 在 `targetHandle === null` 时（旧浏览器 / xyflow 边缘 case）误转译 | 转译条件严格 `=== INBOUND_HANDLE_ID`；非该字符串保持原样，buildEdgeFromConnection 已经会拒掉 null/empty |
| selection union 升级破坏编辑器路由现有 onSelect 调用 | T4 同步改路由；类型保证（discriminated union）让 TS 编译失败暴露遗漏调用方 |
| EdgeInspector 改名时同 source 同 target portName 已存在另一条边 | EdgeInspector 内 `commit` 检测重复，红字提示，不写 onChange |
| MissingRefList 与现有 PortRefList 视觉冲突 | 同 css class，间距按 inspector__port-refs 既有规则；不引入新组件 |
| catch-all 让用户产生"任何节点都能落"的错觉 | 仅 agent / wrapper-loop 启用；wrapper-git / input / output 显式不传 catchAll；视觉上没差异（catch-all 透明），不会误导 |
| 老 e2e 测试用 ARIA / role=button 选定节点时多了 hidden `<Handle>` 命中 | aria-hidden="true"；如有失败按测试报告调整 selector，不改组件语义 |

## 后续工作（非本 RFC）

- output 节点 bindings 也升级为可拖线（要先确定 binding ↔ edge 二元映射的运行时语义；改造范围更大）—— 单独 RFC。
- EdgeInspector 加"反转 source/target"按钮（design.md:573 提及）—— 单独 issue。
- MissingRefList 的 chip 双击直接定位到对应 source 节点 —— 编辑器 ergonomics，单独 issue。
- catch-all 视觉化（hover 时高亮左侧条带）—— 增强但非必要，单独 issue。
