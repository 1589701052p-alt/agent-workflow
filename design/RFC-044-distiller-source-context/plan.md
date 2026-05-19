# RFC-044 — Plan

## 子任务编号

| ID | 标题 | 依赖 | 估时 |
|---|---|---|---|
| RFC-044-T1 | Config schema + 默认值 | — | 0.3h |
| RFC-044-T2 | `LoadedSourceEvents` 字段扩展 + clarify transcript 加载 | T1 | 1.5h |
| RFC-044-T3 | review body 加载 | T1 | 0.8h |
| RFC-044-T4 | SessionTree → markdown 渲染 helper + head/tail clip | T2 | 0.8h |
| RFC-044-T5 | `buildDistillerUserPrompt` 渲染两段新 block + budget 透传 | T2 T3 T4 | 0.7h |
| RFC-044-T6 | Scheduler / cli 透传 `sourceContextBudget` | T5 | 0.3h |
| RFC-044-T7 | 新 `memory-distiller-source-context.test.ts` 12 case | T2..T6 | 2h |
| RFC-044-T8 | 既有 `memory-distiller.test.ts` + scheduler 测试追加 4 case | T7 | 0.8h |
| RFC-044-T9 | shared `config.test.ts` 追加 zod 边界 case | T1 | 0.3h |
| RFC-044-T10 | 三件套 typecheck + test + format:check + push + CI 监控 | T1..T9 | 0.5h |

合计 ≈ 8h，单 PR。

## PR 拆分建议

**单 PR**：`feat(memory): RFC-044 distiller source context (clarify transcript + review body)`

理由：T1..T9 共改 4 个生产文件 + 4 个测试文件，串行高耦合，拆 PR 不划算。

## 验收清单（PR 自检）

- [ ] `bun run typecheck` 全绿
- [ ] `bun run test` 全绿（既有 1697 frontend + ~1411 backend test 0 退化）
- [ ] `bun run format:check` 全绿
- [ ] 新增 ~16 单测全过
- [ ] grep 守卫：`memoryDistiller.ts` 含两条 literal
- [ ] 默认值无配置时 distill 行为：行为加强（看到 transcript + body）
- [ ] `memoryDistillSourceContext.{*}=0` 配置下 distill 行为：完全等价 RFC-041 旧行为
- [ ] settings PUT 422：越界 budget 被 zod 拒
- [ ] distill 详情页（RFC-043）查看加强后的 user_prompt_md 含两段新内容（手工验证）
- [ ] STATE.md 顶部更新："已完成 RFC-044"
- [ ] `design/plan.md` RFC 索引追加 RFC-044 行（状态 Done）

## 跨 session 接手约定

新 session 接 RFC-044 时按 `proposal → design → plan` 顺序读，与本仓 RFC 工作流一致。
落地完成后立即用 `bun run typecheck && bun run test && bun run format:check` 三件套门槛，
push 后查 GitHub Actions（按 [feedback_post_commit_ci_check] 规则）。

## 风险 + Roll-back

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| transcript 渲染体过大撑爆 model 上下文 | 低 | distiller fail | budget 默认 16KB，最大 64KB，上线后 spot check |
| `Bun.file()` 读取超大文件阻塞 daemon | 极低 | scheduler 卡顿 | 单文件最大 64KB；distiller 跑频率本就低（5s debounce + 1Hz worker） |
| events 表 schema 漂移 | 低 | loader 抛错 | loader 用 SELECT 显式列名，FK cascade 已保证一致 |
| primaryAgentName 解析失败 | 中 | transcript 渲染降级到 "agent" | 已规划 fallback；不阻塞 distill |

Roll-back：单 PR revert，或者把 `memoryDistillSourceContext` 两子段设 0 软关闭。
