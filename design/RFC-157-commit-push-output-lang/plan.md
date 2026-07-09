# RFC-157 — 任务分解

单 PR 交付（改动小、纯对称镜像 RFC-050，无跨模块风险）。commit message 前缀
`feat(shared,backend,frontend): RFC-157 提交推送内置 agent 输出语言可配置`。

## 子任务

### RFC-157-T1 — shared 配置字段 + 测试
- `schemas/config.ts`：基础 `ConfigSchema` 加 `commitPushLang: LanguageSchema.optional()`（commit-push
  字段区）；`ConfigPatchSchema.extend(...)` 加 `commitPushLang: LanguageSchema.nullable().optional()`
  **和** `memoryDistillLang: LanguageSchema.nullable().optional()`（P2-1：Default 发 null 清除）。
- 新 `tests/config-rfc157-commit-push-lang.test.ts`（镜像 config-rfc050 + patch nullable + base 拒 null）。
- 依赖：无。

### RFC-157-T2 — backend prompt 指令 + 透传 + 测试
- `services/commitPush.ts`：`COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE` 常量 + 两 builder 加可选 `lang`
  入参、末尾追加指令。
- `services/launchRuntimeConfig.ts`：`resolveCommitPushConfig` + `resolveLaunchRuntimeConfig`
  的 `commitPush` 形状加 `lang`。
- `services/task.ts`：`StartTaskDeps.commitPush` 加 `lang`；`runtimeConfigOpts`（509 行，真 funnel）映射 `commitPushLang`。
- `services/scheduler.ts`：`RunTaskOptions.commitPushLang` + 调用点解析并传两 builder。
- 新 `tests/commit-push-output-lang-directive.test.ts`（镜像 memory-distiller-output-lang-directive）
  + `launchRuntimeConfig`/`toRunTaskOptions` 透传锁。
- 依赖：T1（`Language` 已存在，实际无强依赖，可并行；同 PR）。

### RFC-157-T3 — 前端下拉 + i18n + 测试
- `routes/settings.tsx`：`SYSTEM_AGENT_CONFIG_KEYS` 加 `'commitPushLang'`；提交卡加 `<Field>`+`<Select>`
  （Default `onChange` 发 `null`）；**记忆卡 `memoryDistillLang` 的 `onChange` 一并从 `undefined` 改 `null`**（P2-1 随行修）。
- `i18n/en-US.ts` + `i18n/zh-CN.ts`（含 zh-CN 类型声明块）：五个 `settings.commitPushLang*` key。
- 新 `tests/settings-commit-push-lang.test.tsx`（镜像 settings-memory-distill-lang；Default 严格断言 body `=== null`）。
- 更新 `tests/settings-system-agents.test.ts` slice-key 锁（+`commitPushLang`、9→10）；
  **收紧 `settings-memory-distill-lang.test.tsx` 的 Default case 为断言 `=== null`**；
  `settings-commit-push.test.ts` 视需要补断言。
- 依赖：T1（`Config['commitPushLang']` 类型 + patch nullable）。

### RFC-157-T4 — 门禁 + 视觉基线
- `bun run typecheck && bun run lint && bun run test && bun run format:check` + 前端 vitest + binary smoke。
- settings.png 视觉基线（若像素差触发）：darwin `--update-snapshots=all` 强刷，linux 走 dispatch。
- 依赖：T1–T3。

## 验收清单（对应 proposal §验收标准）

- [ ] `commitPushLang` schema 正/边界/错误路径 + patch nullable / base 拒 null 测试绿（#1）
- [ ] 选 Default 发 `null` 真正清除已存值（commit + memory 两下拉框）；测试严格断言 body `=== null`（#1/#5）
- [ ] en-US（含未设）prompt 与显式 en-US 逐字节一致、末尾英文指令；zh-CN 末尾中文指令（#2）
- [ ] 指令在两段 prompt 最末；两版都声明 `<type>(scope):` 保 ASCII（#2/#3）
- [ ] 透传链锁：config→launchRuntimeConfig→toRunTaskOptions→scheduler；初始+修复同语言（#4）
- [ ] 系统 Agent 页签提交卡下拉渲染/保存/Default 三态测试绿；与记忆卡视觉一致（#5）
- [ ] i18n 五 key 双语可达（#6）
- [ ] 门禁三连 + 前端 vitest + binary smoke + CI 双 OS + e2e 绿（#7）

## 门禁流程（按 CLAUDE.md + 记忆）

1. 写完 RFC 三件套 → **Codex 设计门**复核（feedback_codex_review_after_changes：批准前主动跑）→ 修 findings。
2. `ExitPlanMode` / 显式询问得用户批准 → 才进实现。
3. 实现 + 测试 → **Codex 实现门**复核 → 修 findings。
4. 推前 `typecheck`（非仅 lint+test）→ push main → 立即查 CI（feedback_post_commit_ci_check）。
5. STATE.md：落档时顶部加「进行中 RFC」行；完工改 Done + 已完成表加行；design/plan.md RFC 索引登记。
