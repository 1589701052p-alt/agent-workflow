# RFC-087 — 结构化 Diff 跨语言一致性（多语言适配）

状态：Draft（待用户批准）
关联：承接 RFC-083（结构化 Diff 可视化）及其收尾提交；并行参考 RFC-085（方法调用链）、RFC-086（方法内/匿名定义归属）。

## 背景

RFC-083 把 agent 节点执行前后的代码改动升级成「结构化叠加视图」（类协作图 + 引用/继承边 + 影响面），并在收尾提交里加了一批**语言敏感**的精修：

- `cdc3e7f` 引用匹配剥注释/字符串（消误报）
- `c403b5c` references 下游「按名匹配」被用到的方法
- `c9fcd27` 上游「调用方法起点」
- `bbebb8f` private 成员不再算「被外部使用」
- `7ebbb37` 方法行显示签名 + 按可见性分组
- `2b7360d` PR-G 类继承/构造/引用边

一次针对「这些精修是只修了 Java 还是全语言一起修」的代码审计（本仓 session 记录，逐项 file:line + 真实 tree-sitter parse 证据）得出结论：

> **代码层面是一套共享、语言无关的实现（没有 Java 专用分支），但其中的启发式是按 Java/TypeScript 的语法写的、也几乎只用 Java/TS 测过；对 Rust / C++ / JavaScript / Go / Python / Scala 留下了具体的、没有测试保护的正确性盲点。**

典型盲点（详证据见 `design.md`）：

| 语言 | 现存盲点 |
|---|---|
| Python | `#` 行注释**不剥**（被当成 JS 私有字段），注释/docstring 里的类名会误判成真引用；`__init__` 不识别为构造 |
| Rust | `impl Trait for S` 继承被误归 references；`Type::new()` 关联调用漏匹配；可见性正则无 `pub` 分支 → 私有 `fn` 误判 public，`bbebb8f` 私有门控失效 |
| C++ | `->` / `::` 调用漏匹配；成员方法基本不抽取；`public:`/`private:` 段标签进不到签名 → 全员默认 public，绕过私有门控 |
| JavaScript | 无可见性关键字 → 全默认 public；真正的 `#private` 字段被 query 漏掉 |
| Go | struct 内嵌 `type X struct { Base }` 误归 references；反引号 raw string 多行泄漏 |
| Scala | 三引号字符串 + 嵌套块注释泄漏；辅助构造 `def this` 不识别 |

此外有一处**事实上的 Java 专属**：构造函数作为下游入口点（`classGraph.ts` 的 `m.kind === 'constructor'`）只对 Java 生效，因为 `queries.ts` 里只有 Java 发出 `@def.constructor`。

## 目标

让 RFC-083 结构图的五条语言敏感能力——**注释/字符串剥离、成员可见性、构造函数归类、继承/内嵌边、调用起点匹配**——在 8 种受支持语言（python / go / typescript / javascript / java / rust / cpp / scala）上达到**一致的正确性**：

1. 注释 / 字符串里的标识符**任何语言**都不再被当作真引用（含 Python `#`、Go/JS/Scala 多行字符串、Rust/C++ raw string）。
2. 成员可见性在**任何语言**都按其语言机制正确判定（Rust `pub`、C++ 段标签、TS `accessibility_modifier`、JS/TS `#`、Java/TS 关键字、Python `_`/`__`、Go 大小写、Scala `private`），从而 `bbebb8f`「私有不算被外部使用」对所有语言成立。
3. 构造函数在 Java / TS / JS / Python / C++ / Scala 都被识别为 `constructor`（Rust 无此概念，保持普通关联函数）。
4. 继承 / 实现 / 内嵌关系在**任何语言**都被识别为 `inherits` 边而非 `references`（含 Go struct/interface 内嵌、Rust impl-for + supertrait、C++ 多基、Python 多基、Scala `with` 多 trait）。
5. 调用起点匹配覆盖各语言的成员访问算子（C++ `->`、Rust/C++ `::`、Go selector，以及现有 `.`）。

设计原则：**能用 tree-sitter 结构化拿到的，就不要用正则猜**；正则仅作兜底。

## 非目标

- 不做 deep / SCIP 精确跨文件影响面（那是 deep 模式 + RFC-085 的范畴）。
- 不引入 C/C++ 预处理器、不做类型推断 / 名称解析；跨文件「同名歧义」仍按现有启发式。
- 不改文本 unified diff、不改任务/worktree 生命周期。
- **不把 C++ / Scala 移出 `DEGRADED_LANGS`**：本 RFC 让它们「显著变好」，但预处理器/模板（C++）与 Scala-3 构造/嵌套块注释（Scala 0.20 grammar）仍不可靠，故保留 `degraded` 标记 + `confidence: 'inferred'`。
- 不做 DB 迁移（结构化 diff 是磁盘 JSON，新增字段一律可选、后向兼容）。

## 用户故事

- 作为用 **Rust** 仓的用户，结构图把 `impl Display for S` 显示为 S 继承/实现 Display 的边，且 `S` 的私有 `fn` 不再错误地标成「被其他类用到」。
- 作为用 **Go** 仓的用户，`type Dog struct { Base }` 在图里显示为 Dog 内嵌 Base 的继承式边；多行反引号 SQL 字符串里的类名不再变成假引用。
- 作为用 **Python** 仓的用户，docstring / `#` 注释里提到的类名不再连出假引用线；`__init__` 作为构造入口被正确高亮。
- 作为用 **C++** 仓的用户，类的成员方法和 `: public Base` 基类出现在图里（仍标注 degraded），`p->foo()` 调用能连到被调方法。
- 作为用 **JS/TS** 仓的用户，`#private` 字段/方法被收录并归到 private 分组，`constructor` 作为构造入口高亮。

## 验收标准（高层）

- 每种语言至少一组「正向 + 边界」断言覆盖上述 5 条能力（细化清单见 `plan.md` 验收清单 / `design.md` §测试策略）。
- 已有 Java/TS 行为零退化（现有结构化 diff 测试全绿）。
- `bun run typecheck && bun run test && bun run format:check` 全绿；单二进制 build smoke + e2e 不退化。
- 旧的磁盘 JSON 制品仍能被读回（`store.ts` `safeParse` 容旧字段缺失）。
