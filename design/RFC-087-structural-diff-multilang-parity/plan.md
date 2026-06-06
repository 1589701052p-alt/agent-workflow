# RFC-087 — 任务分解

状态：Draft（待批准）。每个子任务遵循「test-with-every-change」：实现 + 对应语言测试同 commit。

## 子任务

| ID | 标题 | 依赖 | 落点 |
|---|---|---|---|
| RFC-087-T1 | Schema 可选承载字段（`visibility` / `maskRanges` / `callSites`；继承复用 `symbolEdge`）+ zod 容旧单测 | — | `shared/src/schemas/structuralDiff.ts` |
| RFC-087-T2 | AST 注释/字符串掩码：extract 产出 `maskRanges`，classGraph 用掩码替换 `stripCommentsAndStrings` | T1 | `lang/extract.ts`、`classGraph.ts` |
| RFC-087-T3 | 结构化可见性 `SymbolNode.visibility`（8 语言）+ 前端 `memberVisibility` 优先读取 + 删 `kotlin` 死分支 + 私有门控回归 | T1 | `lang/extract.ts`(+`lang/visibility.ts`)、`frontend/src/lib/structureGraph.ts` |
| RFC-087-T4 | 构造函数归类（java 既有 / ts / js / python / cpp / scala；rust 不产） | T1 | `lang/extract.ts`、`lang/queries.ts` |
| RFC-087-T5 | 缺失抽取补齐：js/ts `#private`、cpp 成员方法 + 构造/析构、rust trait `function_signature_item` | T4 | `lang/queries.ts`、`lang/extract.ts` |
| RFC-087-T6 | 继承/内嵌边结构化（8 语言）+ assemble 归并（结构化优先，`isInheritance` 兜底） | T1,T5 | `lang/extract.ts`(+`lang/edges.ts`)、`assemble.ts`、`classGraph.ts` |
| RFC-087-T7 | 调用算子匹配：extract 产出 `callSites`（cpp `->`/`::`、rust `::`、go selector），classGraph 优先消费 + 正则兜底 | T1,T5 | `lang/extract.ts`、`classGraph.ts` |

并行度：T1 先行；T2/T3/T4 可并；T5 依赖 T4；T6/T7 依赖 T5。

## PR 拆分建议（默认一 RFC 一 PR，确需拆则三段）

- **PR-A**：T1 + T2 + T3（schema + 掩码 + 可见性）——独立可验、修复面最广（消误报 + 私有门控）。
- **PR-B**：T4 + T5（构造归类 + 抽取补齐）。
- **PR-C**：T6 + T7（继承/内嵌边 + 调用匹配）。

每 PR commit message 前缀 `feat(structuraldiff): RFC-087 ...`；body 只描述本人改动（多人 working tree：plan.md/STATE.md 若混入他人未提交改动，整文件 `git add` 但 body 仅写自己范围，绝不回退他人行；不主动 `git add` 他人未追踪文件如 `RFC-086/`）。

## 验收清单

- [ ] T1 zod：新字段缺失时旧 JSON `safeParse` 成功（`store.ts` 容旧）。
- [ ] T2：python `#`/docstring、go raw、js template、scala 三引号、rust/cpp raw 中的类名不产引用边（每语言一条）。
- [ ] T3：8 语言 `visibility` 正确；Rust/C++/JS 私有成员被引用时不进 `toMembers`（私有门控生效）；`kotlin` 死分支移除。
- [ ] T4：java/ts/js/python/cpp/scala 构造识别为 `constructor` 且作下游入口；rust `new` 非 constructor。
- [ ] T5：js/ts `#private` 收录；cpp 成员方法/构造收录；rust trait 方法签名收录。
- [ ] T6：go struct/interface 内嵌、rust impl-for/supertrait、cpp 多基、python 多基（滤 metaclass）、scala `with`、java/ts implements → `inherits`/`implements` 边。
- [ ] T7：cpp `->`、cpp/rust `::`、go selector 调用连到被调方法。
- [ ] 现有 Java/TS 结构化 diff 测试零退化。
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 build smoke。
- [ ] C++/Scala 仍标 `degraded`（本 RFC 不承诺移出 `DEGRADED_LANGS`）。
- [ ] push 后按 `feedback_post_commit_ci_check` 立刻查 GitHub Actions。

## 落档同步（批准后执行）

- 在 `design/plan.md` 「RFC 索引」表追加 RFC-087 行（状态 Draft→In Progress→Done）。
- 在 `STATE.md` 顶部加「进行中 RFC: RFC-087」一行；完工后状态改 Done 并在已完成表加一行。
- 多人协作：上述两文件当前含协作者未提交改动（RFC-086），登记时仅追加本人行，绝不动他人行。
