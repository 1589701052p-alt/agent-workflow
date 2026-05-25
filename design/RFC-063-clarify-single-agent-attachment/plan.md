# RFC-063 — Plan

单 PR 落地。

## 任务分解

### RFC-063-T1 — Validator 规则 + 测试

**改 `packages/backend/src/services/workflow.validator.ts`**：

1. §4c clarify 段：在现有 `agentSourceIds: Set<string>` 收集完成后、`multi-clarify on the same agent`
   反向规则之前，插入 G1 `clarify-multiple-source-agents` 分支（详见 design.md §G1）。
2. §4d cross-clarify 段：
   - 把现有 `let questionerId: string | undefined` 重构为先收 `questionerCandidateIds: Set<string>`，
     循环结束派生稳定的字典序最小 questionerId 给后续 ancestor / self-review 规则；
   - 插入 G2 `cross-clarify-multiple-questioners` 分支（详见 design.md §G2）；
   - 在 `cross-clarify-manual-edge-missing` warning 之后、`cross-clarify-target-not-ancestor`
     循环之前，插入 G3 `cross-clarify-multiple-designers` 分支（详见 design.md §G3）。

**改 `packages/backend/tests/workflow-validator-clarify.test.ts`** — +2 case：

```ts
test('one clarify with two duplicate edges from the same agent is allowed (G1 dedup)', () => {
  // 两条 __clarify__ → c1.questions 重复 edge（不同 edge id）
  // expect codes NOT to include 'clarify-multiple-source-agents'
})

test('one clarify with edges from two different agents is rejected (G1)', () => {
  // a1 + a2 各一条 __clarify__ → c1.questions
  // expect 'clarify-multiple-source-agents' present
  // expect message includes both 'a1' and 'a2'
})
```

**改 `packages/backend/tests/workflow-validator-cross-clarify-rfc056.test.ts`** — +5 case：

```ts
test('one cross-clarify with duplicate questions edges from same questioner is allowed (G2 dedup)', () => { ... })
test('one cross-clarify with questions edges from two different questioners is rejected (G2)', () => { ... })
test('one cross-clarify with two to_designer edges to same designer is allowed (G3 dedup)', () => { ... })
test('one cross-clarify with two to_designer edges to different designers is rejected (G3)', () => { ... })
test('two cross-clarify nodes pointing to the same designer is allowed (multi-source banner mode regression)', () => { ... })
```

第一条 happy path test 的 `.not.toContain` 列表追加 2 个新 code（守住"1q+1d 不误伤"）。

**改 `packages/backend/tests/cross-clarify-validator-rules.test.ts`** — enum 守门列表追加：

```ts
// RFC-063 — single-agent attachment rules
'cross-clarify-multiple-questioners',
'cross-clarify-multiple-designers',
```

如果该测试用 `.toHaveLength(7)` hardcoded 数量，同步改 9 + 注释链回本 RFC。

### RFC-063-T2 — 三件套（pre-flight）

`bun run typecheck && bun run test && bun run format:check` 三件套必须全绿。

预期触及套件：
- backend：`workflow-validator-clarify.test.ts`（既有 6 + 新 2 = 8 case）
- backend：`workflow-validator-cross-clarify-rfc056.test.ts`（既有 7 + 新 5 = 12 case）
- backend：`cross-clarify-validator-rules.test.ts`（enum 守门同步）
- 其他既有 validator 套件无改动，跑一遍确认无回归。

### RFC-063-T3 — STATE.md + RFC 索引登记

1. `design/plan.md` "RFC 索引" 表追加 RFC-063 行（Done before merge）。
2. `STATE.md` 顶部"进行中 RFC"区块追加 RFC-063；合并后改为 Done + 加入已完成列表。

## 验收清单

- [ ] T1：3 条新规则上线、6+ 新 case 全绿
- [ ] T2：typecheck + test + format:check 三件套全绿
- [ ] T3：STATE.md + plan.md 索引同步
- [ ] PR：单 commit `feat(backend): RFC-063 clarify single-agent attachment`
- [ ] CI：push 后 `gh run list -L 1` 全绿（含 lint / format / typecheck / unit / e2e / artifact build）

## 风险 / 回滚

- **风险点**：现有 frontend / e2e 套件里有可能存在"故意构造多 agent 连 clarify"的边界测试用例；若有，本
  RFC 会让它们变红。预案：先全局 grep `__clarify__` + `to_designer` 找出潜在违规 fixture，逐个评估是
  改 fixture 还是放宽规则。
- **回滚**：纯 validator 改动，单 commit revert 即可；无 DB / schema / migration 状态需要迁移。

## 不在本 RFC 范围

- canvas drag-prevention（拖动时直接禁止接入第二个 agent）—— follow-up RFC，可在 user 反复触发 validation
  报错后再做。
- i18n 新 code 翻译（zh-CN / en-US `workflow.validation.<code>`）—— 短期由 fallback message 兜底，纳入 UX
  优化时再补。
