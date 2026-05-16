# RFC-019 Skill ZIP 批量导入 — 实施计划

> 单 PR；commit 前缀 `feat(skills): RFC-019 ZIP 批量导入`。

## 子任务

| # | 任务 | 主要文件 | 依赖 |
|---|------|----------|------|
| RFC-019-T1 | shared zod schema + 类型 | `packages/shared/src/schemas/skill.ts`、`packages/shared/src/skill-zip.ts` 类型 stub | — |
| RFC-019-T2 | shared `parseSkillZipEntries` 纯函数 + 单测 | `packages/shared/src/skill-zip.ts`、`tests/skill-zip.test.ts` | T1 |
| RFC-019-T3 | shared `parseSkillMarkdown` 纯函数（frontmatter 解析）+ 单测 | `packages/shared/src/skill-md.ts`、`tests/skill-md.test.ts` | T1 |
| RFC-019-T4 | 加 `fflate` 依赖（落 `packages/shared/package.json`）+ bun install | `packages/shared/package.json`、`bun.lockb` | — |
| RFC-019-T5 | backend `decodeZip` + 安全限额 + 单测 | `packages/backend/src/services/skill-zip.ts`、`tests/skill-zip-decode.test.ts` | T2,T4 |
| RFC-019-T6 | backend commit 业务（落盘 + DB upsert + 决策三态）+ 单测 | `packages/backend/src/services/skill-zip.ts`、`tests/skill-zip-commit.test.ts` | T5 |
| RFC-019-T7 | HTTP 端点 parse / commit + multipart 解析 + 单测 | `packages/backend/src/routes/skills.ts`、`tests/skills-import-zip-http.test.ts` | T6 |
| RFC-019-T8 | 前端 `ImportZipDialog` 组件 + `/skills/new` Upload ZIP tab + i18n + CSS | `packages/frontend/src/routes/skills.new.tsx`、`packages/frontend/src/components/skills/ImportZipDialog.tsx`、`i18n/{en-US,zh-CN}.ts`、`styles.css` | T7 |
| RFC-019-T9 | 前端集成 + 源代码层兜底 + 测试 | `packages/frontend/tests/skills-import-zip-*.test.tsx` | T8 |
| RFC-019-T10 | 文档收尾：plan.md 索引改 Done + STATE.md 追加完成行 | `design/plan.md`、`STATE.md` | T1-T9 |

## PR 拆分

默认单 PR（按 RFC workflow 默认）。文件总量预计 ~15 文件、~1500-2000 行（含测试）。如最终 diff 超过 3000 行，再考虑按 backend / frontend 切两 PR。

## 验收清单

- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] shared `parseSkillZipEntries` 测试全 14 case 绿
- [ ] backend decodeZip 限额 / 安全 / happy 共 ≥10 case 绿
- [ ] backend commit overwrite / rename / skip / external 拒绝 / 部分失败 共 ≥10 case 绿
- [ ] HTTP parse/commit ≥6 case 绿
- [ ] 前端 ImportZipDialog ≥10 case 绿（含源码层兜底）
- [ ] runner.ts / runtime.ts / scheduler.ts / validator.ts / migration `git diff` 为空
- [ ] 浏览器实测：拿一份本地 zip（含 2 个 skill）走完 parse → 决策 → commit → /skills 列表看到新 skill 全流程
- [ ] CI 推送后 `gh run watch` 全绿（Lint+Typecheck+Test 双平台 + Build single-binary smoke 双平台 + Playwright e2e 双平台），按 [feedback_post_commit_ci_check] 检查

## 风险 / 待确认

- **fflate 依赖**：在 shared 落，意味着前端 bundle 也会引入；fflate ~15KB gzip，可接受。如担心，可挪到 backend-only（shared 只保留类型，把纯函数移到 backend），代价是 shared 单测要 mock entries。第一版采用 shared 直入。
- **multipart 大小**：上限取 64 MiB；如未来需要更大，挪到 settings 配置。
- **rename 后的 SKILL.md `name` 字段**：我们重写 frontmatter，统一以最终 dirname 为 name 字段。原 zip 内 SKILL.md 的 name 字段不保留（会被 dirname 覆盖），warning 一条解释。
- **跨平台行为**：`mkdirSync(recursive:true)` / `rmSync(recursive:true)` 在 macOS/Linux 行为一致；CI 已覆盖双平台。
