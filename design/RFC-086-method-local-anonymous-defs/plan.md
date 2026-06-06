# RFC-086 — 任务分解

> 状态：**Done**（2026-06-06 `/goal` 批准后实现并推送）。编号 `RFC-086-Tn`。PR-0〜PR-C 一并落地（main-only）；T6 的「深度模式 lambda 目标接口」按 D4 记录为后续增强（CI 不可验，匿名类已全覆盖）。

## 依赖前提

- RFC-083 已 Done（符号集 / `lang/extract.ts` / `classGraph.ts` / `buildStructureGraph` / 结构图四视图）——本 RFC 全部建立其上。
- 与 RFC-084 / RFC-085 并行无写冲突（各自只读/扩展 RFC-083 产物）；唯一需协调点：若决策 D1 选 (b)（具名嵌套函数升格子节点），"nested-in" 边语义须与 RFC-085 调用链对齐——届时在 design 补一节。
- **待用户拍板**：proposal 决策表 D1〜D5（尤其 D1 呈现激进度、D5 止血先行）。

## 阶段 0 —— 全语言止血（纯前端，消假类）

- **RFC-086-T0 — 前端容器解析重写**：`structureGraph.ts` 预扫 `qnKind` 映射 + `resolveContainer`（向上跳过 callable 段、绑定最近真实容器、否则 file 卡），替换 `memberContainer` 旧字符串切分。测试：§7 前端 `resolveContainer` 三例（Java anon 中段 / JS 嵌套函数 / 合法内部类不误伤）+ `buildStructureGraph` 集成断言「无 `GameFrame.setupGameTimer` 卡」。**不依赖后端，可独立合入。**

→ **PR-0**（T0）：全语言不再出现以方法名命名的假「类」卡片。

## 阶段 1 —— 后端 Java 匿名类捕获

- **RFC-086-T1 — shared schema**：`symbolNodeSchema` 加 `anonymous?: boolean`。测试：可选 + 旧 JSON 向后兼容。
- **RFC-086-T2 — Java 匿名类捕获 + extract**（依赖 T1）：`lang/queries.ts` 加 Java `object_creation_expression(+class_body)` 捕获；`lang/extract.ts` 取基类型叶子为 name、`anonymous=true`、放行空 name、qn=`<encl>.$<Base>`，使内部方法 re-parent 到匿名类。测试：真 wasm Java fixture（有/无基类型两路）+ `run().parentId` 断言。
- **RFC-086-T3 — 创建边**（依赖 T2）：`classGraph.ts`（或装配层）对每个匿名类节点显式补 `references` 边（from=最近真实外层类、to=匿名类、fromMembers=[外层方法 id]）。测试：边的 from/to/fromMembers 断言。

→ **PR-A**（T1+T2+T3）：后端产出 `«anonymous»` 节点 + 创建边（数据层）。

## 阶段 2 —— 前端匿名类呈现

- **RFC-086-T4 — `«anonymous» Type` 卡 + 徽标 + 边**（依赖 T0+PR-A）：`buildStructureGraph` 把 `anonymous` 节点单独成卡、title=`«anonymous» {name}`；`StructuralGraph.tsx` 匿名徽标样式（复用公共 class，不自写 chrome）；创建边走既有 `references` 渲染。落地决策 **D1**（默认 (a)：具名嵌套函数折叠为成员行）。测试：渲染 smoke（匿名卡标题 + 成员 `run()` + 创建边存在）+ 视觉对齐自查（与 /agents 等核心页 side-by-side）。

→ **PR-B**（T4）：用户可见——匿名类显示为 `«anonymous» TimerTask`、被 `setupGameTimer` 指向。

## 阶段 3 —— 推广其余语言 + 深度模式 + 噪音收敛

- **RFC-086-T5 — TS/JS class 表达式 + 其它语言局部类归属**（依赖 PR-B）：TS/JS 匿名 class 表达式捕获取 `extends` 基类；Python/Scala 局部具名类归属校验。测试：各语言 fixture。
- **RFC-086-T6 — 深度模式 lambda 目标接口（D4）+ 噪音收敛规则**（依赖 T5）：SCIP 可用时补 lambda 目标接口为匿名节点；定「哪些方法内定义上图」的收敛规则（如仅 implements/extends 具名类型者）。测试：SCIP fixture（stub）+ 收敛规则 PURE 断言。

→ **PR-C**（T5+T6）：全语言覆盖 + 深度增强 + 噪音可控。

## PR 拆分建议

| PR   | 含       | 交付                                       |
| ---- | -------- | ------------------------------------------ |
| PR-0 | T0       | 全语言止血：消假「类」卡（可先行合入，D5） |
| PR-A | T1+T2+T3 | 后端匿名类节点 + 创建边（数据层）          |
| PR-B | T4       | 前端 `«anonymous» Type` 卡 + 创建边呈现    |
| PR-C | T5+T6    | 其余语言 + 深度模式 lambda + 噪音收敛      |

每个 PR commit 前缀 `feat(scope): RFC-086 ...`（PR-0 可为 `fix(frontend): RFC-086 ...`）；均需全绿门槛（typecheck/test/format，动 shared/后端加 `build:binary` smoke）。

## 验收清单

- [x] T0：结构图不再出现以方法限定名命名的 `class` 卡（Java anon / JS 嵌套函数 / Python 闭包）；合法内部类 `Outer.Inner` 不误伤。
- [x] T1：`anonymous` 可选、旧响应向后兼容。
- [x] T2：Java `new TimerTask(){…}` → `anonymous=true`、`name='TimerTask'` 节点 + `run().parentId` = 该节点；取不到基类型 → `name=''`。
- [x] T3：匿名类 `references` 创建边 from=外层真实类、fromMembers=[外层方法]。
- [x] T4：匿名类显示 `«anonymous» TimerTask`、含 `run()`、被 `setupGameTimer` 指向；视觉与核心页一致。
- [x] T5：TS/JS class 表达式（`(class !name)` extends 取基类）+ 其它语言局部类正确归属。
- [x] T6（部分）：噪音收敛 = D1(a) 具名嵌套函数折叠（T0 实现）。**深度模式 lambda 目标接口按 D4 记录为后续增强**（CI 不可验，匿名类已全覆盖）。
- [x] 全程门槛全绿；CI 三项 + 单二进制 smoke + e2e 绿（按 [feedback_post_commit_ci_check]）。

## 风险 & 缓解

| 风险                                   | 缓解                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| 误伤合法内部类（`Outer.Inner.method`） | `resolveContainer` 只跳过**已知 callable** 段、保留 class 段；专门加「内部类不误伤」回归测试 |
| 匿名类捕获改 query 影响既有抽取        | 匿名模式只在带 `class_body`/无名 class 时匹配；真 wasm fixture 锁既有符号零回归              |
| 噪音（决策 D1 选 b / 闭包过多）        | 默认 (a) 折叠；(b) 须配收敛规则；与 RFC-085 协调                                             |
| 改 shared/后端破单二进制               | 动 shared/后端必跑 `build:binary` smoke（[reference_binary_build_module_cycle]）             |
| 多人树共享索引冲突                     | 仅追加自己的 plan/STATE/索引行，不动他人条目（含 RFC-084/085）                               |
