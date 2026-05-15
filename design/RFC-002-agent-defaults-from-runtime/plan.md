# RFC-002 Plan — 实施分解

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)

## 任务分解

按依赖序列，建议单 PR 提交（前后端紧耦合，预计 < 300 LoC）。

| 编号 | 标题 | 范围 | Size | Deps |
| --- | --- | --- | --- | --- |
| RFC-002-T1 | shared Config schema 扩字段 | `packages/shared/src/schemas/config.ts` 加 `defaultSteps` / `defaultMaxSteps`；可选附 1 个 zod parse 单测 | XS | — |
| RFC-002-T2 | Settings → Runtime UI | `routes/settings.tsx` RuntimeTab 加 2 个 NumberInput + `useTabState` keys；i18n 双语 4 key | XS | T1 |
| RFC-002-T3 | AgentForm Model 字段切换 | `components/AgentForm.tsx` 把 Model `<TextInput>` 换成 `<ModelSelect>` | XS | — |
| RFC-002-T4 | agents.new snapshot logic | `routes/agents.new.tsx` 引入 `useQuery(['config'])` + `useRef` 守卫 + `applyDefaults(draft, cfg)`（导出供测） | S | T1, T3 |
| RFC-002-T5 | SkillsPicker 组件 | 新建 `components/SkillsPicker.tsx`（含 `<select>` + 复用 `ChipsInput` + `useQuery(['skills'])` + 4 条 i18n key）；`AgentForm` Skills 字段改用 SkillsPicker | S | — |
| RFC-002-T6 | 前端单测 | `tests/agents-new-snapshot.test.tsx`（applyDefaults pure + route render 6 case） + `tests/skills-picker.test.tsx`（5 case） + `tests/agent-form.test.tsx` 扩 Model select + Skills 下拉的断言 | S | T2, T3, T4, T5 |
| RFC-002-T7 | 手工验证 + CI gate | proposal §4 / design §7.4 全部 8 条跑一遍；`bun run typecheck && bun test`；commit + push 后 GitHub Actions 全绿（按 [[feedback_post_commit_ci_check]]） | XS | T1–T6 |

总计预估：~0.5–1 个工作日。

## PR 拆分建议

**单 PR**。理由：

- T1（schema 加字段）单独 merge 后 Settings UI 不渲染、Add Agent 不消费——纯 dead code。
- T3（AgentForm Model 切换）单独 merge 后没有调用方变更，但 Snapshot 还没接通——半成品；
- T4 依赖 T1 + T3；T5（SkillsPicker）相对独立，但属于同一 RFC，合并审稿更高效；
- 总改动量 ~430 LoC，单 PR 仍在可审范围。

PR 标题：`feat(agents): RFC-002 prefill new-agent form from runtime defaults + skills picker`。

Commit message（HEREDOC）参考：

```
feat(agents): RFC-002 prefill new-agent form from runtime defaults + skills picker

- Add defaultSteps / defaultMaxSteps to Config schema (optional positive ints)
- Surface both in Settings → Runtime tab + zh-CN/en-US strings
- Replace Model TextInput in AgentForm with ModelSelect (reuse RFC-001)
- agents.new route snapshots model/variant/temperature/steps/maxSteps from
  /api/config exactly once on mount; subsequent Settings changes do not
  affect drafts already in progress, nor previously-saved agents
- agents.detail route unchanged — editing existing agents never prefills
- New SkillsPicker component wraps the Skills chips with a dropdown of
  existing skills from /api/skills; applies to both new and edit routes
```

## 验收清单

实现完成时必须满足：

- [ ] `design/RFC-002-agent-defaults-from-runtime/` 三文档齐全
- [ ] `bun run typecheck` 全绿
- [ ] `bun test` 全绿（含 RFC-002 新增 shared schema parse + frontend snapshot 单测 + SkillsPicker 单测）
- [ ] 手工 E2E 8 条断言全部通过（proposal §4 + design §7.4）
- [ ] `STATE.md` 追加 RFC-002 已完成条目
- [ ] `design/plan.md` RFC 索引表登记 RFC-002 = Done
- [ ] commit + push 后 GitHub Actions 全绿（按 [[feedback_post_commit_ci_check]]）

## 风险跟踪

| 风险 | 兜底 |
| --- | --- |
| `useQuery(['config'])` 在 settings 路由已订阅、agents.new 复用 cache 时 staleTime 不一致导致空 data | 显式给 agents.new 的 query 设 `staleTime: 30_000`；初始 `data` 可能 `undefined`，effect 守卫了 |
| 用户在 config 加载前已经修改某字段 → 后到 snapshot 不应覆盖 | `applyDefaults` 只在字段 `=== undefined` 时填；ref 守卫只允许 effect 触发一次；两层兜底 |
| 旧 `~/.agent-workflow/config.json` 缺新字段 → schema 解析失败 | `defaultSteps / defaultMaxSteps` 是 `.optional()`，缺即 undefined；现有 config 文件无影响 |
| `ModelSelect` 在两个地方（Settings + AgentForm）并发拉 `/api/runtime/models` | react-query cache key `RUNTIME_MODELS_QUERY_KEY = ['runtime','models']`，自动去重；首屏只发一次 |
| 编辑现有 agent 路由意外被 snapshot 影响 | snapshot 逻辑只放在 `agents.new.tsx`；`agents.detail.tsx` 不引入 useQuery(['config']) 副作用——单测显式覆盖该路径 |
| SkillsPicker 与 Skills 路由共享 `['skills']` query → 跳转 / 删除 skill 后下拉过期 | react-query cache 全局共享，`skills.new` / `skills.detail` 已经在变更时 `invalidateQueries(['skills'])`；AgentForm 自动跟新 |
| SkillsPicker 在 onChange 后没有自动复位下拉到 placeholder，连续选第二个时卡住 | 受控 `value=""` 强钉；onChange 内显式赋 `e.target.value=''` 仅是兜底。单测覆盖"连续多选不卡"|

## 后续工作（非本 RFC）

- `NodeInspector` 的节点级 model override 字段同样改成 `ModelSelect`（节点 override 是覆盖在 agent.model 上的；切换之后用户体验更一致）—— 单独 issue。
- 节点级别 variant / temperature override 是否也要从 agent.* snapshot —— 待用户提需求时讨论。
- 把 `defaultSteps / defaultMaxSteps` 露出到节点级 override（让任务在节点级也能覆盖）—— 待需求驱动。
- SkillsPicker 升级：搜索框 / 多选 checkbox / 显示 sourceKind 标签 / 直接跳"新建 skill"—— 待用户量级真起来时再做。
