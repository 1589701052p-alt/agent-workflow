# RFC-081 — 任务分解

**gated on RFC-080 绿**（消费其 `isReviewableBody` / `passthroughKind` /
`acceptedSubsetKind` 非 optional 占位 + drift-guard）。3 PR 强序。

## PR-A — markdownish 收编到 `isReviewableBody`

| 子任务     | 说明                                                                                                                                | 依赖    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------- |
| RFC-081-T1 | 填 `isReviewableBody(parsed)` 语义：markdownParametric=true / path 读 ext（md/markdown=true）/ string·signal=false / list 委托 item | RFC-080 |
| RFC-081-T2 | 收编 6+ 调用面改走 hook：`reviewMultiDoc.ts:17/30/41`、`validator.ts:777/780`、`schemas/review.ts:420`、`review.ts:1892/2176/2410`  | T1      |
| RFC-081-T3 | 源码守卫：上述文件无残留 `=== 'markdown'`/`'markdown_file'`/内联 ext 集合                                                           | T2      |
| RFC-081-T4 | 测试：`isReviewableBody` 单测 + 虚构 path<mdx> 自动认 + 各调用面收编回归（含 isMultiMarkdownUpstream 现在计入 path<md> 的行为变化） | T1-T3   |

**PR-A 验收**

- [ ] AC-1：markdownish 全走 hook；path<mdx> handler=true 时多文档/validator/sibling 自动认。
- [ ] 源码守卫绿；RFC-079 + 单文档 review 套件零回归。

## PR-B — review 输出 kind 派生（passthroughKind / acceptedSubsetKind）

| 子任务     | 说明                                                                                                                                         | 依赖  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| RFC-081-T5 | 填 `acceptedSubsetKind(inputKind)` + `passthroughKind(inputKind, hasSourcePath)` 语义                                                        | PR-A  |
| RFC-081-T6 | `review.ts:1367` 改调 `acceptedSubsetKind`；`review.ts:1530/1537` + `lifecycleRepair/options-R1.ts:146` 收编为同一 `passthroughKind`（消重） | T5    |
| RFC-081-T7 | OQ-3 前置 grep：派生 kind 串是否触及下游/前端/e2e 硬断言；同步核查                                                                           | T6    |
| RFC-081-T8 | 测试：hook 单测 + **持久化 kind 串回归快照**（逐 case 列明变更）+ options-R1↔review 对拍                                                     | T5-T7 |

**PR-B 验收**

- [ ] AC-2：review 输出 kind 从上游派生；`options-R1.ts` 与 `review.ts` 同 hook。
- [ ] 持久化 kind 串回归快照全锁；RFC-079 + 单文档零回归。

## PR-C — 多文档泛化到内联 `list<markdown>`

| 子任务      | 说明                                                                                                                                                                                               | 依赖          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| RFC-081-T9  | （评审轮先定 OQ-2 哨兵/转义）`listWire` item-kind 感知编解码 `splitListItems(raw,itemKind)`/`joinListItems(items,itemKind)`：path/string 项字节不变、markdown 正文项哨兵+转义；**保持 cycle-free** | PR-B          |
| RFC-081-T10 | `review.ts:431` 多文档归档：item 抽取走 T9；内联项写 `bodyPath`、`item_path=NULL`                                                                                                                  | T9            |
| RFC-081-T11 | `reviewMultiDoc.ts:101` → `acceptedSubset(rows, inputKind)`：文件项 join list<path<md>>、内联项 join list<markdown>（经 T9），kind 由 `acceptedSubsetKind` 给                                      | T9,RFC-081-T5 |
| RFC-081-T12 | 前端多文档三栏面（RFC-079）渲染内联项：`item_path` NULL → 从 `bodyPath` 正文渲染（复用单文档路径）；内联项隐藏下载                                                                                 | T10           |
| RFC-081-T13 | （若 OQ-1 定加列）migration 加 `doc_versions.item_inline` + backfill 全 NULL；否则跳过                                                                                                             | T10           |
| RFC-081-T14 | 测试：list wire item-kind property test（零回归 path + markdown round-trip 含换行/含哨兵/空/N 文档）+ 端到端 list<markdown> 多文档 + e2e                                                           | T9-T13        |

**PR-C 验收**

- [ ] AC-3/AC-5：内联 list<markdown> 多文档端到端可用；list wire round-trip 字节守恒。
- [ ] AC-4：list<path<md>> 多文档 + 单文档 + RFC-079 全套零回归。
- [ ] `build:binary` smoke 绿（listWire 改动无初始化环）。

## 测试规模预估

backend/shared ≥ 24（isReviewableBody + 收编回归 + 持久化快照 + list wire property +
端到端）；frontend ≥ 4（内联项渲染）；e2e 1 spec。与 RFC-049/060/079/080 零回归。

## 评审轮要求

本 RFC 改持久化 kind 串 + 引入新 list wire 形式，启动 PR-C 前建议跑一轮对抗式评审
敲定 OQ-1/OQ-2/OQ-3，再进实现。
