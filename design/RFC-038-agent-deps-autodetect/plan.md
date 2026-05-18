# RFC-038 — 实施计划

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。单 PR，按任务顺序写代码 + 测试。

## 拆分原则

**单 PR 合并**。改动收敛：1 lib + 2 component + 1 AgentForm 接线 + 1 css 块 + 9 i18n key + 18+ 测试 + 0 backend / 0 shared / 0 DB。一次 commit / 一次评审 / 单 revert 回退。

## 任务列表

### RFC-038-T1 — 纯函数 `lib/agent-dep-detect.ts`

- 新文件，导出 `DetectInventoryRow` / `DetectInventory` / `DetectExisting` / `DetectionGroup` / `DetectionResult` 类型 + `detectAgentDeps` + `mergeAgentDeps`。
- 实现按 design.md §3 锁死的 6 步过滤 + dedupe。
- 测试：`tests/agent-dep-detect.test.ts`（≥ 10 case）+ `tests/agent-dep-merge.test.ts`（≥ 4 case）。
- Acceptance：纯函数 zero side effect；输入数组不被 mutate（用 `Object.freeze` 输入 + `expect(() => fn(...)).not.toThrow()` 兜底）。

### RFC-038-T2 — `DependencyAutodetectDialog` 组件

- 新文件 `packages/frontend/src/components/agents/DependencyAutodetectDialog.tsx`。
- props：`open: boolean; result: DetectionResult; loadFailures: ('agents'|'skills'|'mcps'|'plugins')[]; onApply(selection); onClose()`。
- 内部 state：`selected: { agents: Set<string>; skills; mcps; plugins }`，初始全选。
- 渲染按 design.md §4.3 形态：四 section（空组隐藏）+ footer 双按钮 / EmptyState。
- 测试：`tests/agent-dep-autodetect-dialog.test.tsx`（≥ 4 case）。

### RFC-038-T3 — `DependencyAutodetectButton` 组件

- 新文件 `packages/frontend/src/components/agents/DependencyAutodetectButton.tsx`。
- 复用 `AGENTS_QUERY_KEY` / `SKILLS_QUERY_KEY` / `MCPS_QUERY_KEY` / `PLUGINS_QUERY_KEY` 四个 `useQuery`；`staleTime: 30_000; retry: false`。
- props：`bodyMd: string; value: CreateAgent; selfName: string; onApply(selection)`。
- 内部：`useState<DetectionResult | null>(null)`，点击时 `detectAgentDeps(...)` → setResult → 打开 dialog；dialog onApply 调 props.onApply 后关闭。
- disabled 判定：`bodyMd.trim() === ''`。
- 测试：`tests/agent-dep-autodetect-button.test.tsx`（≥ 2 case）。

### RFC-038-T4 — `AgentForm.tsx` 接线

- 在 `<Field label={t('agentForm.fieldDependsOn')}>` Field 块之后、`<Field label={t('agentForm.fieldDependencyTree')}>` Field 块之前**追加一行**：

  ```tsx
  <DependencyAutodetectButton
    bodyMd={value.bodyMd ?? ''}
    value={value}
    selfName={value.name}
    onApply={(selection) => onChange(mergeAgentDeps(value, selection))}
  />
  ```

- import `DependencyAutodetectButton` + `mergeAgentDeps`。
- 不改既有任何 Field 顺序 / 属性。
- 如发现 `AgentForm.test.tsx` 有 snapshot 断言新增 DOM 触发红 → 更新快照。

### RFC-038-T5 — i18n keys

- `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts`：按 design.md §4.4 加 9–13 keys（视 common.\* 可复用情况裁剪）。
- `Resources` 接口（en-US.ts 末尾）同步扩展。
- 测试：`tests/i18n-autodetect-keys.test.ts`（≥ 2 case）。
- 既有 `tests/i18n-keys-symmetry.test.ts` 不改即可自动覆盖。

### RFC-038-T6 — css

- `packages/frontend/src/styles.css` 末尾追加：

  ```css
  .agent-form__autodetect-row {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--space-2);
  }
  .agent-dep-autodetect__row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
    cursor: pointer;
  }
  .agent-dep-autodetect__row input[type='checkbox'] {
    margin: 0;
  }
  .agent-dep-autodetect__section + .agent-dep-autodetect__section {
    margin-top: var(--space-3);
  }
  ```

- 沿用 RFC-035 设计 token；不引新颜色 / 不破坏暗色覆写。

### RFC-038-T7 — 三件套校验 + 收尾

- 本地：`bun run typecheck && bun run test && bun run format:check`。
- commit message 形态：

  ```
  feat(agents): RFC-038 agent 表单一键识别 body 依赖

  - 新 lib/agent-dep-detect.ts：detectAgentDeps（contains 扫描四类 inventory）+ mergeAgentDeps（append + dedupe）
  - 新 DependencyAutodetectButton + DependencyAutodetectDialog（复用 RFC-035 <Dialog> + <EmptyState>）
  - AgentForm 在 fieldDependencyTree 上方挂载按钮 + onApply → onChange(mergeAgentDeps(...))
  - i18n 中英对称新增 keys，Resources 接口同步
  - 测试 +18（detect 10 + merge 4 + button 2 + dialog 4 + i18n 2）一次过；零 backend / shared / DB / migration / WS 改动
  - body 为空时按钮 disabled；query 失败的组跳过；四组全空显示 EmptyState

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

- push 后查 GitHub Actions HEAD CI（per [feedback_post_commit_ci_check]）六 jobs 全绿。
- `STATE.md` 把 RFC-038 行从"进行中"挪到"已完成"段，commit hash 落入。
- `design/plan.md` RFC 索引 RFC-038 状态 Draft → Done。

## 依赖

无前置依赖。RFC-022 闭包预览 / RFC-028 mcp / RFC-031 plugin / RFC-035 PR3 共享 `<Dialog>` 都已 Done 落 main。

## Acceptance checklist

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] GitHub Actions HEAD CI 六 jobs 全绿
- [ ] AgentForm 表单上 fieldDependencyTree 上方出现「自动识别依赖」按钮
- [ ] body 空白时按钮 disabled + tooltip 文案
- [ ] 点击按钮：bodyMd 含 inventory 中 name 时弹出 dialog，否则 dialog 显示 EmptyState
- [ ] 默认全选；取消勾选后「导入选中」按钮文案 count 同步；点击合并进 value 对应数组
- [ ] 「取消」/ ESC / 遮罩点击不改 form 状态
- [ ] 单 query 失败时该组从 detect 跳过 + dialog 底部提示
- [ ] 中英 i18n 对称 + Resources 接口同步
- [ ] 既有套件零退化
- [ ] 多人 working tree 安全（未追踪文件不动）
- [ ] STATE.md / plan.md 同步落 Done

## Rollback

单 commit `git revert <sha>`。本 RFC 纯前端 / 纯加法，无 DB / API / WS / 共享 schema 改动。
