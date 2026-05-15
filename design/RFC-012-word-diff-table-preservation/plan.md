# RFC-012 — 任务分解

## 子任务表

| ID         | 描述                                                                                                                                                                                                                                                                  | 产物       | 依赖  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----- |
| RFC-012-T1 | `markdownDiff.ts` 新增 `findTableBlocks` / `pretreatTablesForWordDiff` / `restoreTablePlaceholders` + 占位符 PUA 区间（U+E010-U+EFFF）+ `TABLE_ROW_RE` / `TABLE_SEP_RE`；全部导出到 `_internal`                                                                       | 1 src 改动 | —     |
| RFC-012-T2 | `computeChanges` word 分支接 T1：`pretreatTablesForWordDiff` → `splitForWordDiff` → `diffWordsWithSpace` → `restoreTablePlaceholders`；line / block 分支零改动。`wrapLines` 加两条增量：separator 行 passthrough、表格行按 cell 包 marker（新增 `wrapTableRowCells`） | 1 src 改动 | T1    |
| RFC-012-T3 | 新增 `tests/markdown-diff-table-word.test.ts`：7 主用例（design §测试 1-7：identical / header rename / column-count change / table↔paragraph / 连续两张表 / placeholder 字符碰撞 / fence 混排）+ 5 个 `_internal` helper 单测                                         | 1 新测试   | T2    |
| RFC-012-T4 | 扩展 `tests/markdown-diff-view.test.tsx`：+1 word 渲染集成（`getAllByRole('table') ≥ 2` + 无 `\|---` 漏底段落 + `.diff-ins` / `.diff-del` cell），+1 段落 ↔ 表互换，+1 line 回归，+1 block 回归                                                                       | 1 测试改动 | T2    |
| RFC-012-T5 | 扩展 `tests/markdown-diff-build.test.ts`：源码层断言 `_internal.findTableBlocks` / `_internal.pretreatTablesForWordDiff` / `_internal.restoreTablePlaceholders` 存在 + PUA 区间与 MARKERS 不重叠 + `TABLE_SEP_RE` 行为锁定                                            | 1 测试改动 | T2    |
| RFC-012-T6 | 文档同步：`design/plan.md` RFC 索引追加 RFC-012 行；`STATE.md` 顶部"进行中 RFC" 加一行指向本 RFC；commit message / PR body 描述本 RFC 修复的场景与接受的粒度退化                                                                                                      | 2 修改     | T1-T5 |

## PR 拆分

**单 PR**：T1-T6 一并提。原因：T1 与 T2 紧耦合，没单独提的意义；T3-T5 是同一份代码的回归保护，必须与 T1/T2 同 commit 才能确保红→绿过渡；T6 是文档收尾。

commit message：

```
feat(review): RFC-012 preserve markdown tables in word-diff

- word 模式 buildMergedMarkdown 前先用 PUA 占位符把每张 markdown 表抽出，
  让 jsdiff 把整张表当原子 token 对齐，避免分隔符行被 `-` 粒度对齐打碎
- restoreTablePlaceholders 还原时为每张表补 \n\n 段落边界
- wrapLines 加两条增量：表格分隔符行 passthrough、header/body 行按 cell 包 marker
- 接受退化：表内 cell 级字词改动 word 模式渲染为整张旧表 del + 整张新表 ins
- 测试：+12 单测（markdown-diff-table-word：7 主用例 + 5 internal helper）
  +4 集成（word 渲染 table / 段落↔表互换 / line / block 回归）
  +3 源码层断言（_internal exports / PUA 区间 / TABLE_SEP_RE 行为）
```

Co-Authored-By 行按现仓约定。

## 验收清单（PR 自检）

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（前端 + 后端 + shared）
- [ ] `bun run format:check` 全绿
- [ ] 手测：打开本 RFC 背景的真实 review URL（或任意一份左右表格结构不一致的 review），切到 word 模式，看到两张完整 `<table>` 而不是裸 `|---|---|` 段落
- [ ] CI Actions（push 后立即查）3 项全绿（典型 ~3 min）
- [ ] `design/plan.md` RFC 索引含 RFC-012
- [ ] `STATE.md` 顶部进行中 RFC 行 + 完工后改 Done

## 不做的事（本 RFC 范围外，记录以防将来歧义）

- table cell 级 word-diff（接受 word 模式退化为整张表 del / ins）
- 整体改造 word 模式为"先 line-diff 找差异块，再块内 word-diff"（独立大 RFC）
- 把表格保护扩展到其它 markdown 结构块（heading / list / blockquote 现有 word 表现已可接受）
- line / block 模式行为变更
