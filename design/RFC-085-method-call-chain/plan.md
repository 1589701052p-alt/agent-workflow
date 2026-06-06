# RFC-085 — 任务分解

> 状态:Draft（需求四轮澄清定稿）。**未经用户批准不进入实现**。编号 `RFC-085-Tn`。

## 依赖前提

- RFC-083 Done(符号集 / `collectClassMembers` / 深度 SCIP / `stripCommentsAndStrings` / 8 语言 tree-sitter / 结构页四视图)。本 RFC 全建其上。
- 与 RFC-084(conformance-auditor）并行无冲突。

## 阶段 1 —— 调用树 MVP（点改动方法 → 它直接调了谁）

- **RFC-085-T1 — shared schema + 可用标记**：`callTargetSchema`（§1.1）；`StructuralDiff.callChainAvailable: boolean`（default false，向后兼容）。测试：schema parse + 旧响应向后兼容。
- **RFC-085-T2 — 后端懒展开服务**（依赖 T1）：`structuralDiff/callGraph/`——`extractCalls`（PURE，有序收集方法+`new`，复用 RFC-083 parse/strip）+ 目标解析阶梯（this/self、field-type、`new T`、external、unresolved）+ 轻量 `类名→文件` 浅扫索引（缓存）+ 按需读/parse worktree 文件穿透未改动。测试：§6 后端 PURE 全套 + 真实 git 仓多语言 fixture（含一个动态语言验 unresolved）。
- **RFC-085-T3 — 端点**（依赖 T2）：`GET /api/tasks/:id/call-targets?scope=&methodRef=`（node/wrapper scope 复用 RFC-083 解析）+ contract registry + `callChainAvailable` 接入 service。测试：200 形状 + scope 校验 + 无根空态。
- **RFC-085-T4 — 前端调用树视图**（依赖 T1，可与 T2/T3 并行用 mock）：`lib/callChain.ts`（根 + 直接被调，默认 1 层）+ `<CallChainView>`（第 5 标签）+ 树/关系图改动方法行的**小入口图标** → `onOpenCallChain(ref)`。测试：纯函数 + 入口触发 + 渲染 smoke + 空态。

→ **PR-A**（T1-T4）：点改动方法 → 第 5 标签以它为根、列出直接被调（resolved 精确 / external / unresolved 灰显），默认 1 层。

## 阶段 2 —— 递归懒展开

- **RFC-085-T5 — `▸` 懒展开 + 环/截断**（依赖 T4）：点 `▸` 对节点 `ref` 调端点取下一层（含穿透未改动文件）、填 children 缓存；环检测、深度/节点上限、`external`/`unresolved` 叶子化。测试:懒展开、环检测、截断、叶子化。

→ **PR-B**（T5）：多层调用链可逐级展开，穿透未改动代码。

## 阶段 3 —— 时序图

- **RFC-085-T6 — 时序图数据预言**（依赖 T5，PURE）：调用链 → 有序消息流（lifeline 按 `ownerClass` 去重、消息按 order、depth/激活）。测试：PURE 顺序/去重断言。
- **RFC-085-T7 — 时序图渲染**（依赖 T6）：design §3.3 选 mermaid（方案 A）或自绘 SVG（方案 B）——**实现前用 ExitPlanMode/询问定方案**；`<SequenceDiagram>` + 调用链树↔时序图切换。测试：渲染 smoke（lifeline 数 + 消息数）+ 视觉对齐自查；若引 mermaid → `build:binary` smoke 验前端依赖不破单二进制。

→ **PR-C**（T6+T7）：时序图视图。

## PR 拆分建议

| PR | 含 | 交付 |
| --- | --- | --- |
| PR-A | T1-T4 | 点改动方法看直接被调（精确 + 未解析灰显），默认 1 层 |
| PR-B | T5 | `▸` 递归懒展开，穿透未改动 |
| PR-C | T6+T7 | 时序图 |

每 PR commit 前缀 `feat(scope): RFC-085 ...`；全绿门槛（typecheck/test/format，动 shared/后端加 build:binary）。

## 验收清单

- [ ] T1：`callTargetSchema` + `callChainAvailable`，旧响应向后兼容。
- [ ] T2：`this/self.foo`/`foo`→当前类；`field.foo`（静态类型）→`T.foo`(`resolved`)；`new T`→构造；类在表外→`external`；动态语言 `recv.foo`/链式/接口→`unresolved`；`order`=源码序；注释/字符串调用被排除；穿透到未改动文件可解析。
- [ ] T2：8 语言抽调用；真实 git 仓 Java+TS 链较全、Python 多 unresolved 断点——均不崩、断点标注。
- [ ] T3：`call-targets` 端点形状/scope/空态；node/wrapper scope 复用 RFC-083。
- [ ] T4：点改动方法行入口图标 → 第 5 标签以它为根；默认 1 层；resolved/external/unresolved 三态样式；无根空态；不覆盖原有点行（跳 hunk/高亮）。
- [ ] T5：`▸` 懒展开下一层（含未改动）；环检测不死循环；深度/节点上限标"已截断"。
- [ ] T6：链 → 有序消息流，lifeline 去重、消息按序。
- [ ] T7：时序图渲染 smoke；方案经用户确认；引依赖则单二进制 smoke 过。
- [ ] 深度 SCIP 不可用自动回退启发式，视图不崩、标"基线精度"。
- [ ] 全程门槛全绿；CI 三项 + e2e 绿。

## 风险 & 缓解

| 风险 | 缓解 |
| --- | --- |
| 动态语言（Py/JS）链多断点 | 接受：尽力而为 + 断点灰显（用户已定）；深度 SCIP 装了则精确 |
| 懒展开多次 parse 慢 | 默认 1 层 + 结果缓存 + 类名→文件浅扫（不全量 parse）+ 深度/节点上限 |
| 跨文件类型解析弱 | 三档 resolved/external/unresolved，宁缺毋滥、不臆造 |
| 时序图渲染/依赖 | 数据与渲染解耦（T6 数据、T7 渲染）；mermaid vs 自绘待拍板 + 单二进制 smoke |
| 穿透全仓打开任意文件 | 复用 `MAX_ANALYZE_BYTES` + 失败标"不可展开"，不阻塞整条链 |
