# RFC-087 — 技术设计：结构化 Diff 跨语言一致性

> 所有 tree-sitter 节点类型名均来自对本机 `tree-sitter-wasms`（~0.20 era）grammar 的**真实 parse 探测**（本 session 工作流逐语言跑过 `parseSource` 打印 s-expression）。节点名可能与最新文档不同——以探测结果为准。实现期落地任一 query / extract 逻辑前，须按 §测试策略对相应 grammar 复跑一遍探测。

## 1. 现状与根因

三处共享启发式（语言无关代码，但按 C 系/Java/TS 语法写）：

- `packages/backend/src/services/structuralDiff/classGraph.ts`
  - `stripCommentsAndStrings`（:88）——手写 C 系词法器：只认 `//`、`/* */`、单行 `"`/`'`/`` ` ``；`#` 明确不剥（:86-87）；换行强制结束字符串（:124）→ Python `#`、Go/JS/Scala 多行串、Rust/C++ raw 串全部泄漏。
  - `isInheritance`（:157-166）——3 条正则：`extends|implements`、Python `class X(Base)`、C++ `: public Base {`；只看类声明前 3 行（:225）→ Go 内嵌、Rust `impl..for`/supertrait 漏判。
  - `usedMembersAndCallers`（:277-313）——`\.(name)\b` 点号正则 → 漏 C++ `->`、Rust/C++ `::`。
- `packages/frontend/src/lib/structureGraph.ts`
  - `memberVisibility`（:54-70）——关键字正则无 `pub`（Rust）、无 C++ 段标签来源、无 JS/TS `#`；末行还有 `kotlin` 死分支（kotlin 不是受支持 LangId）。
  - `externallyUsable`（:413）——依赖 `memberVisibility`；可见性判错则私有门控（`bbebb8f`）失效。
- `packages/backend/src/services/structuralDiff/lang/queries.ts`
  - JS 字段 query 用 `property_identifier` → 漏 `#private`（`private_property_identifier`）。
  - C++ 不抽取成员方法；Rust 不抽取 trait 方法签名（`function_signature_item`）。
  - 仅 Java 发 `@def.constructor`。

根因统一：**用正则在“扁平文本/签名字符串”上猜语言结构**，而这些信息在 tree-sitter 语法树里都是结构化、可精确读取的。

## 2. 设计原则

能结构化就结构化：把可见性、构造归类、继承/内嵌边、调用点、注释/字符串掩码**在 extract 阶段（已经 parse 过一次）一次性算出来**，作为数据流过 `assemble → classGraph/structureGraph`；正则降级为「结构化数据缺失时的兜底」。C++/Scala 在结构化拿不到的部分（预处理器/模板/嵌套块注释/char literal）保留正则兜底 + degraded 标记。

## 3. 改动分解（6 个工作流）

### W1 — Schema：新增可选承载字段（后向兼容，无迁移）

`packages/shared/src/schemas/structuralDiff.ts`：

- `symbolNodeSchema` 加 `visibility: z.enum(['public','protected','package','private']).optional()`。
- `fileStructuralDiffSchema` 加 `maskRanges: z.array(z.object({ start: int, end: int })).default([])`——该文件 NEW 内容里所有 comment + string 字面量的**字节区间**（用于 classGraph 掩码）。
  - 备选：用行区间。选字节区间因 `extract` 已有 `node.startIndex/endIndex`，classGraph 现按行切片，可由字节区间投影到行；二者皆可，design 取字节区间 + 在 classGraph 内转行掩码。
- 继承/内嵌边：复用既有 `symbolEdgeSchema`（`kind: 'inherits' | 'implements'`，已存在）。extract 产出 file 级 `edges`（`fileStructuralDiffSchema.edges` 已存在但当前未填充类间继承），assemble 时把跨文件/changed-class 的 inherits/implements 归并进顶层 `classEdges`（结构化优先，`isInheritance` 兜底补充）。
- 调用点：file 级新增可选 `callSites: z.array(z.object({ callerByteStart, callerByteEnd, calleeName })).default([])`，或更轻量地复用 impact。为最小耦合，design 采用：extract 产出 `callSites`（callee 简单名 + 调用所在字节位置），classGraph `usedMembersAndCallers` 优先消费 `callSites`，无则回退现 `.name(` 正则（兜底覆盖未结构化语言路径）。

所有新增字段 optional/default → 旧磁盘 JSON `safeParse` 不报错（`store.ts:46`）。zod 单测覆盖「缺字段解析成功」。

### W2 — AST 注释/字符串掩码（替换 `stripCommentsAndStrings`）

extract 阶段对每文件用一条 per-language blanking query 收集 comment + 所有 string 字面量节点的 `[startIndex,endIndex)`，写入 `maskRanges`。classGraph 不再手写词法器，而是按 `maskRanges` 把对应字节置空（保留 `\n`，行号稳定）后再跑 name/inheritance 扫描。

每语言已验证的 blanking query（节点名取自真实探测）：

| lang | comment 节点 | string 节点 | blanking query |
|---|---|---|---|
| python | `comment` | `string`（含三引号/f/r/b/拼接子串）| `(comment) @b (string) @b` |
| go | `comment` | `interpreted_string_literal` `raw_string_literal` `rune_literal` | `[(comment)(interpreted_string_literal)(raw_string_literal)(rune_literal)] @b` |
| rust | `line_comment` `block_comment` | `string_literal` `raw_string_literal` `char_literal` | 五者 `@b` |
| cpp | `comment` | `string_literal` `char_literal` `raw_string_literal` `system_lib_string` | 四者 `@b` |
| javascript | `comment` | `string` `template_string` `regex` | 四者 `@b` |
| typescript | `comment` | `string` `template_string` `regex` | 同 JS |
| java | `line_comment` `block_comment`（探测复用 Java grammar 确认）| `string_literal` `character_literal` | 实现期探测确认 |
| scala | `comment` | `string`（含三引号；插值串 `string_transform_expression` 内含 `string`）| `(comment) @b (string) @b` |

要点（探测证实）：多行字符串/块注释都是**单节点**，range 覆盖全部行——这正是手写词法器（换行结束串）做错的地方。
兜底/降级：

- Scala **嵌套块注释** `/* /* */ */` 与 **char/symbol 字面量** `'x'`/`'sym` 在 0.20 grammar 解析为 ERROR，tree 掩码盖不住 → 保留一条极小正则兜底（或接受罕见泄漏），Scala 仍 degraded。
- Go 末尾无换行的 raw string 探测到 EOF ERROR 节点（仅畸形输入），加回归测试确认掩码不被扰动。

### W3 — 结构化可见性（`SymbolNode.visibility`）

extract 按语言结构计算并写入 `sym.visibility`：

- **rust**：def 节点有直接子 `visibility_modifier` → public；其子若含 `crate`/`super`/`self`/path（`pub(crate)` 等）→ 视作非公开（`package`）；无 `visibility_modifier` → private。trait 内方法按 trait 契约视 public。
- **cpp**：成员所属 `field_declaration_list` 内，`access_specifier`（文本 `public`/`protected`/`private`）段标签对后续兄弟生效；默认 `class_specifier`→private、`struct_specifier`→public；out-of-line 定义无从得知 → 默认 public。extract 按兄弟顺序扫描赋值。
- **typescript**：`accessibility_modifier` 命名子节点（`public`/`protected`/`private`），无则 public；`private_property_identifier`（`#`）→ private。
- **javascript**：无可见性关键字；`#`（`private_property_identifier`）→ private，否则 public。
- **java**：签名关键字（现有），无修饰符 → `package`（保留现行默认）。
- **python**：名字约定 `__x`（非 dunder）→ private，`_x`→ protected，否则 public（现有，确认无需 grammar 改动）。
- **go**：首字母大写 → public 否则 private（现有，无修饰节点）。
- **scala**：`modifiers` 节点含匿名 token `private`/`protected` → 对应可见性；可把 `modifiers` 文本并进 `signature` 让前端正则继续工作，或直接置 `visibility`。

前端 `memberVisibility` 改为：**优先 `sym.visibility`，缺失时回退现有签名/约定启发式**；删除 `kotlin` 死分支。`externallyUsable`（`bbebb8f`）因此对所有语言生效。

### W4 — 构造函数归类

extract `finalKind` 在「function→method」后追加（按语言，且父为 class-like 才生效）：

- java：已有 `@def.constructor`（保留）。
- typescript / javascript：`method_definition` 且 name 文本 === `constructor` → `constructor`。
- python：method 且 name === `__init__` → `constructor`。
- cpp：`declaration`/`function_definition` 的 declarator 叶名 === 所在类名 → `constructor`；`destructor_name` 一律 (de)structor。
- scala：`function_definition` name 文本 === `this` → `constructor`。
- rust：**不**产 constructor（`fn new` 仍是普通关联函数）。

`classGraph.ts` 构造入口逻辑（`usedMembersAndCallers` 中 `m.kind === 'constructor'`）随之对 6 语言生效（Rust 天然不触发）。

### W5 — 缺失抽取补齐（queries.ts + extract.ts）

- **javascript**：方法/字段 query 各加 `private_property_identifier` 备选（与现有 `property_identifier` 并存），收录 `#priv()` / `#secret`。
- **typescript**：确认字段是 `public_field_definition`（现有），加 `private_property_identifier` 备选 + 读 `accessibility_modifier`。
- **cpp**：加成员方法三形态——
  - inline 定义：`(function_definition declarator:(function_declarator declarator:(field_identifier) @name)) @def.method`
  - 原型（带返回类型）：`(field_declaration declarator:(function_declarator declarator:(field_identifier) @name)) @def.method`
  - 构造/析构原型：`(declaration declarator:(function_declarator declarator:(identifier) @name)) @def.constructor`、`destructor_name` 同理。
  - 保留现有 top-level free function；out-of-line 成员定义（`qualified_identifier`）按需补。
- **rust**：加 `(function_signature_item name:(identifier) @name) @def.method`（trait 方法签名），并让 `rustImplReceiver` 也能走到 `trait_item` 读其 `name:`，使 trait 方法签名限定为 `Trait.method`。

### W6 — 继承/内嵌边结构化 + 调用算子匹配

**继承/内嵌边**（extract 产出 `inherits`/`implements`，assemble 归并入 `classEdges`，`isInheritance` 降兜底）：

- java/ts：`extends`（superclass）+ `implements`（interfaces）。ts `class_heritage > extends_clause value:` + `implements_clause`；js `class_heritage > identifier`。
- python：`class_definition` 的 `superclasses`（`argument_list`），逐 base 出边；过滤 `keyword_argument`（metaclass），展开 `subscript`/`attribute`（泛型/点分基）。
- cpp：`class_specifier`/`struct_specifier` 的 `base_class_clause`，取其下**每个** `type_identifier` 出一条 inherits 边（多基）。
- rust：`impl_item` 有 `trait:` 字段 → `implements`（type→trait，泛型经 `generic_type.type` 解包取裸名）；`trait_item` 的 `bounds:(trait_bounds)` → supertrait inherits。inherent `impl S {}`（无 `trait:`）不出边。
- go：struct `field_declaration` 有 `type:` 无 `name:` → 内嵌（`*Embedded` 的 `*` 是匿名子；`pkg.T` 经 `qualified_type.name`）；interface 内 `constraint_elem`（0.20 名，非 `type_elem`）→ 接口内嵌。出 inherits 边。
- scala：`extends_clause`（字段名 `extend` 单数）下 `compound_type` 的每个 `type_identifier`（父类 + 每个 `with` trait）出边。

**调用算子匹配**（extract 产出 `callSites`：callee 简单名 + 字节位置，classGraph 优先消费；正则兜底保留）：

- 各语言 callee 取法（探测证实）：
  - rust：`call_expression function:` 为 `field_expression.field`（`.`）或 `scoped_identifier.name`（`::`）。
  - cpp：`field_expression.field`（`.` 与 `->` 同形）或 `qualified_identifier.name`（`::`）。
  - go：`selector_expression.field`（区分 `qualified_type` 包引用，不计为成员调用）。
  - js/ts/java/python：现有点号路径（`member_expression`/`field_access`/`attribute`）。
- 这样 C++ `->`、Rust/C++ `::` 不再漏；Go selector 精确。

## 4. 数据流

```
extract(file) ──► { symbols(+visibility,+constructor kind),
                    maskRanges, callSites, structural inherits/implements edges }
        │
        ▼
assemble ──► FileStructuralDiff(+maskRanges,+callSites,+edges) ──► StructuralDiff(classEdges 归并: 结构化优先 + isInheritance 兜底)
        │
        ▼
classGraph(consume maskRanges→掩码文本; callSites→调用起点; 结构化 edges) ──► structureGraph(前端读 sym.visibility, 缺失回退)
```

## 5. 与现有模块耦合点

- 产出：`lang/queries.ts`、`lang/extract.ts`（+ 可能新增 `lang/edges.ts`/`lang/visibility.ts` 纯函数便于单测）。
- 组装：`assemble.ts`（把 maskRanges/callSites/edges 注入制品；classEdges 归并去重，结构化覆盖正则）。
- 消费：`classGraph.ts`（掩码、调用、继承兜底）、`frontend/src/lib/structureGraph.ts`（读 visibility、删 kotlin 死分支）。
- 契约：`shared/src/schemas/structuralDiff.ts`（可选字段）。

## 6. 失败模式 / 降级

- C++/Scala 仍 `degraded` + `confidence:'inferred'`；C++ 预处理器/模板、Scala 嵌套块注释 + char/symbol literal + Scala-3 构造不在保证范围，保留兜底正则。
- 结构化 edges/visibility/callSites 缺失（某语言某构造未覆盖）→ 自动回退现有正则启发式，**不会比现状更差**（保证「零退化」）。
- 无 DB 迁移；旧磁盘 JSON 缺新字段照常读回。
- `hadError`（grammar 解析出错）路径不变，文件仍标 degraded。

## 7. 测试策略（§测试用例必写清单）

遵循「test-with-every-change」：每条改动随对应语言的纯函数断言落地，运行时巨型组件用源代码文本断言兜底。

- **W2 掩码**：每语言一条「注释/字符串里的类名不产生引用边」断言——重点回归：python `#` 注释 + 三引号 docstring、go 多行 raw string、js 多行 template、scala 三引号、rust raw string、cpp raw string。
- **W3 可见性**：每语言一条 `visibility` 断言；**Rust/C++/JS 私有门控回归**：私有成员被其他 changed class 引用时**不**出现在 `toMembers`（`externallyUsable` 生效）。
- **W4 构造**：java/ts/js/python/cpp/scala 各一条「构造被识别为 `constructor` 且作为下游入口」断言；rust 一条「`new` 不是 constructor」断言。
- **W5 抽取**：js/ts `#private` 被收录；cpp 成员方法/构造被收录；rust trait 方法签名被收录。
- **W6 继承/内嵌**：go struct 内嵌、go interface 内嵌、rust impl-for、rust supertrait、cpp 多基、python 多基（过滤 metaclass）、scala `with` 多 trait、java/ts implements——各一条「出 `inherits`/`implements` 边而非 `references`」断言。
- **W6 调用**：cpp `->`、cpp/rust `::`、go selector 各一条「调用连到被调方法」断言。
- **回归防护**：每个 test 文件顶部注释写明锁的是哪条审计盲点（链接本 RFC + 对应原始 commit）。
- **零退化**：现有 `structural-diff-class-graph.test.ts` / `structure-graph.test.ts` / `structure-view*.test.tsx` 全绿。
- **门槛**：`bun run typecheck && bun run test && bun run format:check` + 单二进制 build smoke（`reference_binary_build_module_cycle` 教训：跨包 export 改动 push 前必跑）。

## 8. 实现期复验要求

每个 W 落地前，对相关 grammar **复跑探测**（`parseSource` 打印 s-expression）确认节点名，引用具体 `文件:行` + 探测片段，避免基于过期假设写 query。
