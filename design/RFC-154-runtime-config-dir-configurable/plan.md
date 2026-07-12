# RFC-154 — 任务分解

单 PR（改动聚焦、无跨阶段状态机）。commit 前缀:`feat(runtime): RFC-154 config 目录注入可配置化`。

## 依赖 / 前置
- 实现前 `git pull`,确认 RFC-153（删 `builtin`）落地状态 → 定本 RFC 迁移号（预期 `0079`）与 schema.ts 合并方式（§design 7）。
- 不删 RFC-153 / 他人在 `schema.ts`、`_journal.json`、`createRuntime` 里的改动（[[feedback_dont_delete_others_code_for_ci]]）。

## 子任务

### RFC-154-T1 — schema + 迁移 + 校验 + 解析单源 + 冻结路径
- `schema.ts`:`runtimes` 加 `config_dir_env` / `config_dir_name` 两可空列（基于 RFC-153 已删 `builtin` 的工作树现状增量改）。
- migration `0079`（实现前 pull 复核空号）:两条 `ADD COLUMN`,`--> statement-breakpoint` 分隔;journal 计数锁 +1。
- shared:`RuntimeConfigDirProfile` + `DEFAULT_CONFIG_DIR_PROFILE`（协议默认单源）+ `RESERVED_SPAWN_ENV`。
- `runtimeRegistry.ts`:`validateConfigDirName`（拒 `/`\`.`..`NUL）/ `validateConfigDirEnv`（非法名 + 保留 key 双拒）;`resolveAgentRuntime` 的 `ResolvedRuntime` 返回 `configDir` profile（NULL→默认）。
- **冻结路径（Codex P1）**:`FrozenRuntime` 加 `configDir` 兄弟字段;`resolveFrozenRuntime` 写入折进 `runtime_params_json` 命名键（`__configDir`）、读回解出（legacy NULL→协议默认）;`frozenRuntimeOfSession` + `inheritFrom` 继承同带;**configDir 不进 per-agent `RuntimeProfile`**（§2.1）。
- `createRuntime` / `updateRuntime`:读写两列 + 调校验;**`RuntimeRow`/`RuntimeView`/`runtimeRowToView` + routes `CreateBody`/`UpdateBody` Zod schema 同步暴露两字段**（否则前端编辑弹窗无法回填）。
- 测试:两校验纯函数正/边界/错误（含保留 key、`.`）+ 默认解析预言 + **冻结存活**（冻结后编辑→resume 用旧值 / legacy 读回默认）。

### RFC-154-T2 — 业务 spawn 参数化 + skill 注入统一（修冗余）
> 仅业务 spawn（`buildBusinessSpawn`）。系统 agent `buildSpawn` / smoke / probe **不动**（§2.3，保 golden）。
- opencode 业务:`opencode/driver.ts:176` 叶子参数化;`opencode/spawn.ts` env key 参数化（`OpencodeEnvContext.configDirEnv`）。
- claude 业务:`claudeCode/spawn.ts:74,118` 叶子 + env key 参数化;`claudeCode/driver.ts:65` captureSessions 叶子;`sessionCapture.ts` 主候选跟随、homedir 兜底不变。
- shared `stageSkills(configDir, skills, log)` helper（叶子模块，无 runner 依赖）:**空列表也 `mkdir <configDir>/skills`**（Codex P2）;runner `prepareSkills` + `claudeCode/config.ts` skill 循环委托它。
- **删** runner 序章无条件 `prepareSkills(.opencode)`;opencode driver 在自己 spawn 路径用解析出的 config 目录注入。
- 线程 `configDir`:冻结 `FrozenRuntime.configDir` → **scheduler 5 站点**（`:1099/:1902/:2890/:4407/:4783` 随 `runtimeParams` 同传）→ `RunNodeOptions.runtimeConfigDir?`（optional 缺省协议默认,既有测试零改动）→ `BusinessNodeSpawnContext.configDir`（**不动** `SystemAgentSpawnContext`）。
- 测试:opencode/claude **业务** spawn golden（默认字节等价 + 自定义值断言 + 不含默认 env）;**系统 agent/smoke golden 零改动为证**;skill 落点;**claude run 无 `.opencode` 回归锁**;**空 skills 仍建目录锁**。

### RFC-154-T3 — 前端 runtime 表单
- runtime 新建/编辑 Dialog 加两个 `<Field>`+`<TextInput>`（复用公共原语，placeholder 随 protocol 显默认值，hint 说明留空=默认）。
- i18n en/zh 各 4 key。
- 空提交→null;非法→表单挡。
- 测试:vitest 渲染 + 提交路径（`getByRole`/label）。
- 深浅主题视觉自查（[[feedback_frontend_visual_verify_repro]]）。

### RFC-154-T4 — 收口
- 源码守卫:config 目录字面量收敛到单源 + sessionCapture 兜底白名单锁。
- 文档:`design/plan.md` RFC 索引 Done、`STATE.md` 收尾。
- 门禁:`typecheck && lint && test && format:check` + binary smoke 全绿;push 后查 CI（[[feedback_post_commit_ci_check]]）。
- Codex 实现门:code 改完、声明 done 前跑一次,修 findings（[[feedback_codex_review_after_changes]]）。

## 验收清单（对应 proposal §验收）
- [ ] 迁移 apply + journal 锁 +1
- [ ] 前端两字段（公共原语）+ 深浅主题自查
- [ ] 默认（两列 NULL）业务 spawn 字节等价 golden + 系统 agent/smoke golden 零改动
- [ ] 自定义值:env 名替换（不含默认 env）+ skill 落点正确
- [ ] claude run 无 `.opencode` 冗余（回归锁）+ 空 skills 仍建目录锁
- [ ] 两校验纯函数正/边界/错误全覆盖（含保留 key、`.`）
- [ ] 冻结存活:冻结后编辑 runtime → resume/retry 用旧值
- [ ] typecheck+lint+test+format + binary smoke + CI 全绿
- [ ] Codex 设计门（批准前）+ 实现门（done 前）各一轮，findings 已折
